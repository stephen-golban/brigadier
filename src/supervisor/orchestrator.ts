/**
 * The run orchestrator: the top-level loop of `brigadier run`.
 *
 * It owns exactly four things — validation, scheduling, the session, and
 * reconciliation — and deliberately owns nothing else. One slice's lifecycle
 * (route, create a worktree, spawn a worker, inspect the diff, commit, retry
 * once) belongs to `SliceRunner`, which arrives injected. That split is what
 * lets scheduling be tested against a fake runner with no git and no
 * subprocess, and a slice's lifecycle be tested against a fake engine with no
 * scheduler.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN, and every step is placed where it is
 * because moving it costs the user something concrete:
 *
 *   0. validate concurrency safety  — before touching any port
 *   1. validate the plan            — before any side effect exists
 *   2. check directive coverage     — a slice with no difficulty cannot route
 *   3. read quota, route every slice— pre-flight, before any side effect exists
 *   4. prepare the session          — the first thing that writes a ref
 *   5. run the waves                — bounded concurrency, dependency-ordered
 *   6. reconcile                    — merge in a stable order, after everything
 *   7. remove surviving worktrees   — after reconcile, never before
 *
 * Steps 1 through 3 are all "fail before creating anything". Step 6 is after
 * step 5 in its entirety rather than interleaved with it, because
 * `engine.commit()` throws "slice commits are closed after integration begins"
 * the moment the first `merge()` materializes the integration branch — an
 * interleaved run would not merely produce a surprising ref, it would make the
 * last slices in the schedule uncommittable. Step 7 is after step 6 for the
 * mirror-image reason: `engine.merge()` opens with a registry lookup of the
 * worktree it is handed and rejects one that was already removed.
 *
 * A run reports rather than throws. Everything a caller could legitimately hand
 * this orchestrator comes back as a `RunReport`; the only exceptions that escape
 * are precondition violations that are bugs in the caller — a non-positive
 * `maxWorkers`, which the supervisor refuses with a `RangeError`, and a
 * structurally invalid routing request, which `route` refuses the same way.
 * That matches the convention every layer beneath this one already follows.
 */

