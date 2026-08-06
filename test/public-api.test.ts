import { expect, test } from "bun:test";
import * as packageApi from "../src/index.ts";

test("root barrel exposes each unit's curated implementation surface", () => {
  const exports = Object.keys(packageApi);

  expect(exports).toEqual(
    expect.arrayContaining([
      "ClaudeWorker",
      "CodexWorker",
      "ClaudeQuotaOracle",
      "CodexQuotaOracle",
      "createClaudeQuotaOracle",
      "createCodexQuotaOracle",
      "GitWorktreeEngine",
      "LinkedSecretCommitError",
      "NoChangesToCommitError",
    ]),
  );
  expect(exports).not.toEqual(
    expect.arrayContaining([
      "isObject",
      "stringValue",
      "failure",
      "asObject",
      "GitCommandError",
      "consumeNdjson",
    ]),
  );
});
