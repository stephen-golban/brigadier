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
 *   8. release the session's refs   — after every worktree is gone
 *   9. remove the empty scaffold    — the two directories the worktrees hung
 *                                     under, and only while they are empty
 *
 * Steps 1 through 3 are all "fail before creating anything". Step 6 is after
 * step 5 in its entirety rather than interleaved with it, because
 * `engine.commit()` throws "slice commits are closed after integration begins"
 * the moment the first `merge()` materializes the integration branch — an
 * interleaved run would not merely produce a surprising ref, it would make the
 * last slices in the schedule uncommittable. Step 7 is after step 6 for the
 * mirror-image reason: `engine.merge()` opens with a registry lookup of the
 * worktree it is handed and rejects one that was already removed. Step 8 is
 * after step 7 because `engine.release()` refuses to retire refs while a
 * worktree created from the session is still active. Step 9 is last because
 * `<repo>-brigadier/<slug>` cannot be empty until every worktree beneath it has
 * been removed, and it removes nothing that is not empty.
 *
 * INTERRUPTION DOES NOT GET ITS OWN PATH THROUGH THIS SEQUENCE, and that is the
 * design rather than an omission. An aborted `RunRequest.signal` stops the run
 * from STARTING anything further — no new slice inside a wave, no later wave —
 * and the slice runner terminates the workers already in flight. Everything
 * after that is the ordinary sequence: the slices that finished are still
 * merged, every worktree is still removed, and the refs are still released.
 * A cleanup that a Ctrl-C could skip would strand exactly the worktrees and
 * refs that a Ctrl-C is most likely to create, so steps 6 through 9 sit in a
 * `finally` and run on the interrupted path, the failed path, and the happy
 * path alike.
 *
 * A run reports rather than throws. Everything a caller could legitimately hand
 * this orchestrator comes back as a `RunReport`; the only exceptions that escape
 * are precondition violations that are bugs in the caller — a non-positive
 * `maxWorkers`, which the supervisor refuses with a `RangeError`, and a
 * structurally invalid routing request, which `route` refuses the same way.
 * That matches the convention every layer beneath this one already follows.
 */

import { rmdir } from "node:fs/promises";
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
import { ATTEMPT_LIMIT, interruptMessage } from "./contracts.js";

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
  const root = scaffoldDirectories(repositoryPath, slug).slugDirectory;
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

/**
 * The two directories a run's worktree paths hang under, outermost first.
 *
 * Computed in ONE place and consumed by both the allocator above and the
 * removal below, because the removal's whole safety story is that it is
 * deleting a directory this file created. Two independent compositions of the
 * same string would let a change to one silently point the other at a directory
 * nobody here made.
 */
function scaffoldDirectories(
  repositoryPath: string,
  slug: string,
): { readonly parent: string; readonly slugDirectory: string } {
  const parent = join(
    dirname(repositoryPath),
    `${basename(repositoryPath)}-brigadier`,
  );
  return { parent, slugDirectory: join(parent, slug) };
}