import { basename, dirname, join } from "node:path";
import type { BrigadierConfig } from "../config/contracts.js";
import type { Capability, QuotaSnapshot, Slice } from "../contracts.js";
import type { PlanIssue } from "../plan/contracts.js";
import { validatePlan } from "../plan/validate.js";
import type { RoutingDecision, RoutingInput } from "../routing/contracts.js";
import { route } from "../routing/router.js";
import type { WorktreeSession } from "../worktree/contracts.js";
import type {
  AttemptSlot,
  RunFailureReason,
  RunReport,
  RunRequest,
  SliceAttempt,
  SliceDirective,
  SliceMergeRecord,
  SliceResult,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "./contracts.js";
import { ATTEMPT_LIMIT } from "./contracts.js";

/** The `ok: true` arm of `SliceResult`, where `worktree` and `commit` are live. */
type SucceededSlice = Extract<SliceResult, { readonly ok: true }>;

/**
 * Everything the orchestrator needs that is not part of one request.
 *
 * `config` and `capabilities` are passed rather than loaded for the same reason
 * `RoutingInput` takes them: a run's model choices must be reproducible from a
 * literal. `sliceRunner` is named rather than constructed here because the whole
 * point of the seam is that scheduling can be exercised without one.
 */
export interface RunnerDependencies {
  readonly ports: SupervisorPorts;
  readonly config: BrigadierConfig;
  readonly capabilities: readonly Capability[];
  readonly sliceRunner: SliceRunner;
}

/** The one thing a run does. Stateless across calls. */
export interface RunOrchestrator {
  run(request: RunRequest): Promise<RunReport>;
}

/**
 * Builds a run orchestrator over the supplied ports.
 *
 * The returned value holds no mutable state of its own: every counter, map, and
 * accumulator in a run is local to the `run()` call that created it. Two
 * concurrent `run()` calls on one orchestrator therefore cannot corrupt each
 * other's numbering — though they would still collide on git refs if given the
 * same slug, which is a caller's problem and not something this type can fix.
 */
export function createRunner(
  dependencies: RunnerDependencies,
): RunOrchestrator {
  return {
    run: (request: RunRequest): Promise<RunReport> =>
      executeRun(dependencies, request),
  };
}

/**
 * The attempt slots for one slice, addressed by its index in `plan.slices`.
 *
 * Numbering is `sliceIndex * ATTEMPT_LIMIT + attempt`, so slice 0 owns 1 and 2,
 * slice 1 owns 3 and 4, and so on. Every number in a run is distinct and
 * positive, which is the property that matters: the number becomes
 * `brigadier/<slug>/slice-N`, and a collision is a hard git error rather than a
 * subtle one.
 *
 * NUMBERS ADVANCE BY `ATTEMPT_LIMIT` PER SLICE AND ARE NOT CONTIGUOUS PER
 * SLICE-INDEX. THAT IS DELIBERATE — DO NOT "FIX" IT. A retry cannot reuse its
 * predecessor's number: `engine.remove()` discards the worktree directory and
 * unregisters the handle but does NOT delete the slice's branch ref (only
 * `create()`'s own error path does that, engine.ts:294), and `create()` refuses
 * any branch that already exists via `#assertBranchDoesNotExist`
 * (engine.ts:515-527, "refusing to overwrite existing branch"). Reusing a number
 * would turn every earned escalation into a `WORKTREE_FAILED`. Verified against
 * `src/worktree/engine.ts` before this allocator was written.
 *
 * Allocation is a pure function of the slice's index rather than of a shared
 * counter, so a slice's branch name never depends on scheduling order and a run
 * is reproducible from a literal.
 *
 * The path is a sibling of the repository rather than a child of it because
 * `resolveRequiredWorktreePath` (engine.ts:1466-1480) rejects any isolated
 * worktree path inside the source repository.
 */
export function allocateAttemptSlots(
  repositoryPath: string,
  slug: string,
  sliceIndex: number,
): readonly [AttemptSlot, AttemptSlot] {
  if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0) {
    throw new RangeError("sliceIndex must be a non-negative safe integer");
  }
  const root = join(
    dirname(repositoryPath),
    `${basename(repositoryPath)}-brigadier`,
    slug,
  );
  const first = sliceIndex * ATTEMPT_LIMIT + 1;
  const second = first + 1;
  return [
    { sliceNumber: first, worktreePath: join(root, `slice-${first}`) },
    { sliceNumber: second, worktreePath: join(root, `slice-${second}`) },
  ];
}

/** The first slot's number, which is what merge and cleanup order by. */
function firstSliceNumber(sliceIndex: number): number {
  return sliceIndex * ATTEMPT_LIMIT + 1;
}

interface SlicePlan {
  readonly slice: Slice;
  readonly directive: SliceDirective;
}

interface Preflight {
  readonly slice: Slice;
  readonly directive: SliceDirective;
  readonly decision: RoutingDecision;
  readonly durationMs: number;
}

/**
 * The run sequence, top to bottom. Deliberately one long function: it is a
 * single ordered narrative whose steps constrain each other, and splitting it
 * into stages would hide exactly the ordering that is the design.
 */
