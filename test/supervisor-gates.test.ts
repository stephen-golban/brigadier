import { describe, expect, test } from "bun:test";
import type {
  GateCommandRequest,
  GateInput,
  GateName,
  GateResult,
} from "../src/supervisor/gates.js";
import { GATES, runGates } from "../src/supervisor/gates.js";

interface Harness {
  readonly input: GateInput;
  readonly commands: readonly GateCommandRequest[];
}

function harness(
  options: {
    readonly changedPaths?: readonly string[];
    readonly ownedPaths?: readonly string[];
    readonly testCommand?: readonly [string, ...string[]];
    readonly testExitCode?: number;
  } = {},
): Harness {
  const commands: GateCommandRequest[] = [];
  const base = {
    changedPaths: options.changedPaths ?? ["src/auth.ts"],
    ownedPaths: options.ownedPaths ?? ["src/auth.ts"],
    worktreePath: "/tmp/brigadier/slice-1",
    ports: {
      runCommand: (request: GateCommandRequest) => {
        commands.push(request);
        return Promise.resolve({ exitCode: options.testExitCode ?? 0 });
      },
    },
  };
  return {
    input:
      options.testCommand === undefined
        ? base
        : { ...base, testCommand: options.testCommand },
    commands,
  };
}

async function resultFor(
  name: GateName,
  input: GateInput,
): Promise<GateResult> {
  const result = (await runGates(input)).gates.find(
    (candidate) => candidate.name === name,
  );
  if (result === undefined) {
    throw new Error(`gate ${name} did not run`);
  }
  return result;
}

describe("gate inventory", () => {
  test("ships exactly the four named blocking gates", () => {
    expect(GATES.map(({ name, severity }) => ({ name, severity }))).toEqual([
      { name: "paths_owned", severity: "blocking" },
      { name: "paths_touched", severity: "blocking" },
      { name: "diff_non_empty", severity: "blocking" },
      { name: "tests_pass", severity: "blocking" },
    ]);
  });
});

describe("paths_owned", () => {
  test("passes when every changed path is nested under an owned path", async () => {
    const result = await resultFor(
      "paths_owned",
      harness({
        changedPaths: ["src/features/auth/session/token.ts"],
        ownedPaths: ["src"],
      }).input,
    );

    expect(result).toEqual({
      name: "paths_owned",
      severity: "blocking",
      status: "passed",
      findings: [],
    });
  });

  test("fails with the exact blocking finding for an unowned path", async () => {
    const result = await resultFor(
      "paths_owned",
      harness({ ownedPaths: ["test/auth.test.ts"] }).input,
    );

    expect(result).toEqual({
      name: "paths_owned",
      severity: "blocking",
      status: "failed",
      findings: [
        {
          severity: "blocking",
          path: "src/auth.ts",
          line: null,
          summary:
            'Path "src/auth.ts" is outside the slice\'s declared owned paths.',
        },
      ],
    });
  });

  test("the finding identifies the out-of-lane path", async () => {
    const result = await resultFor(
      "paths_owned",
      harness({ ownedPaths: ["test/auth.test.ts"] }).input,
    );

    expect(result.findings[0]?.path).toBe("src/auth.ts");
  });

  test("blocks an outside path when several paths changed", async () => {
    const result = await resultFor(
      "paths_owned",
      harness({
        changedPaths: ["src/owned.ts", "outside.ts"],
        ownedPaths: ["src/owned.ts"],
      }).input,
    );

    expect(result).toEqual({
      name: "paths_owned",
      severity: "blocking",
      status: "failed",
      findings: [
        {
          severity: "blocking",
          path: "outside.ts",
          line: null,
          summary:
            'Path "outside.ts" is outside the slice\'s declared owned paths.',
        },
      ],
    });
  });
});