/**
 * Remove the scaffold directories this run's worktrees hung under, if and only
 * if they are now empty. Returns what could not be tidied, never throws.
 *
 * WHY IT EXISTS. `allocateAttemptSlots` builds every worktree path as
 * `<repo>-brigadier/<slug>/slice-N`. The engine removes the `slice-N`
 * directories and has never owned the two above them, so every run — successful,
 * failed, and interrupted alike — used to leave an empty `<repo>-brigadier/`
 * and `<repo>-brigadier/<slug>/` sitting beside the user's repository forever.
 *
 * `rmdir` IS THE SAFETY PROPERTY, NOT AN IMPLEMENTATION DETAIL. It refuses a
 * directory that is not empty, and that refusal is the entire guarantee that
 * brigadier cannot delete a user's files by walking a path it computed: this
 * function's argument is a string composed from `repositoryPath`, and if that
 * string is ever wrong, the worst a wrong-but-empty directory costs is one
 * removed empty directory. A recursive delete here would turn the same mistake
 * into data loss, so THERE IS NO RECURSIVE DELETE IN THIS FILE and none may be
 * added to it.
 *
 * ENOTEMPTY IS THE ORDINARY ANSWER, NOT A FAILURE. It means the user put
 * something there, or a concurrent run for another slug still owns a directory
 * inside the shared parent — the exact case the parent must survive. ENOENT is
 * equally ordinary: `--unsafe-in-place` runs never create a scaffold at all,
 * and a run that failed before its first worktree never created the slug
 * directory. Anything else is reported the same way a failed `remove` is,
 * beside the run's real outcome rather than in place of it.
 *
 * ORDER MATTERS. The slug directory is removed first, because the parent cannot
 * become empty until it is gone; the parent is then attempted and will fail
 * harmlessly whenever another slug is still living in it.
 */
