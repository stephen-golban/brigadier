/**
 * The supervisor vocabulary. WO-011 owns this file and may amend it freely; it
 * must not add its members to the frozen `src/contracts.ts`.
 *
 * The supervisor is `brigadier run`: it takes a plan somebody already made,
 * routes each slice to a model, gives each slice its own git worktree, spawns a
 * worker CLI in it, commits what the worker produced, merges the commit into an
 * integration branch, and returns exactly one value describing all of it.
 *
 * Two properties shape every type below.
 *
 * The first is that the supervisor is the *only* impure component in this
 * codebase. The router is a pure function of `RoutingInput`; the plan validator
 * is a pure function of a `Plan`; the quota readers are pure functions of a
 * snapshot. The supervisor runs git, writes files, and spawns subprocesses.
 * Everything it needs from that outside world arrives through
 * `SupervisorPorts`, so the orchestration logic stays a pure function of its
 * inputs in exactly the way the components beneath it already are.
 *
 * The second is that a run reports rather than throws. A five-slice run where
 * slice three could not be routed still merged the other four and still owes
 * the user their commits, their branch, and the routing rejections that explain
 * the gap. An exception can carry one of those. `RunReport` carries all of
 * them, which is why the failure vocabulary here is data (`SliceFailure`,
 * `RunFailureReason`) rather than an error hierarchy.
 */

import type {
  AnyWorker,
  Plan,
  Slice,
  Vendor,
  WorkerFailure,
  WorkerOutcome,
} from "../contracts.js";
import type { PlanIssue } from "../plan/contracts.js";
import type { AnyQuotaOracle } from "../quota/contracts.js";
import type {
  RoutedWorker,
  RoutingFailureReason,
  RoutingInput,
  RoutingRejection,
  SliceDifficulty,
  SliceRequirements,
} from "../routing/contracts.js";
import type {
  CreatedWorktree,
  MergeResult,
  WorktreeEngine,
  WorktreeSession,
} from "../worktree/contracts.js";

/**
 * Per-slice planning metadata that `Slice` (frozen) has no room for.
 *
 * `RoutingRequest` requires a `difficulty` for every slice it routes, and
 * `Slice` in `src/contracts.ts` does not carry one. The value had to live
 * somewhere, and there were two places it could go: inside the frozen contract,
 * or beside it.
 *
 * Beside it won. The freeze on `src/contracts.ts` held byte-identical through
 * nineteen work orders and has been spent exactly once, for a defect that could
 * not be fixed anywhere else (`QuotaWindow` could not represent per-model
 * metering). This is not that: difficulty is a *planner's* judgement about work,
 * while `Slice` is the launch-time description of a unit of work shared by every
 * adapter. Widening the shared contract so one component upstream of it can pass
 * a note is how a frozen core stops being frozen.
 *
 * The cost of the side channel is honest and worth naming: `PlanDocument` must
 * keep two parallel sequences aligned by `sliceId`, and a caller that builds one
 * by hand can misalign them. `parsePlanDocument` is the answer — it is the only
 * supported way to build a `PlanDocument` from untrusted bytes, and it emits
 * `directives` in the same order as `plan.slices`, one per slice.
 */
export interface SliceDirective {
  readonly sliceId: string;
  readonly difficulty: SliceDifficulty;
  readonly requires?: SliceRequirements;
}

/**
 * A validated plan document: the frozen `Plan` plus its side-channel directives.
 *
 * "Validated" here means *shaped*, not *schedulable*. This type asserts that
 * every field exists with the right type and that a directive accompanies every
 * slice. It asserts nothing about path conflicts, dependency cycles, or other
 * structural defects — those are `validatePlan`'s job, and the orchestrator
 * runs it separately so its `PlanIssue[]` reaches the report intact. Dependency
 * wave width is scheduling input; the supervisor's bounded pool limits how many
 * members run concurrently.
 */
export interface PlanDocument {
  readonly plan: Plan;
  readonly directives: readonly SliceDirective[];
}

/**
 * One invocation of `brigadier run`.
 *
 * Everything here is a decision the caller makes and the supervisor obeys.
 * There are no defaults hiding in this type: `maxWorkers` is required because
 * concurrency is an explicit choice, never something a caller acquires by
 * omission. It is the single place a run's concurrency is chosen;
 * `validatePlan` returns full structural waves without applying a worker limit.
 */
