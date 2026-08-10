import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_KILL_MS = 250;
const PROCESS_POLL_MS = 10;

export type DetachedProcess = ChildProcessWithoutNullStreams & {
  readonly pid: number;
};

interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export async function spawnDetachedProcess(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptionsWithoutStdio, "detached" | "stdio"> = {},
): Promise<DetachedProcess> {
  const processHandle = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      processHandle.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      processHandle.off("spawn", onSpawn);
      reject(error);
    };
    processHandle.once("spawn", onSpawn);
    processHandle.once("error", onError);
  });

  if (processHandle.pid === undefined) {
    throw new Error(`spawned process ${command} has no pid`);
  }
  return processHandle as DetachedProcess;
}

export function waitForProcessExit(
  processHandle: DetachedProcess,
): Promise<ProcessExit> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({
      exitCode: processHandle.exitCode,
      signal: processHandle.signalCode,
    });
  }
  return new Promise((resolve) => {
    processHandle.once("exit", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

/**
 * Terminates the entire detached process group within a fixed deadline.
 * Waiting on group existence, rather than only the direct child, ensures an
 * ignored SIGTERM in a grandchild that remains in the group still reaches the
 * SIGKILL rung. A descendant that creates its own process group or session has
 * escaped this group and cannot be reached by `kill(-pid)`.
 */
export async function shutdownProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, SHUTDOWN_GRACE_MS)) {
    return;
  }
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, SHUTDOWN_KILL_MS))) {
    throw new Error(`process group ${pid} survived SIGKILL`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error) && !isOperationNotPermitted(error)) {
      throw error;
    }
  }
}

export async function writeAndEnd(
  sink: Writable,
  contents: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      sink.off("error", onError);
      reject(error);
    };
    sink.once("error", onError);
    sink.end(contents, () => {
      sink.off("error", onError);
      resolve();
    });
  });
}

export async function writeToProcess(
  sink: Writable,
  contents: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sink.write(contents, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** Drains a stream while retaining at most maxBytes of diagnostic text. */
export async function collectBoundedText(
  stream: Readable,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let text = "";
  let truncated = false;

  for await (const rawChunk of stream) {
    const chunk =
      typeof rawChunk === "string"
        ? new TextEncoder().encode(rawChunk)
        : new Uint8Array(rawChunk);
    if (remaining === 0) {
      truncated = true;
      continue;
    }
    const retained = chunk.subarray(0, remaining);
    text += decoder.decode(retained, { stream: true });
    remaining -= retained.byteLength;
    truncated ||= retained.byteLength < chunk.byteLength;
  }
  text += decoder.decode();
  return truncated ? `${text}\n[stderr truncated]` : text;
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      return false;
    }
    await delay(Math.min(PROCESS_POLL_MS, remainingMs));
  }
  return true;
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    if (isOperationNotPermitted(error)) {
      return true;
    }
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function isOperationNotPermitted(error: unknown): boolean {
  return errorCode(error) === "EPERM";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}