async function removeEmptyScaffold(
  repositoryPath: string,
  slug: string,
): Promise<readonly string[]> {
  const directories = scaffoldDirectories(repositoryPath, slug);
  const failures: string[] = [];
  for (const directory of [directories.slugDirectory, directories.parent]) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOTEMPTY" || code === "ENOENT") {
        continue;
      }
      failures.push(`scaffold ${directory}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

/** The `code` of a Node filesystem error, or null when it carries none. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

interface SlicePlan {
  readonly slice: Slice;
  readonly directive: SliceDirective;
}

interface Preflight {
  readonly slice: Slice;
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
      interrupted: request.signal?.aborted === true,
      // Nothing was created, so nothing could fail to be cleaned up.
      cleanupFailures: [],
    };
  }

  const { ports, config, capabilities, sliceRunner } = dependencies;
  const startedAt = ports.now();
  const plan = request.document.plan;
  const dryRun = request.dryRun === true;
  /**
   * Read through a function, never captured once into a boolean: the signal can
   * abort at any await in this file, so a snapshot taken at the top would be
   * stale by the time the first wave finished.
   */
  const interrupted = (): boolean => request.signal?.aborted === true;

  /**
   * Tidying this run could not finish, in the order it failed.
   *
   * Declared above `finish` rather than beside the other run-local
   * accumulators because `finish` closes over it and is called from the
   * early-return paths above them. It is READ, not merely written: every
   * report this function builds carries it, and `renderRunReport` prints it.
   * A collector nothing reads is how the previous version of this file told
   * users their worktrees were gone when they were not.
   */
  const cleanupFailures: string[] = [];

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
    // Sampled here rather than passed in by each caller, so no return path can
    // forget it and no return path can disagree with another about it.
    interrupted: interrupted(),
    // Copied rather than aliased: `finish` runs while the accumulator is still
    // in scope, and a report that kept growing after it was returned would let
    // a caller read a different answer than the one it was handed.
    cleanupFailures: [...cleanupFailures],
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

  // `prepare` is the first call that writes a ref. An abort that arrived while
  // the quota probes above were running must not be answered by creating one:
  // there is then nothing to release, nothing to remove, and nothing for the
  // user to clean up by hand.
  if (interrupted()) {
    return finish({
      ok: false,
      integrationBranch: null,
      slices: preflightSlices.map((result) =>
        cancelledResult(result.sliceId, result.attempts),
      ),
      merges: [],
      planIssues: [],
      failure: {
        reason: "SLICE_FAILED",
        message: `run interrupted before any ref was written: ${interruptMessage(request.signal?.reason)}`,
      },
    });
  }

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
  const skipped: string[] = [];
  let sliceFailed = false;
  let mergeFailure: string | null = null;
  let integrationBranch: string | null = null;

  try {
    for (const wave of validation.waves) {
      if (interrupted()) {
        // STOP STARTING WAVES. An abort can land during `prepare`, after the
        // pre-prepare check and before this first wave. This guard keeps that
        // wave from starting; it also stops later waves when dependency
        // scheduling lands. Unlike the dependency case below, the slices
        // already in flight are NOT left to finish: the runner is terminating
        // them, because the user asked for the run to stop rather than for its
        // remainder to be skipped.
        skipped.push(...wave);
        continue;
      }
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
          // STOP STARTING SLICES. The pool hands this task out the moment a
          // slot frees up, so this is the checkpoint that keeps an abort from
          // spending the freed slot on a brand new worktree and a brand new
          // subprocess. It is checked here rather than inside `runBounded` so
          // the pool stays a general-purpose scheduler with no opinion about
          // what it is scheduling.
          if (interrupted()) {
            return cancelledResult(sliceId, []);
          }
          try {
            // biome-ignore lint/style/noNonNullAssertion: `coverDirectives` and `validatePlan` derive every wave id from this exact map.
            const entry = byId.get(sliceId)!;
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
              ...(request.signal === undefined
                ? {}
                : { signal: request.signal }),
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
        // The runner owns the only handle that can kill a worker's process
        // group and the only handle to a failed attempt's worktree, so a
        // failure to do either is discovered there and reported here. It
        // reaches the run's summary the same way this orchestrator's own
        // removals do, because a user reading "workers were cancelled" has no
        // reason to care which layer failed to cancel one. Read on BOTH arms:
        // a slice whose first attempt leaked a worktree and whose second
        // attempt succeeded is `ok: true` and still leaked one.
        if (result.cleanupFailures !== undefined) {
          cleanupFailures.push(...result.cleanupFailures);
        }
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
    // invalidate merges that already landed, so it is recorded on the report
    // and logged rather than promoted to a run failure. RECORDED ON THE REPORT
    // IS THE LOAD-BEARING HALF: the log is a stream nobody can query, and the
    // summary has to be able to say a worktree survived instead of claiming it
    // was removed.
    const cleanupOrder = [...survivors].sort(
      (a, b) => sliceNumberOf(byId, a.sliceId) - sliceNumberOf(byId, b.sliceId),
    );
    for (const result of cleanupOrder) {
      try {
        await ports.engine.remove(result.worktree);
      } catch (error) {
        const message = `cleanup ${result.sliceId}: ${errorMessage(error)}`;
        cleanupFailures.push(message);
        ports.log(message);
      }
    }

    /* -------------------- 8. release the session's refs ------------------- */

    // AFTER EVERY `remove()`, AND UNCONDITIONALLY. `release` retires the
    // scratch base branch and every slice branch that survived, and it throws
    // if a worktree created from this session is still active — which is why it
    // is the last thing in this block rather than the first. It is a no-op once
    // an integration branch has been materialized, because `merge()` retired
    // those refs itself, so calling it on the happy path costs nothing and
    // calling it on the interrupted path is the only thing that stops a
    // Ctrl-C from leaving `brigadier/<slug>/base` and a pile of
    // `brigadier/<slug>/slice-N` refs behind in the user's repository.
    //
    // Wrapped for the same reason each `remove()` is: this runs while the run's
    // real outcome is already decided, and a failure to tidy up must be
    // reported beside that outcome rather than replace it or take the process
    // down. `release` throwing while worktrees are somehow still live is
    // precisely the case that would otherwise escape a `finally` and discard
    // the whole report.
    try {
      await ports.engine.release(session);
    } catch (error) {
      const message = `release ${request.slug}: ${errorMessage(error)}`;
      cleanupFailures.push(message);
      ports.log(message);
    }

    /* ------------------- 9. remove the empty scaffold --------------------- */

    // LAST, AND ONLY WHEN EMPTY. Every worktree under `<repo>-brigadier/<slug>`
    // has to be gone before that directory can be, which is why this follows
    // step 7 rather than sitting beside it; it follows step 8 as well only so
    // that a `release` failure is reported before a scaffold one, in the order
    // the run actually attempted them.
    //
    // `removeEmptyScaffold` never throws and never deletes recursively. A
    // directory the user put something into is left exactly as it is.
    for (const message of await removeEmptyScaffold(
      request.repositoryPath,
      request.slug,
    )) {
      cleanupFailures.push(message);
      ports.log(message);
    }
  }

  // A slice with no result at all was never reached. Which sentence that
  // deserves depends on why: a run stopped by an interrupt cancelled it, and a
  // run stopped by a failing predecessor never attempted it. Both are
  // `ok: false` with no attempts; only `cancelled` tells them apart.
  const slices = plan.slices.map(
    (slice) =>
      results.get(slice.id) ??
      (interrupted()
        ? cancelledResult(slice.id, [])
        : notAttemptedResult(slice.id)),
  );

  // SLICE FAILURE OUTRANKS MERGE CONFLICT. `RunFailureReason` is ordered by how
  // early a stage can happen, and the earlier stage is the more fundamental
  // problem: work that was never produced has to be dealt with before work that
  // was produced and could not be combined. Both are still fully visible — the
  // failed slices in `slices`, every merge in `merges`.
  //
  // CANCELLED SLICES ARE COUNTED SEPARATELY FROM FAILED ONES. They share the
  // `SLICE_FAILED` reason because they share its shape — work that was not
  // produced — but they must not share its sentence: telling a user that the
  // slice they interrupted "did not complete" reads as a verdict on their code.
  const failedIds = slices
    .filter((result) => !result.ok && result.cancelled !== true)
    .map((result) => result.sliceId);
  const cancelledIds = slices
    .filter((result) => !result.ok && result.cancelled === true)
    .map((result) => result.sliceId);
  const failure =
    failedIds.length > 0 || cancelledIds.length > 0
      ? {
          reason: "SLICE_FAILED" as const,
          message: describeStoppage(failedIds, cancelledIds, request.signal),
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
  const slots = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          // biome-ignore lint/style/noNonNullAssertion: the cursor claims every index below `items.length` exactly once.
          slots[index] = await run(items[index]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return slots;
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

/**
 * The `SliceResult` for a slice an interrupt stopped before the runner saw it.
 *
 * `attempts` is passed in rather than assumed empty because two different
 * moments produce this: a slice the pool never handed out, which has none, and
 * a slice the pre-flight had already routed when the abort arrived, which has
 * the routing attempt and should keep it.
 */
function cancelledResult(
  sliceId: string,
  attempts: readonly SliceAttempt[],
): SliceResult {
  return {
    sliceId,
    ok: false,
    cancelled: true,
    branch: null,
    commit: null,
    worktree: null,
    attempts,
  };
}

/**
 * The run-failure sentence, with the cancelled slices named apart from the
 * failed ones.
 *
 * The failed-only wording is byte-for-byte what this function's predecessor
 * produced, because a run with nothing cancelled must read exactly as it always
 * did — the interrupt vocabulary is an addition to the report, not a rewrite of
 * it.
 */
function describeStoppage(
  failedIds: readonly string[],
  cancelledIds: readonly string[],
  signal: AbortSignal | undefined,
): string {
  const parts: string[] = [];
  if (failedIds.length > 0) {
    parts.push(
      `${failedIds.length} slice(s) did not complete: ${failedIds.join(", ")}`,
    );
  }
  if (cancelledIds.length > 0) {
    parts.push(
      `${cancelledIds.length} slice(s) cancelled by ${interruptMessage(signal?.reason)}: ${cancelledIds.join(", ")}`,
    );
  }
  return parts.join("; ");
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
  // "failed" is a verdict on the work. A cancelled slice has not earned one.
  return result.cancelled === true
    ? `slice ${result.sliceId}: cancelled`
    : `slice ${result.sliceId}: failed ${kind}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
