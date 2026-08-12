import type {
  DeterministicGateName,
  DeterministicGateResult,
  ReviewFinding,
  ReviewSeverity,
} from "./contracts.js";

export type GateName = DeterministicGateName;

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
  readonly changedPaths: readonly string[] | null;
  /** The measured reason `changedPaths` could not be obtained. */
  readonly changedPathsUnavailableReason?: string;
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

export type GateResult = DeterministicGateResult;

export interface GateRunResult {
  readonly gates: readonly GateResult[];
  /** Ready to append to a model review without translating its members. */
  readonly findings: readonly ReviewFinding[];
}

const PATHS_OWNED: Gate = {
  name: "paths_owned",
  severity: "blocking",
  skipReason: changedPathsSkipReason,
  check: (input) => {
    const changedPaths = requireChangedPaths(input);
    const findings = changedPaths
      .filter(
        (changedPath) =>
          !input.ownedPaths.some((ownedPath) =>
            pathIncludes(ownedPath, changedPath),
          ),
      )
      .map((path) =>
        finding(
          PATHS_OWNED,
          path,
          `Path ${JSON.stringify(path)} is outside the slice's declared owned paths.`,
        ),
      );
    return Promise.resolve(findings);
  },
};

const PATHS_TOUCHED: Gate = {
  name: "paths_touched",
  severity: "concern",
  skipReason: changedPathsSkipReason,
  check: (input) => {
    const changedPaths = requireChangedPaths(input);
    const findings = input.ownedPaths
      .filter(
        (ownedPath) =>
          !changedPaths.some((changedPath) =>
            pathIncludes(ownedPath, changedPath),
          ),
      )
      .map((path) =>
        finding(
          PATHS_TOUCHED,
          path,
          `Owned path ${JSON.stringify(path)} was not changed.`,
        ),
      );
    return Promise.resolve(findings);
  },
};

const DIFF_NON_EMPTY: Gate = {
  name: "diff_non_empty",
  severity: "blocking",
  skipReason: changedPathsSkipReason,
  check: (input) => {
    const changedPaths = requireChangedPaths(input);
    return Promise.resolve(
      changedPaths.length === 0
        ? [
            finding(
              DIFF_NON_EMPTY,
              primaryPath(input),
              "The slice produced no diff.",
            ),
          ]
        : [],
    );
  },
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
            TESTS_PASS,
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
  return await runGateSet(input, GATES);
}

/** Run the command gate before anything snapshots the tree it may mutate. */
export async function runVerificationGate(
  input: GateInput,
): Promise<GateRunResult> {
  return await runGateSet(input, [TESTS_PASS]);
}

/** Run the gates whose evidence comes from the authoritative post-verify diff. */
export async function runChangedPathGates(
  input: GateInput,
): Promise<GateRunResult> {
  return await runGateSet(input, [PATHS_OWNED, PATHS_TOUCHED, DIFF_NON_EMPTY]);
}

async function runGateSet(
  input: GateInput,
  gates: readonly Gate[],
): Promise<GateRunResult> {
  const results: GateResult[] = [];
  const findings: ReviewFinding[] = [];

  for (const gate of gates) {
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

    let gateFindings: readonly ReviewFinding[];
    try {
      gateFindings = await gate.check(input);
    } catch (error) {
      // `skipReason` is the sole deliberately-not-applicable path. Reaching the
      // check means this gate was required to run, so an exception is measured
      // failure evidence — especially for a blocking command gate that never
      // started — rather than an invisible skip.
      const gateFindings = [
        finding(
          gate,
          primaryPath(input),
          `The gate could not run: ${describeError(error)}`,
        ),
      ];
      findings.push(...gateFindings);
      results.push({
        name: gate.name,
        severity: gate.severity,
        status: "failed",
        findings: gateFindings,
      });
      continue;
    }
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

function finding(
  gate: Pick<Gate, "name" | "severity">,
  path: string | null,
  summary: string,
): ReviewFinding {
  return {
    source: "gate",
    gate: gate.name,
    severity: gate.severity,
    path,
    line: null,
    summary,
  };
}

function changedPathsSkipReason(input: GateInput): string | null {
  if (input.changedPaths !== null) {
    return null;
  }
  return input.changedPathsUnavailableReason === undefined
    ? "The changed-path list is unavailable."
    : `The changed-path list is unavailable: ${input.changedPathsUnavailableReason}`;
}

function requireChangedPaths(input: GateInput): readonly string[] {
  if (input.changedPaths === null) {
    // `runGates` normally catches this earlier through `skipReason`. Keeping
    // the check itself fail-loud prevents a future inventory refactor from
    // turning unavailable evidence into an empty list and therefore a pass.
    throw new Error(
      input.changedPathsUnavailableReason ??
        "The changed-path list is unavailable.",
    );
  }
  return input.changedPaths;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
