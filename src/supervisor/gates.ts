import type { ReviewFinding, ReviewSeverity } from "./contracts.js";

export type GateName =
  | "paths_owned"
  | "paths_touched"
  | "diff_non_empty"
  | "tests_pass";

export interface GateCommandRequest {
  readonly command: readonly [executable: string, ...arguments_: string[]];
  readonly cwd: string;
}

export interface GateCommandResult {
  readonly exitCode: number;
}

export interface GatePorts {
  readonly runCommand: (
    request: GateCommandRequest,
  ) => Promise<GateCommandResult>;
}

export interface GateInput {
  /**
   * Every repository path the change touches, supplied by the worktree engine
   * from git rather than parsed from patch text. Review patches are redacted
   * and truncated, so redaction can corrupt headers and truncation can omit
   * whole file blocks.
   */
  readonly changedPaths: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly worktreePath: string;
  readonly testCommand?: readonly [executable: string, ...arguments_: string[]];
  readonly ports: GatePorts;
}

export interface Gate {
  readonly name: GateName;
  readonly severity: ReviewSeverity;
  readonly check: (input: GateInput) => Promise<readonly ReviewFinding[]>;
  readonly skipReason?: (input: GateInput) => string | null;
}

export type GateResult =
  | {
      readonly name: GateName;
      readonly severity: ReviewSeverity;
      readonly status: "passed" | "failed";
      readonly findings: readonly ReviewFinding[];
    }
  | {
      readonly name: GateName;
      readonly severity: ReviewSeverity;
      readonly status: "skipped";
      readonly reason: string;
      readonly findings: readonly [];
    };

export interface GateRunResult {
  readonly gates: readonly GateResult[];
  /** Ready to append to a model review without translating its members. */
  readonly findings: readonly ReviewFinding[];
}

const PATHS_OWNED: Gate = {
  name: "paths_owned",
  severity: "blocking",
  check: (input) => {
    const findings = input.changedPaths
      .filter(
        (changedPath) =>
          !input.ownedPaths.some((ownedPath) =>
            pathIncludes(ownedPath, changedPath),
          ),
      )
      .map((path) =>
        finding(
          path,
          `Path ${JSON.stringify(path)} is outside the slice's declared owned paths.`,
        ),
      );
    return Promise.resolve(findings);
  },
};

const PATHS_TOUCHED: Gate = {
  name: "paths_touched",
  severity: "blocking",
  check: (input) => {
    const findings = input.ownedPaths
      .filter(
        (ownedPath) =>
          !input.changedPaths.some((changedPath) =>
            pathIncludes(ownedPath, changedPath),
          ),
      )
      .map((path) =>
        finding(path, `Owned path ${JSON.stringify(path)} was not changed.`),
      );
    return Promise.resolve(findings);
  },
};

const DIFF_NON_EMPTY: Gate = {
  name: "diff_non_empty",
  severity: "blocking",
  check: (input) =>
    Promise.resolve(
      input.changedPaths.length === 0
        ? [finding(primaryPath(input), "The slice produced no diff.")]
        : [],
    ),
};

const TESTS_PASS: Gate = {
  name: "tests_pass",
  severity: "blocking",
  skipReason: (input) =>
    input.testCommand === undefined ? "No test command was configured." : null,
  check: async (input) => {
    const command = input.testCommand;
    if (command === undefined) {
      return [];
    }
    const result = await input.ports.runCommand({
      command,
      cwd: input.worktreePath,
    });
    return result.exitCode === 0
      ? []
      : [
          finding(
            primaryPath(input),
            `The configured test command exited with code ${result.exitCode}.`,
          ),
        ];
  },
};

export const GATES = [
  PATHS_OWNED,
  PATHS_TOUCHED,
  DIFF_NON_EMPTY,
  TESTS_PASS,
] as const satisfies readonly Gate[];

export async function runGates(input: GateInput): Promise<GateRunResult> {
  const results: GateResult[] = [];
  const findings: ReviewFinding[] = [];

  for (const gate of GATES) {
    const reason = gate.skipReason?.(input) ?? null;
    if (reason !== null) {
      results.push({
        name: gate.name,
        severity: gate.severity,
        status: "skipped",
        reason,
        findings: [],
      });
      continue;
    }

    const gateFindings = await gate.check(input);
    findings.push(...gateFindings);
    results.push({
      name: gate.name,
      severity: gate.severity,
      status: gateFindings.length === 0 ? "passed" : "failed",
      findings: gateFindings,
    });
  }

  return { gates: results, findings };
}

function finding(path: string | null, summary: string): ReviewFinding {
  return { severity: "blocking", path, line: null, summary };
}

function primaryPath(input: GateInput): string {
  return input.ownedPaths[0] ?? ".";
}

function pathIncludes(ownedPath: string, changedPath: string): boolean {
  const owned = normalizePath(ownedPath);
  const changed = normalizePath(changedPath);
  return changed === owned || changed.startsWith(`${owned}/`);
}

function normalizePath(path: string): string {
  let normalized = path
    .normalize("NFC")
    .replace(/\/+/g, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
  while (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