async function executeRun(
  dependencies: RunnerDependencies,
  request: RunRequest,
): Promise<RunReport> {
  if (!Number.isSafeInteger(request.maxWorkers) || request.maxWorkers <= 0) {
    throw new RangeError("maxWorkers must be a positive safe integer");
  }
  if (request.unsafeInPlace === true && request.maxWorkers > 1) {
    return {
      ok: false,
      slug: request.slug,
      dryRun: request.dryRun === true,
      integrationBranch: null,
      slices: [],
      merges: [],
      planIssues: [],
      failure: {
        reason: "PLAN_INVALID",
        message: `unsafeInPlace=true cannot be combined with maxWorkers=${request.maxWorkers}; isolated worktrees are what make concurrent slices safe`,
      },
      durationMs: 0,
    };
  }

  const { ports, config, capabilities, sliceRunner } = dependencies;
  const startedAt = ports.now();
  const plan = request.document.plan;
  const dryRun = request.dryRun === true;

  const finish = (fields: {
    readonly ok: boolean;
    readonly integrationBranch: string | null;
    readonly slices: readonly SliceResult[];
    readonly merges: readonly SliceMergeRecord[];
    readonly planIssues: readonly PlanIssue[];
    readonly failure: {
      readonly reason: RunFailureReason;
      readonly message: string;
    } | null;
  }): RunReport => ({
    ok: fields.ok,
    slug: request.slug,
    dryRun,
    integrationBranch: fields.integrationBranch,
    slices: fields.slices,
    merges: fields.merges,
    planIssues: fields.planIssues,
    failure: fields.failure,
    durationMs: ports.now() - startedAt,
  });

  /* ---------------------- 1. validate the plan ------------------------- */

  const validation = validatePlan(plan);
  if (!validation.ok) {
    return finish({
      ok: false,
      integrationBranch: null,
      slices: [],
      merges: [],
      planIssues: validation.issues,
      failure: {
        reason: "PLAN_INVALID",
        message: `plan ${plan.id} cannot be scheduled: ${validation.issues
          .map((issue) => issue.code)
          .join(", ")}`,
      },
    });
  }

  /* ------------------- 2. directives cover the plan --------------------- */

  const coverage = coverDirectives(plan.slices, request.document.directives);
  if (coverage.message !== null) {
    return finish({
      ok: false,
      integrationBranch: null,
      slices: [],
      merges: [],
      planIssues: [],
      failure: { reason: "PLAN_INVALID", message: coverage.message },
    });
  }

  /* --------------------- 3. pre-flight routing -------------------------- */

  // ROUTE EVERY SLICE BEFORE CREATING ANYTHING AT ALL.
  //
  // `allowDegradedRouting` defaults to false, so "no model on this machine
  // clears this slice's difficulty floor" is a normal, expected outcome rather
  // than an exotic error. Without this pre-flight, a five-slice plan whose last
  // slice cannot route would create a scratch base commit, four worktrees, four
  // subprocesses and four commits before finding out — leaving a half-populated
  // integration branch for the user to clean up. Failing before the first side
  // effect is the entire point of this step.
  //
  // THE DECISION MADE HERE IS ADVISORY, NOT BINDING, AND THE SECOND ROUTING
  // CALL IS NOT REDUNDANT. The slice runner routes again at execution time
  // because quota drains between pre-flight and spawn: a vendor that had
  // headroom when this loop ran can be exhausted by the time slice four starts,
  // and pinning the pre-flight choice would spawn a worker against a model
  // brigadier already knows is unusable. This pre-flight exists to fail fast,
  // not to pin the choice. Do not "optimize" the runner's routing call away.
  const routingInput: RoutingInput = {
    config,
    capabilities,
    quota: await readQuota(ports),
  };
  const preflights: Preflight[] = [];
  const routingFailures: string[] = [];
  for (const { slice, directive } of coverage.pairs) {
    const routeStartedAt = ports.now();
    const decision = route(
      {
        slice,
        difficulty: directive.difficulty,
        ...(directive.requires === undefined
          ? {}
          : { requires: directive.requires }),
      },
      routingInput,
    );
    preflights.push({
      slice,
      directive,
      decision,
      durationMs: ports.now() - routeStartedAt,
    });
    if (!decision.ok) {
      routingFailures.push(
        `slice ${slice.id} could not be routed: ${decision.message}`,
      );
    }
  }
  const preflightSlices = preflights.map(preflightSliceResult);

  if (routingFailures.length > 0) {
    return finish({
      ok: false,
      integrationBranch: null,
      slices: preflightSlices,
      merges: [],
      planIssues: [],
      failure: {
        reason: "PREFLIGHT_ROUTING_FAILED",
        message: routingFailures.join("; "),
      },
    });
  }

  ports.log(
    `run ${request.slug}: ${plan.slices.length} slice(s) in ${validation.waves.length} wave(s)`,
  );

  /* --------------------------- 6. dry run -------------------------------- */

  // Placed here rather than at the top because a dry run's whole product is the
  // routing decision, and the routing decision is what steps 1-3 produce. It
  // returns before `prepare`, which is the first call that writes a ref.
  if (dryRun) {
    return finish({
      ok: true,
      integrationBranch: null,
      slices: preflightSlices,
      merges: [],
      planIssues: [],
      failure: null,
    });
  }

  /* ------------------- 4. prepare the worktree session ------------------- */

  let session: WorktreeSession;
  try {
    session = await ports.engine.prepare({
      repositoryPath: request.repositoryPath,
      slug: request.slug,
      // `linkedPaths` is empty because nothing in this unit discovers secret
      // files; a later unit sources the inventory and fills it in. The consent
      // flag is already meaningful on its own — the engine refuses to link
      // anything without it — so wiring it now keeps the policy honest even
      // while the path list is empty.
      secrets: { linkedPaths: [], consentToLink: config.secretsConsent },
    });
  } catch (error) {
    return finish({
      ok: false,
      integrationBranch: null,
      slices: preflightSlices,
      merges: [],
      planIssues: [],
      failure: { reason: "PREPARE_FAILED", message: errorMessage(error) },
    });
  }

  /* ------------------------- 5. run the waves ---------------------------- */

  const byId = new Map<
    string,
    { readonly plan: SlicePlan; readonly index: number }
  >(
    coverage.pairs.map((pair, index) => [pair.slice.id, { plan: pair, index }]),
  );
  const results = new Map<string, SliceResult>();
  const survivors: SucceededSlice[] = [];
  const merges: SliceMergeRecord[] = [];
  const removalErrors: string[] = [];
  const skipped: string[] = [];
  let sliceFailed = false;
  let mergeFailure: string | null = null;
  let integrationBranch: string | null = null;

  try {
    for (const wave of validation.waves) {
      if (sliceFailed) {
        // LATER WAVES DEPEND ON EARLIER ONES BY CONSTRUCTION. Running this wave
        // would spawn workers against prerequisites that were never produced,
        // burning quota to generate diffs written against a tree that does not
        // exist. Slices already in flight are left to finish rather than
        // killed: they are independent of the failure by definition, their work
        // is already paid for, and a half-killed worker leaves a dirty worktree.
        skipped.push(...wave);
        continue;
      }
      const waveResults = await runBounded(
        wave,
        request.maxWorkers,
        async (sliceId): Promise<SliceResult> => {
          const startedSliceAt = ports.now();
          try {
            const entry = byId.get(sliceId);
            if (entry === undefined) {
              throw new Error(`wave named unknown slice ${sliceId}`);
            }
            const input: SliceRunInput = {
              slice: entry.plan.slice,
              directive: entry.plan.directive,
              session,
              attemptSlots: allocateAttemptSlots(
                request.repositoryPath,
                request.slug,
                entry.index,
              ),
              routing: routingInput,
              unsafeInPlace: request.unsafeInPlace === true,
            };
            return await sliceRunner.run(input);
          } catch (error) {
            // `SliceRunner` is documented never to reject, but a rejection is
            // still reachable through a defective implementation, and letting it
            // escape would take down its siblings inside `Promise.all`. Recorded
            // as a failure instead. Nothing is leaked by not removing a worktree
            // here: a runner that threw returned no handle, so there is nothing
            // this orchestrator could remove.
            return runnerThrewResult(
              sliceId,
              error,
              ports.now() - startedSliceAt,
            );
          }
        },
      );
      for (const result of waveResults) {
        results.set(result.sliceId, result);
        if (result.ok) {
          survivors.push(result);
        } else {
          sliceFailed = true;
        }
        ports.log(sliceLogLine(result));
      }
    }
    if (skipped.length > 0) {
      ports.log(
        `wave stopped: skipping ${skipped.length} slice(s) ${skipped.join(", ")}`,
      );
    }

    /* --------------------------- 6. reconcile ---------------------------- */

    // MERGE IN `sliceNumber` ORDER, NEVER COMPLETION ORDER. Completion order is
    // a function of how long each worker happened to take, so an integration
    // history keyed to it is not reproducible and two identical runs produce
    // two different first-parent chains.
    const ordered = [...survivors].sort(
      (a, b) => sliceNumberOf(byId, a.sliceId) - sliceNumberOf(byId, b.sliceId),
    );
    for (const result of ordered) {
      let merged: SliceMergeRecord | null = null;
      try {
        merged = {
          sliceId: result.sliceId,
          result: await ports.engine.merge({ worktree: result.worktree }),
        };
      } catch (error) {
        // A merge is not supposed to throw — a conflict is a returned value.
        // Recorded as a run failure and skipped rather than propagated, so the
        // remaining slices still get their chance and cleanup still runs.
        const message = `merge ${result.sliceId}: error ${errorMessage(error)}`;
        ports.log(message);
        mergeFailure ??= message;
      }
      if (merged === null) {
        continue;
      }
      merges.push(merged);
      integrationBranch ??= merged.result.integrationBranch;
      ports.log(`merge ${result.sliceId}: ${merged.result.status}`);
      if (merged.result.status === "conflicted") {
        // KEEP MERGING. Stopping at the first conflict hides how much of the run
        // was salvageable, and it is safe to continue: the engine returns
        // `conflicted` straight out of `git merge-tree` (engine.ts:425-435)
        // without reaching `#commitTree` or the `update-ref` that advances the
        // integration ref, so a conflicting merge leaves that ref exactly where
        // it was. Verified against `src/worktree/engine.ts` merge().
        mergeFailure ??= `slice ${result.sliceId} conflicts with the integration branch`;
      }
    }
  } finally {
    /* ------------------------- 7. remove worktrees ------------------------ */

    // AFTER RECONCILIATION, NEVER BEFORE. `engine.merge()` opens with
    // `#worktreeState(spec.worktree)` (engine.ts:397, 505-513) and rejects a
    // worktree that was already removed with "worktree was not created by this
    // engine or has already been removed". The type system cannot catch this
    // one: a removed `CreatedWorktree` is still a perfectly well-typed value.
    //
    // In a `finally` so the removals happen even when a slice throws or a merge
    // fails, and each removal in its own `try` so one failure does not abandon
    // the rest. A removal failure leaves a directory behind; it does not
    // invalidate merges that already landed, so it is logged rather than
    // promoted to a run failure.
    const cleanupOrder = [...survivors].sort(
      (a, b) => sliceNumberOf(byId, a.sliceId) - sliceNumberOf(byId, b.sliceId),
    );
    for (const result of cleanupOrder) {
      try {
        await ports.engine.remove(result.worktree);
      } catch (error) {
        const message = `cleanup ${result.sliceId}: ${errorMessage(error)}`;
        removalErrors.push(message);
        ports.log(message);
      }
    }
  }

  const slices = plan.slices.map(
    (slice) => results.get(slice.id) ?? notAttemptedResult(slice.id),
  );

  // SLICE FAILURE OUTRANKS MERGE CONFLICT. `RunFailureReason` is ordered by how
  // early a stage can happen, and the earlier stage is the more fundamental
  // problem: work that was never produced has to be dealt with before work that
  // was produced and could not be combined. Both are still fully visible — the
  // failed slices in `slices`, every merge in `merges`.
  const failedIds = slices
    .filter((result) => !result.ok)
    .map((result) => result.sliceId);
  const failure =
    failedIds.length > 0
      ? {
          reason: "SLICE_FAILED" as const,
          message: `${failedIds.length} slice(s) did not complete: ${failedIds.join(", ")}`,
        }
      : mergeFailure !== null
        ? { reason: "MERGE_CONFLICT" as const, message: mergeFailure }
        : null;

  return finish({
    ok: failure === null,
    integrationBranch,
    slices,
    merges,
    planIssues: [],
    failure,
  });
}