export interface RunRequest {
  readonly document: PlanDocument;
  readonly repositoryPath: string;
  readonly slug: string;
  readonly maxWorkers: number;
  /**
   * Route and report; prepare nothing, spawn nothing, commit nothing.
   *
   * The interesting half of a run is the routing, and the routing is pure. A dry
   * run therefore answers "which model would each slice get, and why" — the
   * `rationale` on each `RoutedWorker` — without creating a branch or burning a
   * token, which is what makes a routing complaint reproducible.
   */
  readonly dryRun?: boolean;
  /**
   * Run the workers directly in the source checkout instead of in isolated
   * worktrees. Named `unsafe` because it is: every file already visible there is
   * visible to every worker, including dependencies and linked secret files,
   * whatever the isolated-worktree consent policy says.
   */
  readonly unsafeInPlace?: boolean;
}

/**
 * Everything the supervisor touches outside itself. Injected so the
 * orchestrator and runner are testable without git or a subprocess.
 *
 * This interface exists because the supervisor is the first component in this
 * codebase that touches the real filesystem, real git, and real subprocesses.
 * Every layer below it is pure: the router is a function of `RoutingInput`, the
 * plan validator a function of a `Plan`, the quota readers functions of a
 * snapshot — and each is unit-tested from a literal, with no clock, no network,
 * and no temp directory. That property was not free, and the supervisor is where
 * it would ordinarily be lost.
 *
 * Naming the outside world as one injected record keeps it. With ports, the
 * orchestrator and the slice runner remain ordinary functions over ordinary
 * values: a fake `WorktreeEngine` and a fake `Worker` are enough to drive a
 * merge conflict, a worker crash, an empty diff, or an exhausted vendor, none of
 * which are reachable in a test that has to make them happen for real.
 *
 * `now` is in here for the same reason the engine is. A `RunReport` states
 * durations, and a report whose numbers change between runs cannot be asserted
 * against absolute values.
 */
