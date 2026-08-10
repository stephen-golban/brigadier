import {
  type ClaudeWorkerSpec,
  type CodexWorkerSpec,
  createIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  type Slice,
  type WorkerEnvironment,
  type WorkerSpec,
} from "../contracts.js";
import type { RoutedWorker } from "../routing/contracts.js";

/**
 * One hour is long enough for a substantial coding slice while still ensuring
 * that a wedged worker cannot hold the supervisor forever. Callers may choose a
 * different finite bound, or deliberately pass null to disable the total bound.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000;

/**
 * Claude's lane is enforced by `Edit(glob)` and `Write(glob)` tool rules, not an
 * OS sandbox.
 * `Bash` is outside those rules and could write anywhere on the machine, so
 * granting it would silently widen the lane to the whole filesystem. This is
 * deliberately stricter than Codex, whose subprocesses run under a real
 * filesystem sandbox profile. Re-adding `Bash` requires a different enforcement
 * mechanism — an OS-level Claude sandbox or per-command permission rules — not
 * a one-line tool-list edit.
 *
 * Read, Glob, and Grep cover repository inspection; Edit changes existing owned
 * files and Write creates new ones. Write is confined to the same lane by the
 * same mechanism: buildClaudeCommand emits `Write(<path>)` beside `Edit(<path>)`
 * for every owned path, and measurement against claude 2.1.226 showed both rules
 * consulted identically — an in-lane Write created a file that did not exist, an
 * out-of-lane one was denied and never reached the disk.
 */
const CLAUDE_TOOLS = ["Edit", "Glob", "Grep", "Read", "Write"] as const;

export interface SpecBuildInput {
  readonly slice: Slice;
  readonly routed: RoutedWorker;
  readonly worktreePath: string;
  /** Injected rather than read from process.env so spec construction stays pure. */
  readonly env: Readonly<Record<string, string | undefined>> & {
    readonly HOME: string;
    readonly PATH: string;
    readonly USER: string;
  };
  readonly idleTimeoutMs?: number;
  readonly timeoutMs?: number | null;
  readonly maxTurns?: number | null;
}

/**
 * Code points that can alter either vendor's lane grammar, and so may never
 * reach one inside an owned path.
 *
 * WHAT THE TWO GRAMMARS ARE. Claude's lane is a single `--allowedTools`
 * argument built as `Edit(<path>)` and `Write(<path>)` items joined with commas,
 * so `(`, `)` and `,` each end one rule early or begin another: an owned path
 * spelled `owned),Edit(package.json` yields `Edit(owned),Edit(package.json)`,
 * which is two rules, the second of them granting edit access to a file the
 * slice does not own. Codex's lane is a TOML table passed to `-c`, in which every path is
 * a quoted basic string, so `"` and `\` are the two characters that can close
 * or re-open that quoting; `{`, `}` and `=` are inert while the quoting holds,
 * and refusing `"` and `\` is exactly what makes it hold. Control characters
 * and DEL are refused for both grammars: NUL truncates an argument at the exec
 * boundary, and CR/LF split any line-oriented reader of the command.
 *
 * WHY THIS EXISTS HERE AS WELL AS AT THE PLAN GATE. `validatePlan` is the first
 * layer and rejects these paths before a run ever starts. This is the second,
 * and deliberately so: a guarantee made three modules away is not something the
 * code performing the dangerous operation can verify. This function is the last
 * place an owned path is seen before it becomes a vendor permission rule, so it
 * re-proves the property rather than assuming an upstream stage ran.
 *
 * The Codex adapter's `JSON.stringify` already escapes `"` and `\` correctly
 * today. That is not a reason to skip them: this guard must not depend on a
 * downstream escaper staying correct through its next edit.
 *
 * Spelled as code points rather than literals so this file contains none of the
 * control bytes it rejects.
 */
const LANE_HOSTILE_CODE_POINTS: ReadonlySet<number> = new Set<number>([
  ...[..."()"].map((character) => character.codePointAt(0) ?? 0),
  0x2c, // ,
  0x22, // "
  0x5c, // \
  ...Array.from({ length: 0x20 }, (_unused, code) => code), // C0 controls
  0x7f, // DEL
]);

