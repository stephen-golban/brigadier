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
import {
  collectBoundedText,
  type DetachedProcess,
  spawnDetachedProcess,
  waitForProcessExit,
} from "../shared/process.ts";
import { AsyncQueue } from "./async-queue.ts";
import { type ShutdownProcess, WorkerLifecycle } from "./lifecycle.ts";
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
  workerEnvironment,
  writePromptAndClose,
} from "./shared.ts";

export class CodexWorker implements Worker<"codex"> {
  readonly vendor = "codex" as const;
  readonly processCompletion = "self-exits" as const;

  constructor(private readonly shutdown?: ShutdownProcess) {}

  async spawn(spec: CodexWorkerSpec): Promise<SpawnedWorker> {
    createIdleTimeoutMs(spec.idleTimeoutMs);
    const startedAtMs = performance.now();
    const events = new AsyncQueue<WorkerEvent>();
    let processHandle: DetachedProcess;

    try {
      const command = buildCodexCommand(spec);
      processHandle = await spawnDetachedProcess(
        command[0] ?? "codex",
        command.slice(1),
        {
          cwd: spec.cwd,
          env: workerEnvironment(spec),
        },
      );
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

    let output = "";
    let usage: TokenUsage = EMPTY_USAGE;
    let terminalFailure: WorkerFailure | null = null;
    let streamFailure: WorkerFailure | null = null;
    const unexpectedFailureOutcome = (error: unknown): LaunchedWorkerOutcome =>
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
      );
    const lifecycle = new WorkerLifecycle({
      processHandle,
      idleTimeoutMs: spec.idleTimeoutMs,
      timeoutMs: spec.timeoutMs,
      cancellationOutcome: (reason) =>
        failureOutcome(
          cancellationFailure(reason),
          startedAtMs,
          processHandle,
          output,
          usage,
        ),
      unexpectedFailureOutcome,
      ...(this.shutdown === undefined ? {} : { shutdown: this.shutdown }),
    });

    const stderr = collectBoundedText(processHandle.stderr, 64 * 1_024).catch(
      () => "",
    );
    const reader = (async (): Promise<void> => {
      try {
        for await (const raw of readNdjson(processHandle.stdout, {
          onActivity: lifecycle.resetIdleTimer,
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
        await lifecycle.finish(unexpectedFailureOutcome(error));
      }
    })();

    void (async () => {
      try {
        await writePromptAndClose(processHandle.stdin, spec.prompt);
      } catch (error) {
        await lifecycle.finish(unexpectedFailureOutcome(error));
      }
    })();

    void (async () => {
      const exited = await waitForProcessExit(processHandle);
      await lifecycle.finishWith(async () => {
        await reader;
        const stderrText = await stderr;
        const common = {
          output,
          usage,
          durationMs: elapsedMs(startedAtMs),
          exitCode: processHandle.exitCode ?? exited.exitCode,
          signal: processHandle.signalCode ?? exited.signal,
        };
        const detectedFailure =
          streamFailure ??
          terminalFailure ??
          (exited.exitCode === 0
            ? null
            : exitFailure("codex", exited.exitCode, stderrText));
        if (detectedFailure === null) {
          return successfulOutcome(common);
        }
        return {
          ok: false,
          ...common,
          failure: detectedFailure as WorkerFailure & {
            readonly kind: Exclude<WorkerFailure["kind"], "LAUNCH_FAILURE">;
          },
        };
      });
    })();

    return {
      pid: processHandle.pid,
      events,
      completion: lifecycle.completion,
      cancel: (reason) => lifecycle.cancel(reason),
    };
  }
}

export const codexWorker: Worker<"codex"> = new CodexWorker();

/**
 * Codex 0.145.0 can suppress project `AGENTS.md` through
 * `project_doc_max_bytes=0`. Its `--ignore-user-config` flag suppresses only
 * `$CODEX_HOME/config.toml`; global `$CODEX_HOME/AGENTS.md` remains ambient.
 */
export function buildCodexCommand(spec: CodexWorkerSpec): string[] {
  validateMaxTurns(spec.maxTurns);
  const laneProfile = codexLaneProfile(spec);
  const command = [
    "codex",
    "exec",
    "--json",
    "--model",
    spec.model,
    "-c",
    `model_reasoning_effort=${spec.effort}`,
    "-c",
    'default_permissions="brigadier_lane"',
    "-c",
    `permissions.brigadier_lane=${laneProfile}`,
  ];
  if (spec.instructionFiles.user === "exclude") {
    command.push("--ignore-user-config");
  }
  if (spec.instructionFiles.project === "exclude") {
    command.push("-c", "project_doc_max_bytes=0");
  }
  // The explicit stdin sentinel prevents piped input from being appended to a
  // separate positional prompt as a synthetic <stdin> block.
  command.push("-");
  return command;
}

function codexLaneProfile(spec: CodexWorkerSpec): string {
  const permissions: string[] = ['"."="read"'];
  if (spec.sandbox.filesystem.workspaceAccess === "edit") {
    for (const path of new Set(spec.sandbox.filesystem.editablePaths)) {
      permissions.push(`${JSON.stringify(path)}="write"`);
    }
  }
  return `{filesystem={":root"="read",":workspace_roots"={${permissions.join(",")}}},network={enabled=false}}`;
}

function validateMaxTurns(maxTurns: number | null): void {
  if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new RangeError("maxTurns must be null or a positive whole number");
  }
  // `codex exec` is one-shot and therefore cannot exceed any positive cap.
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