export interface SupervisorPorts {
  readonly engine: WorktreeEngine;
  /** Resolves the adapter for a vendor. Returns null when unconfigured. */
  readonly workerFor: (vendor: Vendor) => AnyWorker | null;
  readonly oracles: readonly AnyQuotaOracle[];
  /** Injected so reports are reproducible in tests. */
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/**
 * Why one slice did not finish, named by the stage that stopped it.
 *
 * The stages are ordered as the runner performs them — route, prepare a
 * worktree, spawn a worker, inspect the diff, commit — so the kind alone tells a
 * reader how far the slice got and what state the repository is in.
 *
 * `NO_CHANGES` is a failure rather than a trivial success, and the reason is
 * worth stating flatly: a worker that exits cleanly having changed no file has
 * not done the slice. Committing nothing and reporting success would produce an
 * empty integration branch and a green run — the worst available outcome,
 * because it looks exactly like the good one and nothing downstream would ever
 * question it.
 */
export type SliceFailureKind =
  | "ROUTING_FAILED"
  | "WORKTREE_FAILED"
  | "WORKER_FAILED"
  | "NO_CHANGES"
  | "COMMIT_FAILED";

/**
 * A slice failure, carrying the upstream diagnosis where one exists.
 *
 * WHAT "FAILED" MEANS HERE, EXACTLY. A slice fails when it could not be routed,
 * when its worktree could not be created, when its worker returned a failed
 * `WorkerOutcome`, when the worker changed no files, or when the commit did not
 * land. That is the complete list, and it is narrower than a reader of decision
 * #24 will expect: that decision speaks of a slice "failing its gate", and THIS
 * UNIT RUNS NO GATE. It does not run the repository's tests, its linter, or its
 * build for a slice, and it forms no opinion about whether the diff is any good.
 * Per-slice quality gating is deliberately a later unit's job.
 *
 * The distinction matters because it changes what `ATTEMPT_LIMIT` buys. The
 * escalation here is driven by a worker that did not finish, not by work that
 * finished badly — so a slice whose worker cheerfully produces a wrong but
 * committable diff is `ok: true` today, and will stay that way until the gate
 * exists. Reading the retry as gate-driven would suggest a guarantee about
 * quality that nothing in this unit provides.
 *
 * Every member has a `message`, which is what a human reads. Two members carry
 * more, because two stages produce a structured explanation that a summary
 * string would destroy: routing returns the rejected-model list that answers
 * "what did it even look at", and a worker returns a normalized `WorkerFailure`
 * whose `kind` and `retryable` flag decide whether the earned escalation is
 * worth spending. The other three stages produce a git error and nothing more,
 * so they carry nothing more; a payload invented for symmetry would be a field
 * every caller has to check and no caller can trust.
 */
export type SliceFailure =
  | {
      readonly kind: "ROUTING_FAILED";
      readonly message: string;
      readonly reason: RoutingFailureReason;
      readonly rejected: readonly RoutingRejection[];
    }
  | { readonly kind: "WORKTREE_FAILED"; readonly message: string }
  | {
      readonly kind: "WORKER_FAILED";
      readonly message: string;
      readonly failure: WorkerFailure;
    }
  | { readonly kind: "NO_CHANGES"; readonly message: string }
  | { readonly kind: "COMMIT_FAILED"; readonly message: string };

/**
 * The `SliceFailureKind` members as data, for exhaustive iteration and for
 * rendering a legend in `--help` output without a `switch` that drifts.
 */
export const SLICE_FAILURE_KINDS = [
  "ROUTING_FAILED",
  "WORKTREE_FAILED",
  "WORKER_FAILED",
  "NO_CHANGES",
  "COMMIT_FAILED",
] as const satisfies readonly SliceFailureKind[];

/**
 * One spawn of one slice. `attempt` 2 exists only after attempt 1 failed.
 *
 * Attempts are recorded rather than overwritten because the second attempt is
 * not a do-over: decision #20 makes `xhigh` an *earned* escalation, unlocked
 * only by an observed gate failure, so attempt 1's failure is the evidence that
 * justifies attempt 2's effort level. Discarding it would leave the report
 * asserting a top-rung run with no reason on the record for why it was allowed.
 *
 * Every field except `attempt` and `durationMs` is nullable because a slice can
 * die at any stage: routing failure leaves `routed` null, a worktree failure
 * leaves `outcome` null, and a worker that ran but changed nothing leaves
 * `commit` null with a non-null `outcome`. `failure` is null exactly when the
 * attempt succeeded.
 */
export interface SliceAttempt {
  readonly attempt: number;
  readonly routed: RoutedWorker | null;
  readonly outcome: WorkerOutcome | null;
  readonly commit: string | null;
  readonly failure: SliceFailure | null;
  readonly durationMs: number;
}

/**
 * A slice runs at most twice: once on the model the router picked, and once
 * more on a stronger one after that attempt failed.
 *
 * The ruling is that the second failure carries different information from the
 * first. One failure is plausibly the model; two, on two different models, is
 * evidence the slice itself is wrong — underspecified, too large, or asking for
 * something the repository will not allow — and no third model fixes that. An
 * unbounded climb up the ladder costs a worktree, a subprocess, and a commit per
 * rung, all spent re-learning the same fact, and it does it while holding one of
 * `maxWorkers` slots that a slice with a real chance could be using.
 */
export const ATTEMPT_LIMIT = 2 as const;

/**
 * How one slice ended, with every attempt it took to get there.
 *
 * `ok` is the verdict and `attempts` is the evidence: a slice that failed at
 * `high` and succeeded at `xhigh` is `ok: true` with two attempts, and the
 * distinction between that and a first-try success matters to anyone deciding
 * whether the plan was sliced too coarsely.
 *
 * A UNION RATHER THAN SIX INDEPENDENT FIELDS, AND THAT IS THE WHOLE POINT.
 * Written flat — `ok: boolean` beside `worktree: CreatedWorktree | null` — the
 * type permits states the runner can never produce and the orchestrator must
 * never see: a successful slice with no commit, a failed slice still holding a
 * live worktree. The second one is not hypothetical bookkeeping. The
 * orchestrator's job is to hand each successful slice's worktree to
 * `engine.merge()`, and a caller that reads `worktree` off a failed slice gets
 * `null`, so the flat shape forces every consumer to either re-check a nullness
 * the discriminant already settled or reach for a `!` — and a `!` is exactly how
 * a failed slice's `null` reaches `merge()` and takes the run down at runtime.
 *
 * Splitting on `ok` makes the illegal states unrepresentable and makes the legal
 * ones free: narrowing with `if (result.ok)` yields a `CreatedWorktree` and a
 * `string` commit with no assertion, no cast, and nothing to remember.
 *
 * WORKTREE OWNERSHIP, which the union encodes but cannot enforce on its own. A
 * successful slice's worktree is returned live and un-removed because
 * `engine.merge()` takes a `CreatedWorktree` and immediately looks it up in the
 * engine's own registry; one passed to `merge()` after `remove()` is rejected
 * with "worktree was not created by this engine or has already been removed".
 * Merging is the orchestrator's job, so the handle has to survive the runner.
 * That splits ownership, and the split is a rule rather than a convention:
 *
 * - The RUNNER creates worktrees and removes the ones belonging to FAILED
 *   attempts, because nothing will ever be merged from those.
 * - The ORCHESTRATOR removes the SURVIVING worktrees, and only after
 *   reconciliation, because `merge()` rejects a removed one.
 *
 * The `ok: false` member's `worktree: null` is what makes the first half of that
 * rule checkable: a runner that returns a failed slice still holding its
 * worktree no longer compiles. The second half is still only a rule — a
 * tidy-minded orchestrator that removes a successful worktree before merging it
 * will type-check and fail every merge at runtime.
 */
export type SliceResult =
  | {
      readonly sliceId: string;
      readonly ok: true;
      readonly branch: string;
      readonly commit: string;
      /** Live and un-removed; the orchestrator merges from it, then removes it. */
      readonly worktree: CreatedWorktree;
      readonly attempts: readonly SliceAttempt[];
    }
  | {
      readonly sliceId: string;
      readonly ok: false;
      /** Null when routing failed before a worktree was ever created. */
      readonly branch: string | null;
      /**
       * Always null. A slice that committed and then failed is not a thing this
       * unit can produce: committing is the last step, so a failure after it is
       * a merge failure, and merges are recorded in `SliceMergeRecord`.
       */
      readonly commit: null;
      /** Always null; the runner already removed every failed attempt's worktree. */
      readonly worktree: null;
      readonly attempts: readonly SliceAttempt[];
    };

/**
 * One slice's merge into the integration branch.
 *
 * The `sliceId` is kept alongside the engine's `MergeResult` because
 * `MergeResult` identifies a branch, not a slice, and a conflict report that
 * names only a ref makes the reader map it back to a plan by hand.
 */
export interface SliceMergeRecord {
  readonly sliceId: string;
  readonly result: MergeResult;
}

/**
 * Why the run as a whole did not succeed, ordered by how early it can happen.
 *
 * These are deliberately coarse. The detail lives in `RunReport.planIssues` and
 * in each slice's `SliceFailure`; this reason exists so a caller — a CLI exit
 * code, a CI step — can branch on the shape of the failure without walking the
 * report. `SLICE_FAILED` and `MERGE_CONFLICT` are distinguished because they
 * demand opposite responses: the first means work was not produced, the second
 * means work was produced and cannot be combined.
 */
export type RunFailureReason =
  | "PLAN_INVALID"
  | "PREFLIGHT_ROUTING_FAILED"
  | "PREPARE_FAILED"
  | "SLICE_FAILED"
  | "MERGE_CONFLICT";

/** The `RunFailureReason` members as data, for exhaustive iteration. */
export const RUN_FAILURE_REASONS = [
  "PLAN_INVALID",
  "PREFLIGHT_ROUTING_FAILED",
  "PREPARE_FAILED",
  "SLICE_FAILED",
  "MERGE_CONFLICT",
] as const satisfies readonly RunFailureReason[];

/**
 * Compile-time exhaustiveness. `Assert` accepts only `true`, so each alias below
 * stops compiling the moment a member is added to one of the unions above and
 * not to its array — which is the only thing that makes those arrays safe to
 * iterate as if they were the union.
 *
 * DO NOT DELETE THESE AS REDUNDANT WITH THE `satisfies` CLAUSES. They are not.
 * `satisfies readonly SliceFailureKind[]` checks that every element IS a member
 * of the union; it says nothing about whether every member of the union APPEARS.
 * A kind added to `SliceFailureKind` and forgotten in `SLICE_FAILURE_KINDS`
 * satisfies that clause perfectly and compiles clean, leaving an array that
 * silently under-reports the union it advertises. The `satisfies` clause catches
 * a wrong member; only the alias below catches a missing one. Both are load
 * bearing and neither substitutes for the other.
 */
type Assert<T extends true> = T;
type _SliceFailureKindsAreExhaustive = Assert<
  [Exclude<SliceFailureKind, (typeof SLICE_FAILURE_KINDS)[number]>] extends [
    never,
  ]
    ? true
    : false
>;
type _RunFailureReasonsAreExhaustive = Assert<
  [Exclude<RunFailureReason, (typeof RUN_FAILURE_REASONS)[number]>] extends [
    never,
  ]
    ? true
    : false
>;

/**
 * The single value a run returns, successful or not.
 *
 * A run is a long, partially-failing, side-effecting operation, and every one of
 * those adjectives argues against signalling its result by throwing. `ok: false`
 * still carries the slices that succeeded, the merges that landed, and the
 * branch they landed on, because a user whose run half-failed needs to know
 * exactly which half.
 *
 * `planIssues` is present even on success, and is normally empty there: a plan
 * can validate with warnings-shaped issues that never blocked scheduling, and a
 * report that dropped them on the happy path would make the same run tell two
 * different stories depending on its outcome.
 *
 * `integrationBranch` is null for a dry run and for a run that failed before
 * `prepare`, which are precisely the cases where no ref was created.
 */
export interface RunReport {
  readonly ok: boolean;
  readonly slug: string;
  readonly dryRun: boolean;
  readonly integrationBranch: string | null;
  readonly slices: readonly SliceResult[];
  readonly merges: readonly SliceMergeRecord[];
  readonly planIssues: readonly PlanIssue[];
  readonly failure: {
    readonly reason: RunFailureReason;
    readonly message: string;
  } | null;
  readonly durationMs: number;
}

/**
 * One pre-allocated worktree identity. Attempt N uses slot N-1.
 *
 * A retry cannot reuse its predecessor's slice number, and the reason is a
 * property of the engine rather than a stylistic preference. `engine.remove()`
 * discards the worktree directory and unregisters it, but it does NOT delete the
 * slice's branch ref — only `create()`'s own error path does that. `create()`
 * then refuses any branch that already exists ("refusing to overwrite existing
 * branch ..."). So attempt 2 calling `create()` with attempt 1's number is not a
 * subtle collision; it is a hard failure that would turn every escalation into a
 * `WORKTREE_FAILED`. Each attempt needs its own number and its own path.
 *
 * They are pre-allocated by the orchestrator rather than requested lazily
 * because numbering is global across the run: slices execute concurrently, and a
 * runner that asked for the next number would need a shared mutable counter,
 * which is both a race and a dependency that makes a slice's branch name depend
 * on scheduling order. Handing the runner its slots up front keeps it free of
 * shared state and keeps a run reproducible from a literal.
 */
export interface AttemptSlot {
  /**
   * Positive integer, globally unique across the run; becomes
   * `brigadier/<slug>/slice-N`.
   */
  readonly sliceNumber: number;
  readonly worktreePath: string;
}

/**
 * One slice, end to end, including its single earned escalation.
 *
 * This is the seam between the orchestrator, which owns scheduling, waves, and
 * the session, and the runner, which owns one slice's lifecycle. Everything the
 * runner needs is here and nothing else is: it cannot see its siblings, cannot
 * see the wave it belongs to, and cannot reach the config except through
 * `routing`. That is what lets the orchestrator run `maxWorkers` of these
 * concurrently without them sharing anything but the session.
 *
 * `routing` is the snapshot the router will consume, passed in rather than
 * loaded, so a slice's model choice is reproducible from this value alone.
 */
export interface SliceRunInput {
  readonly slice: Slice;
  readonly directive: SliceDirective;
  readonly session: WorktreeSession;
  /**
   * One slot per permitted attempt, pre-allocated by the orchestrator. Length is
   * 1 when no retry is permitted and 2 when it is; attempt N uses slot N-1.
   */
  readonly attemptSlots:
    | readonly [AttemptSlot]
    | readonly [AttemptSlot, AttemptSlot];
  readonly routing: RoutingInput;
  readonly unsafeInPlace: boolean;
}

/**
 * The runner interface, kept separate from the orchestrator so scheduling can be
 * tested against a fake runner and a slice's lifecycle against a fake engine.
 *
 * It never rejects. Every way a slice can fail is a `SliceResult` with `ok:
 * false`, because a rejected promise inside a concurrent wave either takes down
 * its siblings or gets swallowed, and both are worse than a recorded failure.
 *
 * ORDERING CONSTRAINT, INVISIBLE FROM THESE TYPES. Every slice attempt —
 * including every retry — must complete before the orchestrator calls the first
 * `engine.merge()`. `engine.commit()` throws "slice commits are closed after
 * integration begins" once the integration branch has been materialized, and
 * `merge()` is what materializes it. So a run that interleaved merging with
 * running would not merely produce a surprising ref; it would make the last
 * slices in the schedule uncommittable. Run everything, then reconcile.
 */
export interface SliceRunner {
  run(input: SliceRunInput): Promise<SliceResult>;
}
