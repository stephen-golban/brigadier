import { expect, test } from "bun:test";
import { CONFIG_VERSION } from "../src/config/contracts.js";
import type { InputStream, OutputStream } from "../src/init/prompt.js";
import { serveMcp } from "../src/mcp/server.js";

const SETTLE_BOUND_MS = 2_000;

async function withBound<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `MCP interrupt test did not settle within ${SETTLE_BOUND_MS} ms`,
        ),
      );
    }, SETTLE_BOUND_MS);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test("an MCP run arms cancellation before execute and exits 130 after abort", async () => {
  const controller = new AbortController();
  const armings: string[] = [];
  const observedAbort: boolean[] = [];
  const stdoutChunks: string[] = [];
  const stdout: OutputStream = {
    write: (chunk) => {
      stdoutChunks.push(chunk);
    },
  };
  const input = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "brigadier_run",
      arguments: {
        plan: {
          id: "interrupt",
          goal: "prove cancellation",
          slices: [
            {
              id: "slice-one",
              title: "One",
              prompt: "Do one thing.",
              ownedPaths: ["src/one.ts"],
              difficulty: "routine",
            },
          ],
        },
        repositoryPath: "/repo",
      },
    },
  })}\n`;
  const stdin: InputStream = {
    [Symbol.asyncIterator]: async function* iterate() {
      yield input;
    },
  };

  const code = await withBound(
    serveMcp({
      stdin,
      stdout,
      stderr: { write: () => undefined },
      version: "0.0.0",
      signal: controller.signal,
      onCancellable: () => {
        armings.push("armed");
        controller.abort({ kind: "interrupt", signal: "SIGINT" });
      },
      dependencies: {
        loadConfig: () =>
          Promise.resolve({
            path: "/config.json",
            config: {
              version: CONFIG_VERSION,
              vendors: [],
              secretsConsent: false,
              linkedSecretPaths: [],
              allowDegradedRouting: false,
            },
          }),
        execute: () => {
          observedAbort.push(controller.signal.aborted);
          return Promise.resolve({ text: "cancel observed", isError: true });
        },
      },
    }),
  );

  expect(code).toBe(130);
  expect(armings).toEqual(["armed"]);
  expect(observedAbort).toEqual([true]);
  expect(stdoutChunks.join("")).toBe(
    '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"cancel observed"}],"isError":true}}\n',
  );
});