/**
 * A bounded worker pool over `items`, with results in INPUT order.
 *
 * This is a real pool rather than `Promise.all` over everything: `limit`
 * workers share one cursor, each taking the next index and awaiting its task
 * before taking another, so at most `limit` tasks are ever in flight. The
 * cursor is advanced synchronously before the first `await`, which is what
 * makes the hand-out race-free on a single-threaded event loop.
 *
 * Results come back in input order so a run's report does not depend on which
 * worker happened to finish first. `run` is required never to reject; every
 * caller in this file wraps its task accordingly, because one rejection inside
 * `Promise.all` would abandon the siblings mid-flight.
 *
 * `validatePlan` returns dependency waves at their full structural width. This
 * pool is therefore the supervisor's only concurrency throttle: it starts the
 * next member as soon as one slot is free without adding barriers inside a
 * wave. It remains exported so that scheduling code can reuse the same bound.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const slots = new Array<R | undefined>(items.length).fill(undefined);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          const item = items[index];
          if (item === undefined) {
            continue;
          }
          slots[index] = await run(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
  const settled: R[] = [];
  for (const value of slots) {
    if (value !== undefined) {
      settled.push(value);
    }
  }
  return settled;
}

/**
 * Reads every oracle's quota snapshot, tolerating the ones that fail.
 *
 * A quota probe runs a vendor CLI, so it can fail for reasons that have nothing
 * to do with the run — an unreadable credential file, a CLI mid-upgrade. Losing
 * one vendor's snapshot makes the router treat that vendor as unconstrained,
 * which at worst costs one slice a retry after the worker itself reports the
 * limit. Failing the whole run over it would cost the user everything.
 */