/** Build the complete, launchable adapter contract for one routed slice. */
export function buildWorkerSpec(input: SpecBuildInput): WorkerSpec {
  assertLaneSafeOwnedPaths(input.slice);
  const common = {
    id: input.slice.id,
    model: input.routed.model,
    effort: input.routed.effort,
    // Naming the refusal boundary before the task keeps the worker from
    // repeatedly attempting edits the sandbox will reject.
    prompt: workerPrompt(input.slice),
    cwd: input.worktreePath,
    environment: workerEnvironment(input.env),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        workspaceAccess: "edit",
        // validatePlan already proves these paths are safe and non-overlapping;
        // copying, normalizing, or widening them would weaken that exact lane.
        editablePaths: input.slice.ownedPaths,
      },
      // Coding from the checked-out repository needs no network; an empty list
      // is the contract's explicit deny-all posture.
      network: { allowedDomains: [] },
    },
    instructionFiles: {
      // User instructions describe the operator's doctrine and have caused
      // workers to refuse source edits; project instructions are legitimate
      // repository-local conventions and remain in scope.
      user: "exclude",
      project: "include",
    },
    idleTimeoutMs:
      input.idleTimeoutMs === undefined
        ? DEFAULT_IDLE_TIMEOUT_MS
        : // The sanctioned constructor rejects Claude's 600-second boundary and
          // all malformed numeric overrides before the spec reaches an adapter.
          createIdleTimeoutMs(input.idleTimeoutMs),
    timeoutMs:
      input.timeoutMs === undefined
        ? DEFAULT_WORKER_TIMEOUT_MS
        : input.timeoutMs,
    maxTurns: input.maxTurns === undefined ? null : input.maxTurns,
  } as const;

  // The router has already selected model and effort. A configured vendor
  // default must not overwrite that decision or make the routing trace untruthful.
  if (input.routed.vendor === "claude") {
    return {
      ...common,
      vendor: "claude",
      environment: {
        ...common.environment,
        // Disable Claude's per-user auto-memory so it cannot enter the lane.
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      // The supervisor has no reliable per-run price meter to turn into a
      // vendor-side USD cap; the real total-runtime bound still applies.
      maxBudgetUsd: null,
      // Dynamic sections are ambient, run-dependent context, so exclude them
      // to keep the routed slice spec reproducible.
      excludeDynamicSystemPromptSections: true,
      tools: CLAUDE_TOOLS,
      // A worker's entire world is its worktree. Additional directories would
      // let it read outside the slice lane.
      extraDirectories: [],
      // An empty strict MCP set prevents machine-local servers from entering
      // an otherwise isolated worker lane.
      mcp: { configFiles: [], strict: true },
    } satisfies ClaudeWorkerSpec;
  }

  // Codex's --ignore-user-config suppresses only $CODEX_HOME/config.toml;
  // global $CODEX_HOME/AGENTS.md remains ambient, so user exclusion is
  // necessarily best-effort for Codex.
  return {
    ...common,
    vendor: "codex",
    environment: codexEnvironment(common.environment, input.env),
  } satisfies CodexWorkerSpec;
}

function workerEnvironment(env: SpecBuildInput["env"]): WorkerEnvironment {
  return {
    // This list is minimal by policy: every member needs a stated launch reason,
    // and no other ambient operator variables enter the worker. HOME locates
    // vendor credential files; PATH locates the executable and child tools;
    // SHELL fixes predictable non-TTY shell behavior. USER lets Claude Code
    // resolve OAuth credentials from the macOS login Keychain. A real worker run,
    // not a test, proved that authentication fails without it and that LOGNAME
    // does not substitute for it.
    HOME: env.HOME,
    PATH: env.PATH,
    USER: env.USER,
    SHELL: "/bin/sh",
  };
}

/**
 * Add `CODEX_HOME` for a Codex worker, but only when the operator actually set
 * it.
 *
 * The minimal-environment policy above strips everything ambient, and
 * `CODEX_HOME` is the second variable found to be load-bearing despite that —
 * the same class of defect as `USER`. Codex resolves its credentials relative
 * to `CODEX_HOME`, not to `HOME`, so an operator whose Codex login lives
 * anywhere but the default gets a worker that routes successfully and then
 * cannot authenticate.
 *
 * MEASURED, not assumed, against the installed codex-cli 0.145.0:
 *
 *   - `codex exec --help` documents `--ignore-user-config` as "Do not load
 *     `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`" — and the spec
 *     above passes `--ignore-user-config` for every Codex worker, so this is
 *     exactly the configuration in which the note applies.
 *   - `CODEX_HOME=<empty dir> codex doctor --json` reports
 *     `auth.credentials: fail`, "no Codex credentials were found", looking for
 *     `auth.json` under the given directory.
 *   - `CODEX_HOME=<dir holding a copy of auth.json> codex doctor --json`
 *     reports `auth.credentials: ok` from that copy, so the variable is honored
 *     positively and not merely destructively.
 *   - `CODEX_HOME=<empty dir> codex exec --json --ignore-user-config` really
 *     fails: `401 Unauthorized ... Missing bearer or basic authentication in
 *     header` from the responses endpoint.
 *
 * Never defaulted. Codex already falls back to `$HOME/.codex` on its own, and
 * inventing a value here would replace the vendor's own resolution with a guess
 * on every machine that never set the variable.
 */
function codexEnvironment(
  base: WorkerEnvironment,
  env: SpecBuildInput["env"],
): WorkerEnvironment {
  const codexHome = env.CODEX_HOME;
  if (codexHome === undefined || codexHome === "") {
    return base;
  }
  return { ...base, CODEX_HOME: codexHome };
}

/**
 * Refuse to build a spec whose owned paths could rewrite a vendor's lane.
 *
 * A throw rather than a result because there is no safe degraded spec to
 * return: the caller's alternative to a launchable lane is not launching. The
 * slice runner catches this and records a `LAUNCH_FAILURE`.
 */
function assertLaneSafeOwnedPaths(slice: Slice): void {
  for (const ownedPath of slice.ownedPaths) {
    const offenders = new Set<number>();
    for (const character of ownedPath) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (LANE_HOSTILE_CODE_POINTS.has(codePoint)) {
        offenders.add(codePoint);
      }
    }
    if (offenders.size > 0) {
      const named = [...offenders]
        .sort((left, right) => left - right)
        .map(
          (codePoint) =>
            `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
        )
        .join(", ");
      throw new Error(
        `refusing to build a worker spec for slice ${JSON.stringify(slice.id)}: owned path ${JSON.stringify(ownedPath)} contains ${named}, which can alter a vendor's lane grammar`,
      );
    }
  }
}

function workerPrompt(slice: Slice): string {
  const ownedPaths = slice.ownedPaths.map((path) => `- ${path}`).join("\n");
  return `You may edit only these owned paths:\n${ownedPaths}\n\n${slice.prompt}`;
}
