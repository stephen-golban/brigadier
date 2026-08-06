import {
  type ApiRetryError,
  type ClaudeWorkerSpec,
  createIdleTimeoutMs,
  type LaunchedWorkerOutcome,
  type QuotaSnapshot,
  type SpawnedWorker,
  type TokenUsage,
  type Worker,
  type WorkerEvent,
  type WorkerFailure,
} from "../contracts.ts";
import { readNdjson } from "../shared/ndjson.ts";
import { AsyncQueue } from "./async-queue.ts";
import {
  cancellationFailure,
  classifyHttpFailure,
  describeRaw,
  EMPTY_USAGE,
  elapsedMs,
  exitFailure,
  failure,
  failureOutcome,
  integerValue,
  isObject,
  numberValue,
  stringValue,
  successfulOutcome,
  terminateProcessGroup,
  workerEnvironment,
  writePromptAndClose,
} from "./shared.ts";

const API_RETRY_ERRORS = new Set<ApiRetryError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);

export class ClaudeWorker implements Worker<"claude"> {
  readonly vendor = "claude" as const;
  readonly processCompletion = "signals-then-must-be-killed" as const;

  async spawn(spec: ClaudeWorkerSpec): Promise<SpawnedWorker> {
    createIdleTimeoutMs(spec.idleTimeoutMs);
    const startedAtMs = performance.now();
    const events = new AsyncQueue<WorkerEvent>();
    let processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">;

    try {
      processHandle = Bun.spawn(buildClaudeCommand(spec), {
        cwd: spec.cwd,
        detached: true,
        env: {
          ...workerEnvironment(spec),
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      events.close();
      const message = error instanceof Error ? error.message : String(error);
      return {
        pid: null,
        events,
        completion: Promise.resolve({
          ok: false,
          output: "",
          usage: EMPTY_USAGE,
          durationMs: elapsedMs(startedAtMs),
          exitCode: null,
          signal: null,
          failure: {
            kind: "LAUNCH_FAILURE",
            message,
            retryable: false,
            statusCode: null,
          },
        }),
        cancel: async () => {},
      };
    }

    const completion = Promise.withResolvers<LaunchedWorkerOutcome>();
    let settled = false;
    let rejectedByQuota = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      clearTimeout(idleTimer);
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer);
      }
    };
    const settle = (outcome: LaunchedWorkerOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      completion.resolve(outcome);
    };
    const cancel = async (
      reason: Parameters<SpawnedWorker["cancel"]>[0],
    ): Promise<void> => {
      if (settled) {
        return;
      }
      terminateProcessGroup(processHandle);
      settle(
        failureOutcome(cancellationFailure(reason), startedAtMs, processHandle),
      );
    };
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void cancel({
          kind: "timeout",
          message: `worker produced no output for ${spec.idleTimeoutMs} ms`,
        });
      }, spec.idleTimeoutMs);
      idleTimer.unref();
    };

    idleTimer = setTimeout(() => {}, spec.idleTimeoutMs);
    resetIdleTimer();
    if (spec.timeoutMs !== null) {
      totalTimer = setTimeout(() => {
        void cancel({
          kind: "timeout",
          message: `worker exceeded ${spec.timeoutMs} ms`,
        });
      }, spec.timeoutMs);
      totalTimer.unref();
    }

    const stderr = new Response(processHandle.stderr).text();
    const reader = (async (): Promise<void> => {
      try {
        for await (const raw of readNdjson(processHandle.stdout, {
          onActivity: resetIdleTimer,
        })) {
          const mapped = mapClaudeEvent(raw);
          for (const event of mapped) {
            events.push(event);
          }
          if (isQuotaRejection(raw)) {
            rejectedByQuota = true;
          }
          if (isClaudeResult(raw)) {
            // Claude's result record is the completion signal. Kill the session
            // immediately; waiting for process exit deadlocks on real one-shot runs.
            terminateProcessGroup(processHandle);
            settle(
              claudeOutcome(raw, rejectedByQuota, startedAtMs, processHandle),
            );
          }
        }
        events.close();
      } catch (error) {
        events.fail(error);
        if (!settled) {
          terminateProcessGroup(processHandle);
          settle(
            failureOutcome(
              failure(
                "UNKNOWN_FAILURE",
                error instanceof Error ? error.message : String(error),
                false,
                null,
              ),
              startedAtMs,
              processHandle,
            ),
          );
        }
      }
    })();

    void (async () => {
      try {
        await writePromptAndClose(processHandle.stdin, spec.prompt);
      } catch (error) {
        if (!settled) {
          terminateProcessGroup(processHandle);
          settle(
            failureOutcome(
              failure(
                "UNKNOWN_FAILURE",
                error instanceof Error ? error.message : String(error),
                false,
                null,
              ),
              startedAtMs,
              processHandle,
            ),
          );
        }
      }
    })();

    void (async () => {
      const exitCode = await processHandle.exited;
      await reader;
      if (!settled) {
        settle(
          failureOutcome(
            exitFailure("claude", exitCode, await stderr),
            startedAtMs,
            processHandle,
          ),
        );
      }
    })();

    return {
      pid: processHandle.pid,
      events,
      completion: completion.promise,
      cancel,
    };
  }
}