async function readQuota(
  ports: SupervisorPorts,
): Promise<readonly QuotaSnapshot[]> {
  const settled = await Promise.allSettled(
    ports.oracles.map((oracle) => oracle.snapshot()),
  );
  const snapshots: QuotaSnapshot[] = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      snapshots.push(outcome.value);
    } else {
      const vendor = ports.oracles[index]?.vendor ?? "unknown";
      ports.log(
        `quota ${vendor}: unavailable (${errorMessage(outcome.reason)})`,
      );
    }
  }
  return snapshots;
}

interface DirectiveCoverage {
  readonly pairs: readonly SlicePlan[];
  /** Null when the directives cover the plan's slice ids exactly. */
  readonly message: string | null;
}

/**
 * Pairs each slice with its directive, refusing anything but an exact cover.
 *
 * A missing directive is not a cosmetic gap: `RoutingRequest` requires a
 * `difficulty`, so a slice without one cannot be routed at all and would fail
 * mid-run after its predecessors had already created refs. An unexpected or
 * duplicated directive is refused for the same reason `PlanDocument`'s comment
 * warns about — the two sequences are aligned by `sliceId` alone, and a
 * hand-built document that misaligns them is exactly the defect this check
 * exists to catch, at the one moment when catching it is free.
 */
function coverDirectives(
  slices: readonly Slice[],
  directives: readonly SliceDirective[],
): DirectiveCoverage {
  const byId = new Map<string, SliceDirective>();
  const duplicates: string[] = [];
  for (const directive of directives) {
    if (byId.has(directive.sliceId)) {
      if (!duplicates.includes(directive.sliceId)) {
        duplicates.push(directive.sliceId);
      }
    } else {
      byId.set(directive.sliceId, directive);
    }
  }

  const pairs: SlicePlan[] = [];
  const missing: string[] = [];
  const planIds = new Set<string>();
  for (const slice of slices) {
    planIds.add(slice.id);
    const directive = byId.get(slice.id);
    if (directive === undefined) {
      missing.push(slice.id);
    } else {
      pairs.push({ slice, directive });
    }
  }
  const unexpected = [...byId.keys()].filter((id) => !planIds.has(id));

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing directives for: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    parts.push(`unexpected directives for: ${unexpected.join(", ")}`);
  }
  if (duplicates.length > 0) {
    parts.push(`duplicate directives for: ${duplicates.join(", ")}`);
  }
  return {
    pairs,
    message:
      parts.length === 0
        ? null
        : `plan document directives must cover the plan's slices exactly: ${parts.join("; ")}`,
  };
}

