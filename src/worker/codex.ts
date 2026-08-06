import {
  type CodexWorkerSpec,
  createIdleTimeoutMs,
  type LaunchedWorkerOutcome,
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
  parseEmbeddedError,
  stringValue,
  successfulOutcome,
  terminateProcessGroup,
  workerEnvironment,
  writePromptAndClose,
} from "./shared.ts";

export class CodexWorker implements Worker<"codex"> {
  readonly vendor = "codex" as const;
  readonly processCompletion = "self-exits" as const;

  async spawn(spec: CodexWorkerSpec): Promise<SpawnedWorker> {
    createIdleTimeoutMs(spec.idleTimeoutMs);
    const startedAtMs = performance.now();
    const events = new AsyncQueue<WorkerEvent>();
    let processHandle: Bun.Subprocess<"pipe", "pipe", "pipe">;

    try {
      processHandle = Bun.spawn(buildCodexCommand(spec), {
        cwd: spec.cwd,
        detached: true,
        env: workerEnvironment(spec),
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
    let output = "";
    let usage: TokenUsage = EMPTY_USAGE;
    let terminalFailure: WorkerFailure | null = null;
    let streamFailure: WorkerFailure | null = null;
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
        failureOutcome(
          cancellationFailure(reason),
          startedAtMs,
          processHandle,
          output,
          usage,
        ),
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
          events.push(mapCodexEvent(raw));
          if (!isObject(raw)) {
            continue;
          }
          if (
            raw.type === "item.completed" &&
            isObject(raw.item) &&
            raw.item.type === "agent_message" &&
            typeof raw.item.text === "string"
          ) {
            output =
              output.length === 0
                ? raw.item.text
                : `${output}\n${raw.item.text}`;
          } else if (raw.type === "turn.completed") {
            usage = codexUsage(raw.usage);
          } else if (raw.type === "turn.failed") {
            terminalFailure = classifyCodexEventFailure(raw);
          }
        }
        events.close();
      } catch (error) {
        events.fail(error);
        streamFailure = failure(
          "UNKNOWN_FAILURE",
          error instanceof Error ? error.message : String(error),
          false,
          null,
        );
        terminateProcessGroup(processHandle);
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
              output,
              usage,
            ),
          );
        }
      }
    })();

    void (async () => {
      const exitCode = await processHandle.exited;
      await reader;
      const stderrText = await stderr;
      if (settled) {
        return;
      }
      const common = {
        output,
        usage,
        durationMs: elapsedMs(startedAtMs),
        exitCode: processHandle.exitCode ?? exitCode,
        signal: processHandle.signalCode,
      };
      const detectedFailure =
        streamFailure ??
        terminalFailure ??
        (exitCode === 0 ? null : exitFailure("codex", exitCode, stderrText));
      if (detectedFailure === null) {
        settle(successfulOutcome(common));
      } else {
        settle({
          ok: false,
          ...common,
          failure: detectedFailure as WorkerFailure & {
            readonly kind: Exclude<WorkerFailure["kind"], "LAUNCH_FAILURE">;
          },
        });
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

export const codexWorker: Worker<"codex"> = new CodexWorker();

export function buildCodexCommand(spec: CodexWorkerSpec): string[] {
  const command = [
    "codex",
    "exec",
    "--json",
    "--model",
    spec.model,
    "-c",
    `model_reasoning_effort=${spec.effort}`,
    "--sandbox",
    spec.sandbox.filesystem.workspaceAccess === "edit"
      ? "workspace-write"
      : "read-only",
  ];
  if (spec.sandbox.filesystem.workspaceAccess === "edit") {
    command.push("-c", "sandbox_workspace_write.network_access=false");
  }
  if (spec.instructionFiles.project === "exclude") {
    command.push("-c", "project_doc_max_bytes=0");
  }
  // The explicit stdin sentinel prevents piped input from being appended to a
  // separate positional prompt as a synthetic <stdin> block.
  command.push("-");
  return command;
}

function mapCodexEvent(raw: unknown): WorkerEvent {
  if (!isObject(raw)) {
    return { type: "other", description: describeRaw(raw), raw };
  }
  if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
    return { type: "started", sessionId: raw.thread_id, raw };
  }
  if (raw.type === "error" && typeof raw.message === "string") {
    return { type: "notice", level: "error", message: raw.message, raw };
  }
  if (typeof raw.type === "string" && raw.type.startsWith("item.")) {
    const phase =
      raw.type === "item.started"
        ? "started"
        : raw.type === "item.completed"
          ? "completed"
          : "updated";
    if (isObject(raw.item)) {
      if (
        raw.item.type === "agent_message" &&
        phase === "completed" &&
        typeof raw.item.text === "string"
      ) {
        return { type: "message", text: raw.item.text, raw };
      }
      if (raw.item.type === "file_change") {
        return {
          type: "file_change",
          changes: codexFileChanges(raw.item),
          raw,
        };
      }
      if (typeof raw.item.type === "string") {
        return {
          type: "tool",
          id: stringValue(raw.item.id),
          name: raw.item.type,
          phase,
          input: raw.item.command ?? raw.item.input ?? null,
          output: raw.item.aggregated_output ?? raw.item.output ?? null,
          raw,
        };
      }
    }
  }
  return { type: "other", description: describeRaw(raw), raw };
}

function codexFileChanges(item: Record<string, unknown>): Array<{
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted" | "unknown";
}> {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.flatMap((change) => {
    if (!isObject(change) || typeof change.path !== "string") {
      return [];
    }
    const kind =
      change.kind === "created" ||
      change.kind === "modified" ||
      change.kind === "deleted"
        ? change.kind
        : "unknown";
    return [{ path: change.path, kind }];
  });
}

function codexUsage(raw: unknown): TokenUsage {
  const usage = isObject(raw) ? raw : {};
  const total = numberValue(usage.input_tokens) ?? 0;
  const cacheRead = numberValue(usage.cached_input_tokens) ?? 0;
  const cacheWrite = numberValue(usage.cache_write_input_tokens) ?? 0;
  const reasoning =
    usage.reasoning_output_tokens === undefined
      ? null
      : (numberValue(usage.reasoning_output_tokens) ?? null);
  return {
    input: {
      total,
      uncached: Math.max(0, total - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
    },
    output: {
      total: numberValue(usage.output_tokens) ?? 0,
      reasoning,
    },
  };
}

function classifyCodexEventFailure(
  raw: Record<string, unknown>,
): WorkerFailure & {
  readonly kind: Exclude<WorkerFailure["kind"], "LAUNCH_FAILURE">;
} {
  const error = isObject(raw.error) ? raw.error : {};
  const originalMessage = stringValue(error.message) ?? "Codex turn failed";
  const embedded = parseEmbeddedError(originalMessage);
  const statusCode = integerValue(embedded?.status);
  const detail = isObject(embedded?.error)
    ? stringValue(embedded.error.message)
    : null;
  return classifyHttpFailure(statusCode, detail ?? originalMessage);
}