export const claudeWorker: Worker<"claude"> = new ClaudeWorker();

export function buildClaudeCommand(spec: ClaudeWorkerSpec): string[] {
  const command = [
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    spec.model,
    "--effort",
    spec.effort,
    "--exclude-dynamic-system-prompt-sections",
    "--permission-mode",
    "dontAsk",
  ];

  if (spec.maxBudgetUsd !== null) {
    command.push("--max-budget-usd", String(spec.maxBudgetUsd));
  }

  command.push("--tools", spec.tools.join(","));
  const editRules = spec.sandbox.filesystem.editablePaths.map(
    (path) => `Edit(${path})`,
  );
  if (editRules.length > 0) {
    command.push("--allowedTools", editRules.join(","));
  }
  command.push("--disallowedTools", "Write,WebFetch,WebSearch");

  const settingSources: string[] = [];
  if (spec.instructionFiles.user === "include") {
    settingSources.push("user");
  }
  if (spec.instructionFiles.project === "include") {
    settingSources.push("project", "local");
  }
  command.push("--setting-sources", settingSources.join(","));

  if (spec.extraDirectories.length > 0) {
    command.push("--add-dir", ...spec.extraDirectories);
  }
  if (spec.mcp.configFiles.length > 0) {
    command.push("--mcp-config", ...spec.mcp.configFiles);
  }
  command.push("--strict-mcp-config");
  return command;
}

function mapClaudeEvent(raw: unknown): WorkerEvent[] {
  if (!isObject(raw)) {
    return [{ type: "other", description: describeRaw(raw), raw }];
  }

  if (
    raw.type === "system" &&
    raw.subtype === "init" &&
    typeof raw.session_id === "string"
  ) {
    return [{ type: "started", sessionId: raw.session_id, raw }];
  }
  if (raw.type === "system" && raw.subtype === "api_retry") {
    const candidateError = stringValue(raw.error);
    const error =
      candidateError !== null &&
      API_RETRY_ERRORS.has(candidateError as ApiRetryError)
        ? (candidateError as ApiRetryError)
        : "unknown";
    return [
      {
        type: "api_retry",
        attempt: integerValue(raw.attempt) ?? 0,
        maxRetries: integerValue(raw.max_retries) ?? 0,
        retryDelayMs: numberValue(raw.retry_delay_ms) ?? 0,
        statusCode: integerValue(raw.error_status),
        error,
        raw,
      },
    ];
  }
  if (raw.type === "rate_limit_event") {
    return [{ type: "quota", snapshot: claudeQuota(raw), raw }];
  }
  if (raw.type === "assistant" && isObject(raw.message)) {
    const events: WorkerEvent[] = [];
    const content = raw.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block)) {
          continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
          events.push({ type: "message", text: block.text, raw });
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string"
        ) {
          events.push({
            type: "tool",
            id: stringValue(block.id),
            name: block.name,
            phase: "started",
            input: block.input ?? null,
            output: null,
            raw,
          });
        }
      }
    }
    if (events.length > 0) {
      return events;
    }
  }
  if (raw.type === "user" && isObject(raw.message)) {
    const content = raw.message.content;
    if (Array.isArray(content)) {
      const result = content.find(
        (block) => isObject(block) && block.type === "tool_result",
      );
      if (isObject(result)) {
        return [
          {
            type: "tool",
            id: stringValue(result.tool_use_id),
            name: "tool_result",
            phase: "completed",
            input: null,
            output: result.content ?? null,
            raw,
          },
        ];
      }
    }
  }
  return [{ type: "other", description: describeRaw(raw), raw }];
}

function isClaudeResult(raw: unknown): raw is Record<string, unknown> & {
  readonly type: "result";
} {
  return isObject(raw) && raw.type === "result";
}

function isQuotaRejection(raw: unknown): boolean {
  return (
    isObject(raw) &&
    raw.type === "rate_limit_event" &&
    isObject(raw.rate_limit_info) &&
    raw.rate_limit_info.status === "rejected"
  );
}