/**
 * The `SliceResult` for a slice that was routed but never run.
 *
 * This is the shape a dry run and a pre-flight failure both report, and it is
 * always the `ok: false` arm, because the `ok: true` arm demands a commit and a
 * live worktree that a routing-only pass has not produced. A CALLER MUST READ
 * `RunReport.dryRun` RATHER THAN THESE FLAGS: a successful dry run is a report
 * with `ok: true` whose every slice is `ok: false`, which is confusing exactly
 * once and is still better than a union that lets a routed-only slice claim a
 * commit it does not have.
 *
 * The attempt carries `failure: null` with `outcome: null` on the routed path —
 * nothing failed and nothing ran — and a `ROUTING_FAILED` failure carrying the
 * router's own `rejected` list on the other, because "brigadier could not route
 * this" is useless without "and here is everything it looked at".
 */
function preflightSliceResult(preflight: Preflight): SliceResult {
  const attempt: SliceAttempt = preflight.decision.ok
    ? {
        attempt: 1,
        routed: preflight.decision.routed,
        outcome: null,
        commit: null,
        failure: null,
        durationMs: preflight.durationMs,
      }
    : {
        attempt: 1,
        routed: null,
        outcome: null,
        commit: null,
        failure: {
          kind: "ROUTING_FAILED",
          message: preflight.decision.message,
          reason: preflight.decision.reason,
          rejected: preflight.decision.rejected,
        },
        durationMs: preflight.durationMs,
      };
  return {
    sliceId: preflight.slice.id,
    ok: false,
    branch: null,
    commit: null,
    worktree: null,
    attempts: [attempt],
  };
}