describe("paths_touched", () => {
  test("passes when every declared path changed", async () => {
    const result = await resultFor(
      "paths_touched",
      harness({ ownedPaths: ["src/auth.ts"] }).input,
    );

    expect(result).toEqual({
      name: "paths_touched",
      severity: "blocking",
      status: "passed",
      findings: [],
    });
  });

  test("reports every untouched owned path with exact blocking findings", async () => {
    const result = await resultFor(
      "paths_touched",
      harness({
        ownedPaths: ["src/auth.ts", "test/auth.test.ts", "docs/auth.md"],
      }).input,
    );

    expect(result).toEqual({
      name: "paths_touched",
      severity: "blocking",
      status: "failed",
      findings: [
        {
          severity: "blocking",
          path: "test/auth.test.ts",
          line: null,
          summary: 'Owned path "test/auth.test.ts" was not changed.',
        },
        {
          severity: "blocking",
          path: "docs/auth.md",
          line: null,
          summary: 'Owned path "docs/auth.md" was not changed.',
        },
      ],
    });
  });

  test("the finding identifies the unchanged owned path", async () => {
    const result = await resultFor(
      "paths_touched",
      harness({ ownedPaths: ["src/auth.ts", "test/auth.test.ts"] }).input,
    );

    expect(result.findings[0]?.path).toBe("test/auth.test.ts");
  });
});

describe("diff_non_empty", () => {
  test("passes when the changed path list is non-empty", async () => {
    const result = await resultFor("diff_non_empty", harness().input);

    expect(result).toEqual({
      name: "diff_non_empty",
      severity: "blocking",
      status: "passed",
      findings: [],
    });
  });

  test("fails with the exact blocking finding when the change is empty", async () => {
    const result = await resultFor(
      "diff_non_empty",
      harness({ changedPaths: [] }).input,
    );

    expect(result).toEqual({
      name: "diff_non_empty",
      severity: "blocking",
      status: "failed",
      findings: [
        {
          severity: "blocking",
          path: "src/auth.ts",
          line: null,
          summary: "The slice produced no diff.",
        },
      ],
    });
  });

  test("the finding points to the slice's primary owned path", async () => {
    const result = await resultFor(
      "diff_non_empty",
      harness({ changedPaths: [] }).input,
    );

    expect(result.findings[0]?.path).toBe("src/auth.ts");
  });
});

describe("tests_pass", () => {
  test("passes when the injected command exits zero", async () => {
    const fixture = harness({ testCommand: ["bun", "test"] });
    const result = await resultFor("tests_pass", fixture.input);

    expect(result).toEqual({
      name: "tests_pass",
      severity: "blocking",
      status: "passed",
      findings: [],
    });
    expect(fixture.commands).toEqual([
      {
        command: ["bun", "test"],
        cwd: "/tmp/brigadier/slice-1",
      },
    ]);
  });

  test("fails with the exact blocking finding on a non-zero exit", async () => {
    const result = await resultFor(
      "tests_pass",
      harness({ testCommand: ["bun", "test"], testExitCode: 2 }).input,
    );

    expect(result).toEqual({
      name: "tests_pass",
      severity: "blocking",
      status: "failed",
      findings: [
        {
          severity: "blocking",
          path: "src/auth.ts",
          line: null,
          summary: "The configured test command exited with code 2.",
        },
      ],
    });
  });

  test("the finding points to the slice's primary owned path", async () => {
    const result = await resultFor(
      "tests_pass",
      harness({ testCommand: ["bun", "test"], testExitCode: 1 }).input,
    );

    expect(result.findings[0]?.path).toBe("src/auth.ts");
  });

  test("without a command reports a reason, does not run, and is not a pass", async () => {
    const fixture = harness();
    const result = await resultFor("tests_pass", fixture.input);

    expect(result).toEqual({
      name: "tests_pass",
      severity: "blocking",
      status: "skipped",
      reason: "No test command was configured.",
      findings: [],
    });
    expect(result.status).not.toBe("passed");
    expect(fixture.commands).toEqual([]);
  });
});

describe("gate report", () => {
  test("exposes findings in the existing review shape without translation", async () => {
    const report = await runGates(
      harness({
        ownedPaths: ["test/auth.test.ts"],
        testCommand: ["bun", "test"],
      }).input,
    );

    expect(report.findings).toEqual([
      {
        severity: "blocking",
        path: "src/auth.ts",
        line: null,
        summary:
          'Path "src/auth.ts" is outside the slice\'s declared owned paths.',
      },
      {
        severity: "blocking",
        path: "test/auth.test.ts",
        line: null,
        summary: 'Owned path "test/auth.test.ts" was not changed.',
      },
    ]);
  });
});