function claudeQuota(raw: Record<string, unknown>): QuotaSnapshot {
  const info = isObject(raw.rate_limit_info) ? raw.rate_limit_info : {};
  const vendorStatus = stringValue(info.status);
  const resetsAt = numberValue(info.resetsAt);
  const rateLimitType = stringValue(info.rateLimitType);
  return {
    vendor: "claude",
    status:
      vendorStatus === "rejected"
        ? "exhausted"
        : vendorStatus === "allowed_warning"
          ? "warning"
          : vendorStatus === "allowed"
            ? "available"
            : "unknown",
    observedAtMs: Date.now(),
    windows: [
      {
        kind:
          rateLimitType === "five_hour"
            ? "rolling"
            : rateLimitType === "seven_day"
              ? "weekly"
              : "unknown",
        durationMinutes:
          rateLimitType === "five_hour"
            ? 300
            : rateLimitType === "seven_day"
              ? 10_080
              : null,
        remainingFraction: null,
        resetsAtMs: resetsAt === null ? null : resetsAt * 1_000,
      },
    ],
    isUsingOverage:
      typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
  };
}

function claudeOutcome(
  raw: Record<string, unknown>,
  rejectedByQuota: boolean,
  startedAtMs: number,
  processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">,
): LaunchedWorkerOutcome {
  const output = stringValue(raw.result) ?? "";
  const usage = claudeUsage(raw);
  const durationMs = numberValue(raw.duration_ms) ?? elapsedMs(startedAtMs);
  const costUsd = numberValue(raw.total_cost_usd);
  const common = {
    output,
    usage,
    durationMs,
    exitCode: processHandle.exitCode,
    signal: processHandle.signalCode,
    ...(costUsd === null ? {} : { costUsd }),
  };
  if (raw.is_error === false) {
    return successfulOutcome(common);
  }
  return {
    ok: false,
    ...common,
    failure: classifyClaudeFailure(raw, rejectedByQuota, output),
  };
}

function classifyClaudeFailure(
  raw: Record<string, unknown>,
  rejectedByQuota: boolean,
  message: string,
): WorkerFailure & {
  readonly kind: Exclude<WorkerFailure["kind"], "LAUNCH_FAILURE">;
} {
  const terminalReason = stringValue(raw.terminal_reason);
  const statusCode = integerValue(raw.api_error_status);
  const detail = message || terminalReason || "Claude worker failed";
  if (terminalReason === "max_budget_usd") {
    return failure("BUDGET_EXCEEDED", detail, false, statusCode);
  }
  if (terminalReason === "max_turns") {
    return failure("TURN_LIMIT", detail, false, statusCode);
  }
  if (terminalReason === "rate_limit" && rejectedByQuota) {
    return failure("QUOTA_EXHAUSTED", detail, false, statusCode);
  }
  if (terminalReason === "permission_denied") {
    return failure("PERMISSION_DENIED", detail, false, statusCode);
  }
  if (terminalReason === "refused") {
    return failure("REFUSED", detail, false, statusCode);
  }
  if (terminalReason === "schema_validation_failed") {
    return failure("SCHEMA_FAILURE", detail, false, statusCode);
  }
  if (terminalReason === "cancelled") {
    return failure("CANCELLED", detail, false, statusCode);
  }
  return classifyHttpFailure(statusCode, detail);
}

function claudeUsage(raw: Record<string, unknown>): TokenUsage {
  const modelUsage = raw.modelUsage;
  if (isObject(modelUsage) && Object.keys(modelUsage).length > 0) {
    let uncached = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    for (const value of Object.values(modelUsage)) {
      if (!isObject(value)) {
        continue;
      }
      uncached += numberValue(value.inputTokens) ?? 0;
      cacheRead += numberValue(value.cacheReadInputTokens) ?? 0;
      cacheWrite += numberValue(value.cacheCreationInputTokens) ?? 0;
      output += numberValue(value.outputTokens) ?? 0;
    }
    return {
      input: {
        total: uncached + cacheRead + cacheWrite,
        uncached,
        cacheRead,
        cacheWrite,
      },
      output: { total: output, reasoning: null },
    };
  }

  const usage = isObject(raw.usage) ? raw.usage : {};
  const uncached = numberValue(usage.input_tokens) ?? 0;
  const cacheRead = numberValue(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = numberValue(usage.cache_creation_input_tokens) ?? 0;
  return {
    input: {
      total: uncached + cacheRead + cacheWrite,
      uncached,
      cacheRead,
      cacheWrite,
    },
    output: {
      total: numberValue(usage.output_tokens) ?? 0,
      reasoning: null,
    },
  };
}