/**
 * The `SliceResult` for a slice a stopped wave never reached.
 *
 * An empty `attempts` array is the encoding, and it is exact: `attempts` is the
 * evidence of what was tried, and nothing was. There is no other member of the
 * union that says this without also claiming something untrue.
 */
function notAttemptedResult(sliceId: string): SliceResult {
  return {
    sliceId,
    ok: false,
    branch: null,
    commit: null,
    worktree: null,
    attempts: [],
  };
}

/** The `SliceResult` for a runner that rejected instead of reporting. */
function runnerThrewResult(
  sliceId: string,
  error: unknown,
  durationMs: number,
): SliceResult {
  const message = `slice runner threw for ${sliceId}: ${errorMessage(error)}`;
  return {
    sliceId,
    ok: false,
    branch: null,
    commit: null,
    worktree: null,
    attempts: [
      {
        attempt: 1,
        routed: null,
        outcome: null,
        commit: null,
        failure: {
          kind: "WORKER_FAILED",
          message,
          failure: {
            kind: "UNKNOWN_FAILURE",
            message,
            retryable: false,
            statusCode: null,
          },
        },
        durationMs,
      },
    ],
  };
}

function sliceNumberOf(
  byId: ReadonlyMap<string, { readonly index: number }>,
  sliceId: string,
): number {
  const entry = byId.get(sliceId);
  return entry === undefined
    ? Number.MAX_SAFE_INTEGER
    : firstSliceNumber(entry.index);
}

function sliceLogLine(result: SliceResult): string {
  if (result.ok) {
    return `slice ${result.sliceId}: ok ${result.branch} ${result.commit}`;
  }
  const kind = result.attempts.at(-1)?.failure?.kind ?? "NOT_ATTEMPTED";
  return `slice ${result.sliceId}: failed ${kind}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
