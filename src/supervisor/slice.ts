/**
 * One slice, from a routing decision to a commit.
 *
 * This is the only component in the codebase that drives a real subprocess and
 * a real worktree in anger. Everything it reaches for arrives through
 * `SupervisorPorts`, so a fake engine and a fake worker are enough to drive a
 * routing failure, a crashed worker, an empty diff, or a cleanup that itself
 * fails — none of which are reachable in a test that has to make them happen
 * for real.
 *
 * It never rejects. Every way a slice can end badly is a `SliceResult` with
 * `ok: false`, because a rejected promise inside a concurrent wave either takes
 * down its siblings or gets swallowed, and both are worse than a recorded
 * failure. The only price is that every stage below has to be total, which is
 * why each one is wrapped rather than allowed to propagate.
 *
 * IT IS ALSO THE ONLY PLACE THAT CAN STOP A RUNNING WORKER. Workers are spawned
 * into detached process groups, and the handle that can kill a whole group —
 * `SpawnedWorker.cancel` — exists nowhere but here, between `spawn` and the
 * awaited completion. So `SliceRunInput.signal` is checked at the two points
 * where this file is about to spend something the user has already said to stop
 * spending, and raced at the one place a slice spends most of its life:
 *
 *   1. at the top of an attempt, before it is routed — nothing has been spent
 *      yet, so an abort already in hand costs no worktree and no subprocess;
 *   2. immediately before `spawn`, the last moment before a real process
 *      exists;
 *   3. against the running worker, as a race rather than a check.
 *
 * THERE IS DELIBERATELY NO CHECK BETWEEN THE WORKTREE AND THE SPAWN. Creating
 * the worktree happens after check 1 and before check 2, unguarded, because it
 * is cheap work inside a directory this attempt tears down on every failure
 * path anyway. Check 2 is what makes that safe: it is re-read precisely because
 * routing and `create` both await, and the abort may have landed during either
 * of them. An abort at check 2 or in the race calls `cancel` and then takes the
 * ordinary failure path, so the worktree is torn down exactly as it would be
 * for any other failed attempt.
 *
 * CLEANUP THAT ITSELF FAILS IS REPORTED, NOT SWALLOWED. Killing a process group
 * and removing a worktree can both fail, and either leaves something of the
 * user's still running or still on disk. Each is appended to the attempt's
 * failure message AND carried structurally on `SliceResult.cleanupFailures`, so
 * the run's summary can say a worker may have survived instead of asserting it
 * was cancelled.
 *
 * IT IS ALSO WHERE THE CROSS-VENDOR GATE FIRES, AND THE PLACEMENT IS THE POINT.
 * Between the builder's successful `WorkerOutcome` and `engine.commit` there is
 * exactly one moment at which a slice's work exists and is still reversible for
 * free: the work is sitting uncommitted in the worktree, and the worktree is
 * about to be torn down anyway on any failure path. That moment is where a
 * model from the OTHER vendor reads what was written and either approves it or
 * rejects it. A rejection returns an ordinary failing attempt, which is what
 * makes it re-route, exclude the failing model, and escalate for free. See
 * `review.ts` for the verdict's meaning and its limits, and for why the gate
 * fails open rather than closed.
 *
 * IT ALSO OWNS ONE SAFETY PROPERTY OUTRIGHT: worktree containment. Every owned
 * path is proven against the real filesystem to land inside this attempt's
 * worktree BEFORE a worker exists to be told it may write there. See
 * `proveOwnedPathsContained` for what that proof is and what happens without
 * it; it is the only filesystem access in this file, it is read-only, and it is
 * the only reason `node:fs/promises` and `node:path` are imported here.
 */

import type { Stats } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  CancelReason,
  Slice,
  SpawnedWorker,
  WorkerEvent,
  WorkerOutcome,
  WorkerSpec,
} from "../contracts.js";
import type {
  ExcludedModel,
  RoutedWorker,
  RoutingDecision,
  RoutingInput,
  RoutingRequest,
} from "../routing/contracts.js";
import { route as defaultRoute } from "../routing/router.js";
import type { CreatedWorktree } from "../worktree/contracts.js";
import { NoChangesToCommitError } from "../worktree/engine.js";
import type {
  AttemptSlot,
  ReviewFinding,
  SliceAttempt,
  SliceFailure,
  SliceResult,
  SliceReview,
  SliceReviewer,
  SliceReviewRequest,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "./contracts.js";
import { interruptMessage } from "./contracts.js";
import { spawnWorker } from "./one-shot.js";
import { createCrossVendorReviewer } from "./review.js";
import { buildWorkerSpec, type SpecBuildInput } from "./spec.js";
import {
  ABORTED,
  COMPLETION_TIMEOUT,
  describeError,
  ingestQuotaEvent,
  raceAbort,
  settle,
  settleWithin,
} from "./support.js";

/**
 * The process environment a worker launch needs, already proven to carry the
 * variables `buildWorkerSpec` requires.
 *
 * Aliased from `SpecBuildInput` rather than restated so the two cannot drift:
 * if the spec builder ever demands a third variable, this alias acquires it and
 * every caller stops compiling, which is the correct outcome.
 */
export type LaunchEnv = SpecBuildInput["env"];

/**
 * Narrow an ambient environment record to a launchable one, or explain what is
 * missing.
 *
 * THE RUNNER NEVER READS `process.env`. It takes a `LaunchEnv` in its
 * constructor and uses exactly that, which is what keeps every test in this
 * unit a function of literals: a test that had to mutate `process.env` would
 * leak into its siblings and could never assert an absolute `HOME`. The single
 * `process.env` read in the product belongs at the CLI composition root, where
 * it is passed through this function; the function itself takes a plain record,
 * so the validation it performs — the interesting part — is testable from a
 * literal with no ambient state at all.
 *
 * It throws rather than returning a result because a machine with no `HOME`,
 * `PATH`, or `USER` cannot launch every supported worker for every slice. That
 * is a precondition of starting a run, not a per-slice outcome, and reporting it
 * as a slice failure would repeat it once per slice while hiding the one fact
 * that matters.
 */
export function requireLaunchEnv(
  env: Readonly<Record<string, string | undefined>>,
): LaunchEnv {
  const home = env.HOME;
  if (home === undefined || home === "") {
    throw new Error(
      "cannot launch a worker: HOME is missing from the environment",
    );
  }
  const path = env.PATH;
  if (path === undefined || path === "") {
    throw new Error(
      "cannot launch a worker: PATH is missing from the environment",
    );
  }
  const user = env.USER;
  if (user === undefined || user === "") {
    throw new Error(
      "cannot launch a worker: USER is missing from the environment",
    );
  }
  return { ...env, HOME: home, PATH: path, USER: user };
}

export interface SliceRunnerOptions {
  readonly ports: SupervisorPorts;
  /** Supplied by the caller; see `requireLaunchEnv` for why it is not read here. */
  readonly env: LaunchEnv;
  /**
   * The routing function. Defaults to the real router and exists as a seam only
   * so a test can assert the exact `RoutingRequest` the runner builds —
   * specifically that a retry carries a model that actually ran and failed in
   * `excluded`, and sets `escalated` only with that evidence. Asserting that
   * through the real router would only show a different model came back, which
   * is the same observation a wrong request could produce by accident.
   */
  readonly route?: (
    request: RoutingRequest,
    input: RoutingInput,
  ) => RoutingDecision;
  /**
   * The cross-vendor review gate. Defaults to the real one, which is what makes
   * the gate ON for every caller that does not opt out — including
   * `buildRunDependencies`, which constructs this runner with `{ports, env}`
   * and nothing else.
   *
   * IT IS A SEAM RATHER THAN A FLAG. A test needs to drive an approval, a
   * rejection, and every skip reason without two vendors installed and without
   * a subprocess; a caller that genuinely does not want a second opinion can
   * pass one that always skips. There is deliberately no way to configure it
   * away from the command line, because a gate that is off by default is a gate
   * that never runs.
   */
  readonly review?: SliceReviewer;
}

/** Per-attempt result, kept separate from `SliceAttempt` so a success can carry
 * the live worktree handle without `SliceAttempt` growing a field the report
 * has no use for. */
type AttemptOutcome =
  | {
      readonly ok: true;
      readonly record: SliceAttempt;
      readonly branch: string;
      readonly commit: string;
      readonly worktree: CreatedWorktree;
    }
  | {
      readonly ok: false;
      readonly record: SliceAttempt;
      /** Null only when the attempt died before a worktree existed. */
      readonly branch: string | null;
      /**
       * Whether a worker process was actually spawned for this attempt. Only a
       * model that really ran may be added to `excluded`, whose whole meaning
       * is "this exact model already failed this exact slice".
       */
      readonly workerRan: boolean;
      /** Present only when the run's signal aborted this attempt. */
      readonly cancelled?: true;
      /** See `SliceResult.cleanupFailures`; absent when nothing leaked. */
      readonly cleanupFailures?: readonly string[];
    };

/** What happened inside a created worktree. Total: it never throws. */
type WorktreeOutcome =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly outcome: WorkerOutcome;
      /**
       * The gate's verdict. Never `rejected` on this arm — a rejection returns
       * the failing arm below and never reaches `engine.commit` — but it is
       * carried on both because "approved" and "skipped, because there was no
       * second vendor" are different facts about a slice that committed, and
       * the report has to be able to say which one happened.
       */
      readonly review: SliceReview;
    }
  | {
      readonly ok: false;
      readonly failure: SliceFailure;
      readonly outcome: WorkerOutcome | null;
      /** Null on every path that died before the gate was reached. */
      readonly review: SliceReview | null;
      /** See `AttemptOutcome.workerRan`. */
      readonly workerRan: boolean;
      /** See `AttemptOutcome.cancelled`. */
      readonly cancelled?: true;
      /**
       * Set when terminating the worker's process group failed, which is the
       * one piece of cleanup this stage owns and the one thing that can leave a
       * worker alive after the run believes it is dead.
       */
      readonly cleanupFailure?: string;
    };

export class DefaultSliceRunner implements SliceRunner {
  readonly #ports: SupervisorPorts;
  readonly #env: LaunchEnv;
  readonly #route: (
    request: RoutingRequest,
    input: RoutingInput,
  ) => RoutingDecision;
  readonly #review: SliceReviewer;

  constructor(options: SliceRunnerOptions) {
    this.#ports = options.ports;
    this.#env = options.env;
    this.#route = options.route ?? defaultRoute;
    this.#review =
      options.review ??
      createCrossVendorReviewer({ ports: options.ports, env: options.env });
  }

  async run(input: SliceRunInput): Promise<SliceResult> {
    const sliceId = input.slice.id;
    const attempts: SliceAttempt[] = [];
    const excluded: ExcludedModel[] = [];
    let branch: string | null = null;
    let cancelled = false;
    // Accumulated across attempts rather than per attempt, because the run's
    // summary asks "did anything this slice touched survive", and attempt 1's
    // leaked worktree is still leaked when attempt 2 succeeds.
    const cleanupFailures: string[] = [];

    for (const [index, slot] of input.attemptSlots.entries()) {
      const attempt = await this.#runAttempt(input, slot, index + 1, excluded);
      attempts.push(attempt.record);
      if (attempt.ok) {
        return {
          sliceId,
          ok: true,
          branch: attempt.branch,
          commit: attempt.commit,
          // Live and un-removed on purpose: `engine.merge` rejects a worktree
          // that has already been removed, and merging is the orchestrator's job.
          worktree: attempt.worktree,
          ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
          attempts,
        };
      }
      if (attempt.cleanupFailures !== undefined) {
        cleanupFailures.push(...attempt.cleanupFailures);
      }
      if (attempt.branch !== null) {
        branch = attempt.branch;
      }
      if (attempt.cancelled === true) {
        // TWO THINGS HAPPEN HERE, AND ONLY ONE OF THEM IS REDUNDANT. The break
        // is belt-and-braces: `isRetryable` below already refuses a second
        // attempt, because every cancellation this file records carries a
        // `retryable: false` `WorkerFailure`. Stating it directly means a
        // cancelled slice is never retried for a reason that reads as
        // "cancelled" rather than one that depends on a flag three functions
        // away staying false.
        //
        // The flag is not redundant at all: it is the only thing that
        // distinguishes "the user stopped this" from "this slice failed" in
        // everything downstream, and nothing else in this loop can set it.
        cancelled = true;
        break;
      }
      const routed = attempt.record.routed;
      // Identity-based history: this exact pair already failed this exact
      // slice, so the escalation must not hand it back. `workerRan` is the
      // qualifier — a worktree that could not be created, or a spawn that never
      // happened, says nothing about the model, and recording it here would
      // both make the claim false and burn the one remaining attempt on a
      // model the failure never implicated.
      if (routed !== null && attempt.workerRan) {
        excluded.push({ vendor: routed.vendor, model: routed.model });
      }
      // A second attempt costs a full worktree, a full worker run, and the
      // slice's only retry. Spending it on a failure that is already known to
      // be permanent — bad credentials, a denied permission, a refusal, an
      // unknown model, an owned path that cannot be contained in any slot —
      // buys a slower report of the same answer.
      //
      // The sentence names no source because there are two: the vendor's own
      // `retryable` verdict, and this file's own proof that a refusal does not
      // depend on the slot it happened in.
      if (!isRetryable(attempt.record.failure)) {
        this.#ports.log(
          `slice ${sliceId} attempt ${index + 1}: not retrying a failure a second attempt cannot change`,
          "normal",
        );
        break;
      }
    }

    return {
      sliceId,
      ok: false,
      ...(cancelled ? { cancelled: true as const } : {}),
      ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
      branch,
      commit: null,
      worktree: null,
      attempts,
    };
  }

  async #runAttempt(
    input: SliceRunInput,
    slot: AttemptSlot,
    attempt: number,
    excluded: readonly ExcludedModel[],
  ): Promise<AttemptOutcome> {
    const startedAt = this.#ports.now();
    const elapsed = (): number => this.#ports.now() - startedAt;
    const sliceId = input.slice.id;

    // Nothing has been spent yet, so an abort already in hand costs this slice
    // a recorded attempt and no worktree, no subprocess, and no ref.
    if (input.signal?.aborted === true) {
      return {
        ok: false,
        branch: null,
        workerRan: false,
        cancelled: true,
        record: {
          attempt,
          routed: null,
          outcome: null,
          commit: null,
          review: null,
          failure: cancellationFailure(
            input.signal,
            `slice ${sliceId} attempt ${attempt} was cancelled before it was routed`,
          ),
          durationMs: elapsed(),
        },
      };
    }

    const decision = this.#routeAttempt(input, excluded);
    if (!decision.ok) {
      // On attempt 2 this is the expected "nothing stronger is available"
      // answer, not an error condition. It is recorded and the slice stops.
      this.#ports.log(
        `slice ${sliceId} attempt ${attempt}: routing failed (${decision.reason}): ${decision.message}`,
        "normal",
      );
      return {
        ok: false,
        branch: null,
        workerRan: false,
        record: {
          attempt,
          routed: null,
          outcome: null,
          commit: null,
          review: null,
          failure: {
            kind: "ROUTING_FAILED",
            message: decision.message,
            reason: decision.reason,
            // The rejection trace is the entire diagnosis; summarizing it into
            // the message would make the failure unactionable.
            rejected: decision.rejected,
          },
          durationMs: elapsed(),
        },
      };
    }
    const routed = decision.routed;
    this.#ports.log(
      `slice ${sliceId} attempt ${attempt}: routed to ${routed.vendor}/${routed.model} at ${routed.effort} effort`,
      "verbose",
    );

    let created: CreatedWorktree;
    try {
      created = await this.#ports.engine.create({
        session: input.session,
        slice: slot.sliceNumber,
        path: slot.worktreePath,
        unsafeInPlace: input.unsafeInPlace,
      });
    } catch (error) {
      return {
        ok: false,
        branch: null,
        // No worker was spawned, so this model is not implicated and must not
        // be excluded from the next attempt.
        workerRan: false,
        record: {
          attempt,
          routed,
          outcome: null,
          commit: null,
          review: null,
          failure: {
            kind: "WORKTREE_FAILED",
            message: `could not create worktree for slice ${sliceId} attempt ${attempt} at ${slot.worktreePath}: ${describeError(error)}`,
          },
          durationMs: elapsed(),
        },
      };
    }

    // `#runInWorktree` is total, and the catch below is a net for a defect in
    // it rather than an expected path. Between them, the cleanup underneath
    // always runs — which is the `finally`-shaped guarantee this attempt owes
    // the run, since a leaked worktree holds a branch ref that would make the
    // next attempt's `create` fail outright.
    let body: WorktreeOutcome;
    try {
      body = await this.#runInWorktree(input, created, routed, attempt);
    } catch (error) {
      body = {
        ok: false,
        // `#runInWorktree` is total, so reaching here means a defect rather
        // than a known stage. It is unknowable from here whether a worker
        // started, and the safe reading of an unknown is the one that does not
        // assert something false about the model.
        workerRan: false,
        outcome: null,
        review: null,
        failure: {
          kind: "WORKER_FAILED",
          message: `slice ${sliceId} attempt ${attempt} failed unexpectedly: ${describeError(error)}`,
          failure: {
            kind: "UNKNOWN_FAILURE",
            message: describeError(error),
            retryable: false,
            statusCode: null,
          },
        },
      };
    }

    if (body.ok) {
      return {
        ok: true,
        branch: created.branch,
        commit: body.commit,
        worktree: created,
        record: {
          attempt,
          routed,
          outcome: body.outcome,
          commit: body.commit,
          review: body.review,
          failure: null,
          durationMs: elapsed(),
        },
      };
    }

    // Nothing will ever be merged from a failed attempt, so the runner removes
    // it here. A failing `remove` must not overwrite the reason the attempt
    // failed — it is reported alongside it.
    const cleanupNote = await this.#removeQuietly(created);
    const failure =
      cleanupNote === null
        ? body.failure
        : appendNote(body.failure, cleanupNote);
    // A worker that would not die and a worktree that would not be removed are
    // two independent leaks, and an attempt can produce both. Ordered as they
    // happened: the cancel is attempted before the removal.
    const cleanupFailures: string[] = [];
    if (body.cleanupFailure !== undefined) {
      cleanupFailures.push(body.cleanupFailure);
    }
    if (cleanupNote !== null) {
      cleanupFailures.push(
        `slice ${sliceId} attempt ${attempt}: ${cleanupNote}`,
      );
    }
    return {
      ok: false,
      branch: created.branch,
      workerRan: body.workerRan,
      ...(body.cancelled === true ? { cancelled: true as const } : {}),
      ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
      record: {
        attempt,
        routed,
        outcome: body.outcome,
        commit: null,
        review: body.review,
        failure,
        durationMs: elapsed(),
      },
    };
  }

  #routeAttempt(
    input: SliceRunInput,
    excluded: readonly ExcludedModel[],
  ): RoutingDecision {
    const request: RoutingRequest = {
      slice: input.slice,
      difficulty: input.directive.difficulty,
      ...(input.directive.requires === undefined
        ? {}
        : { requires: input.directive.requires }),
      // Copied so the request cannot observe a later attempt's push.
      ...(excluded.length === 0 ? {} : { excluded: [...excluded] }),
      // `escalated` is the only thing that unlocks `xhigh`, and it is earned by
      // the observed failure that produced `excluded`.
      ...(excluded.length > 0 ? { escalated: true } : {}),
    };
    try {
      return this.#route(request, input.routing);
    } catch (error) {
      // `route` throws only on a structurally invalid request — a bad
      // `minContextWindowTokens` in the plan's directive. That is still a
      // failure of the routing stage, so it is reported as one rather than
      // rejecting the promise this interface promises never to reject.
      return {
        ok: false,
        reason: "NO_CAPABLE_MODEL",
        message: `routing request for slice ${input.slice.id} was rejected: ${describeError(error)}`,
        rejected: [],
      };
    }
  }

  async #runInWorktree(
    input: SliceRunInput,
    created: CreatedWorktree,
    routed: RoutedWorker,
    attempt: number,
  ): Promise<WorktreeOutcome> {
    const sliceId = input.slice.id;

    // NOTHING IS PRE-CREATED IN THE WORKTREE. The worker creates its own files:
    // `buildClaudeCommand` grants `Write(<path>)` beside `Edit(<path>)` for
    // every owned path, and both rules are consulted and enforced identically
    // (measured against claude 2.1.226 — an in-lane `Write` created a new file,
    // an out-of-lane one was denied and never reached the disk).
    //
    // THE CONTAINMENT GATE. The worktree now exists on disk, and this is the
    // last point at which its real shape can be inspected before a subprocess
    // is handed a lane rule naming these paths. Nothing below this line is
    // allowed to run until every owned path is proven to land inside it.
    const contained = await proveOwnedPathsContained(
      created.path,
      input.slice.ownedPaths,
    );
    if (!contained.ok) {
      return {
        ok: false,
        // No worker was spawned, so the model is not implicated: the refusal is
        // about the repository's shape, not about anything a model did.
        workerRan: false,
        outcome: null,
        review: null,
        failure: {
          kind: "WORKTREE_FAILED",
          message: `slice ${sliceId} attempt ${attempt}: ${contained.message}`,
          // The refusal is about the slice's owned paths and the shape of the
          // user's repository, and a retry changes neither: it moves to another
          // path under the same parent, with the same owned paths and the same
          // symbolic links. Without this marker the slice spends its second
          // slot re-deriving this exact sentence with a different attempt
          // number in it.
          deterministic: true,
        },
      };
    }

    const vendorConfig = input.routing.config.vendors.find(
      (candidate) => candidate.vendor === routed.vendor,
    );
    if (vendorConfig === undefined) {
      return launchFailure(
        `routed vendor "${routed.vendor}" has no entry in the routing config`,
      );
    }

    let spec: WorkerSpec;
    try {
      spec = buildWorkerSpec({
        slice: input.slice,
        routed,
        worktreePath: created.path,
        env: this.#env,
      });
    } catch (error) {
      return launchFailure(
        `could not build a worker spec for ${routed.vendor}/${routed.model}: ${describeError(error)}`,
      );
    }

    const worker = this.#ports.workerFor(routed.vendor);
    if (worker === null) {
      return launchFailure(
        `no worker adapter is configured for vendor "${routed.vendor}"`,
      );
    }

    // THE LAST MOMENT BEFORE A REAL PROCESS EXISTS. Everything above this line
    // is recoverable bookkeeping; below it there is a detached process group
    // burning the user's quota, so the signal is re-read here even though it was
    // read at the top of the attempt — the routing and the worktree creation
    // above both await, and the abort may have landed during either of them.
    if (input.signal?.aborted === true) {
      return {
        ok: false,
        workerRan: false,
        cancelled: true,
        outcome: null,
        review: null,
        failure: cancellationFailure(
          input.signal,
          `slice ${sliceId} attempt ${attempt} was cancelled before a ${routed.vendor}/${routed.model} worker was spawned`,
        ),
      };
    }

    let spawned: SpawnedWorker;
    try {
      spawned = await spawnWorker(worker, spec);
    } catch (error) {
      return launchFailure(
        `could not spawn a ${routed.vendor} worker for slice ${sliceId}: ${describeError(error)}`,
      );
    }

    // THE DEADLOCK THIS SHAPE EXISTS TO AVOID. An adapter's `events` iterable
    // is a producer with nowhere to put its next value until somebody pulls it,
    // and an adapter that stops reading the child's stdout stops the child. So
    // `await spawned.completion` FIRST, with nothing consuming `events`, can
    // wait forever on a worker that is itself waiting to hand over an event.
    // Both are started here and awaited together: the drain begins on this tick,
    // before anything blocks on completion. Neither promise rejects, so
    // `Promise.all` cannot abandon the other one half-run.
    const drain = this.#drainEvents(spawned.events);
    const completion: Promise<WorkerOutcome> = spawned.completion;
    // Neither half rejects, so the combined promise cannot reject either — which
    // is what makes it safe to walk away from below when the abort wins the
    // race. An abandoned promise that could reject would surface later as an
    // unhandled rejection with nothing left to catch it.
    const running = Promise.all([drain, settle(completion)]);
    const raced = await raceAbort(input.signal, running);

    if (raced === ABORTED) {
      // The one call in this codebase that reaches a detached process group.
      // Awaited rather than fired and forgotten: the worktree is removed
      // immediately after this returns, and removing a directory a live worker
      // is still writing into is how a `git worktree remove` fails and a
      // half-written tree survives the run.
      const cancelNote = await cancelQuietly(spawned, input.signal);
      const terminationDetail =
        cancelNote === null
          ? `${routed.vendor}/${routed.model} was terminated`
          : `the ${routed.vendor}/${routed.model} worker (pid ${spawned.pid ?? "none"}) may still be running — ${cancelNote}`;
      this.#ports.log(
        cancelNote === null
          ? `slice ${sliceId} attempt ${attempt}: cancelled ${routed.vendor}/${routed.model} (pid ${spawned.pid ?? "none"})`
          : `slice ${sliceId} attempt ${attempt}: ${terminationDetail}`,
        "normal",
      );
      return {
        ok: false,
        // True because a process was spawned and cancellation was attempted. It
        // does not put this model on the excluded list, because `run` breaks out
        // of the attempt loop on `cancelled` before it ever reads this — a model
        // is excluded for failing a slice, and an interrupted attempt is not a
        // model failure. Any unconfirmed termination is carried separately as a
        // cleanup failure.
        workerRan: true,
        cancelled: true,
        outcome: null,
        // The gate sits below this return, so it was never reached.
        review: null,
        // The same fact in two places on purpose: the message is what a reader
        // of THIS slice's failure sees, and `cleanupFailure` is what the run's
        // summary needs in order to stop claiming the worker was cancelled.
        ...(cancelNote === null
          ? {}
          : {
              cleanupFailure: `slice ${sliceId} attempt ${attempt}: the ${routed.vendor}/${routed.model} worker (pid ${spawned.pid ?? "none"}) may still be running — ${cancelNote}`,
            }),
        failure: cancellationFailure(
          input.signal,
          `slice ${sliceId} attempt ${attempt}: ${terminationDetail}`,
        ),
      };
    }

    const [drained, completed] = raced;

    if (drained.error !== null) {
      this.#ports.log(
        `slice ${sliceId} attempt ${attempt}: event stream ended in error after ${drained.consumed} event(s): ${describeError(drained.error)}`,
        "normal",
      );
    }

    if (!completed.ok) {
      // Out of contract: `completion` is documented to resolve with a
      // `WorkerOutcome`. Recorded rather than rethrown.
      return {
        ok: false,
        // The worker was spawned and then broke its own completion contract.
        workerRan: true,
        outcome: null,
        review: null,
        failure: {
          kind: "WORKER_FAILED",
          message: `slice ${sliceId} attempt ${attempt}: ${routed.vendor}/${routed.model} completion rejected: ${describeError(completed.error)}`,
          failure: {
            kind: "UNKNOWN_FAILURE",
            message: describeError(completed.error),
            retryable: false,
            statusCode: null,
          },
        },
      };
    }

    const outcome = completed.value;
    if (!outcome.ok) {
      return {
        ok: false,
        workerRan: true,
        outcome,
        // A worker that failed produced nothing to review. The gate judges
        // work, and there is none.
        review: null,
        failure: {
          kind: "WORKER_FAILED",
          message: `slice ${sliceId} attempt ${attempt}: ${routed.vendor}/${routed.model} failed with ${outcome.failure.kind}: ${outcome.failure.message}`,
          failure: outcome.failure,
        },
      };
    }

    // THE CROSS-VENDOR GATE. The worker succeeded and its work is sitting
    // uncommitted in `created.path`; this is the last moment at which it can be
    // rejected without leaving a commit behind, because `engine.commit` below
    // is irreversible through this engine's surface. See `review.ts` for why
    // the gate is here rather than after the commit and what that costs.
    const redact = (artifact: string): string =>
      this.#ports.engine.redact(created, artifact);
    const review = await this.#reviewQuietly({
      slice: input.slice,
      attempt,
      worktree: created,
      worktreePath: created.path,
      builder: routed,
      routing: input.routing,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    this.#ports.log(
      redact(
        `slice ${sliceId} attempt ${attempt}: review ${describeVerdict(review)}`,
      ),
      "normal",
    );
    if (review.verdict === "rejected") {
      return {
        ok: false,
        // TRUE, AND IT IS THE WHOLE MECHANISM OF GATE-FAILURE ESCALATION. A
        // model that produced work a second vendor found broken has failed this
        // slice, so it goes on `excluded` and attempt 2 is routed somewhere else
        // with `escalated: true`. Every other gate-shaped failure in this file
        // reports a worker that did not finish; this one reports work that
        // finished badly, which is the case the escalation was designed for and
        // which nothing in this product could reach until now.
        workerRan: true,
        outcome,
        review,
        failure: {
          kind: "REVIEW_REJECTED",
          message: redact(
            `slice ${sliceId} attempt ${attempt}: ${review.reviewer.vendor}/${review.reviewer.model} found ${countBlocking(review.findings)} blocking issue(s) in ${routed.vendor}/${routed.model}'s work: ${summarizeBlocking(review.findings)}`,
          ),
          review,
        },
      };
    }
    if (review.verdict === "skipped" && review.reason === "CANCELLED") {
      return {
        ok: false,
        workerRan: true,
        cancelled: true,
        outcome,
        review,
        ...(review.cleanupFailure === undefined
          ? {}
          : { cleanupFailure: review.cleanupFailure }),
        failure: cancellationFailure(
          input.signal,
          redact(
            `slice ${sliceId} attempt ${attempt} was cancelled during cross-vendor review: ${review.message}`,
          ),
        ),
      };
    }
    try {
      const result = await this.#ports.engine.commit({
        worktree: created,
        message: commitMessage(input.slice, attempt, routed),
      });
      return { ok: true, commit: result.commit, outcome, review };
    } catch (error) {
      if (error instanceof NoChangesToCommitError) {
        // `engine.commit` compares the sanitized staged tree against the parent
        // commit's tree and throws this rather than writing an empty commit. A
        // worker that exited cleanly and changed nothing has not done the
        // slice, and reporting that as success is the worst available outcome
        // because it is indistinguishable from the good one.
        return {
          ok: false,
          workerRan: true,
          outcome,
          // Carried even though the slice failed: the gate really did run, and
          // a reviewer that approved an empty change is worth seeing on the
          // report next to the reason the commit was refused.
          review,
          failure: {
            kind: "NO_CHANGES",
            message: `slice ${sliceId} attempt ${attempt}: ${routed.vendor}/${routed.model} exited cleanly but changed no file in ${created.path}`,
          },
        };
      }
      return {
        ok: false,
        workerRan: true,
        outcome,
        review,
        failure: {
          kind: "COMMIT_FAILED",
          message: `could not commit slice ${sliceId} attempt ${attempt} on ${created.branch}: ${describeError(error)}`,
        },
      };
    }
  }

  /**
   * Consume the event stream to exhaustion, feeding Claude's push-based oracle.
   *
   * Never rejects: an iterable that throws mid-stream is reported, because
   * losing the worker's outcome to a telemetry failure would be a strictly
   * worse trade. An oracle that throws is contained for the same reason — it
   * must not stop the drain and re-create the stall above.
   */
  async #drainEvents(events: AsyncIterable<WorkerEvent>): Promise<DrainReport> {
    let consumed = 0;
    try {
      for await (const event of events) {
        consumed += 1;
        ingestQuotaEvent(this.#ports.oracles, event, this.#ports.log);
      }
    } catch (error) {
      return { consumed, error };
    }
    return { consumed, error: null };
  }

  /**
   * Ask the gate, and treat a gate that broke its own contract as a skip.
   *
   * `SliceReviewer.review` is documented never to reject, so this `catch` is a
   * net for a defect in an implementation rather than an expected path. It
   * matters anyway: `#runInWorktree` is total, and a throwing reviewer reaching
   * the caller would turn a slice whose worker SUCCEEDED into an unexplained
   * `WORKER_FAILED` through the outer catch — blaming a builder for the gate's
   * bug and discarding a diff that may well have been fine.
   *
   * Skipping rather than rejecting is the same fail-open trade the rest of the
   * gate makes: a reviewer that crashed formed no opinion, and inventing a
   * rejection from its crash would be brigadier deciding the code was bad
   * because its own code was.
   */
  async #reviewQuietly(request: SliceReviewRequest): Promise<SliceReview> {
    const startedAt = this.#ports.now();
    try {
      return await this.#review.review(request);
    } catch (error) {
      const message = this.#ports.engine.redact(
        request.worktree,
        `slice ${request.slice.id} attempt ${request.attempt} was not reviewed: the reviewer threw instead of reporting: ${describeError(error)}`,
      );
      return {
        verdict: "skipped",
        reviewer: null,
        reason: "REVIEWER_FAILED",
        message,
        durationMs: this.#ports.now() - startedAt,
      };
    }
  }

  async #removeQuietly(worktree: CreatedWorktree): Promise<string | null> {
    try {
      await this.#ports.engine.remove(worktree);
      return null;
    } catch (error) {
      return `cleanup of worktree ${worktree.path} also failed: ${describeError(error)}`;
    }
  }
}

/** Convenience constructor for callers that only want the interface. */
export function createSliceRunner(options: SliceRunnerOptions): SliceRunner {
  return new DefaultSliceRunner(options);
}

// ---------------------------------------------------------------------------
// Worktree containment
// ---------------------------------------------------------------------------

type Containment =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * PROVE EVERY OWNED PATH LANDS INSIDE THIS WORKTREE, AGAINST THE REAL
 * FILESYSTEM, BEFORE A WORKER IS ALLOWED TO EXIST.
 *
 * THIS IS A SAFETY GUARD, NOT A CONVENIENCE. Isolation is the only thing the
 * worktree design buys: brigadier's whole promise is that a slice can only
 * change its own lane inside its own throwaway checkout, and that the run can
 * therefore review, merge, or discard that checkout wholesale. A write that
 * leaves the worktree breaks every part of that promise at once.
 *
 * WHAT HAPPENS WITHOUT IT — measured, not theorised. A repository containing a
 * committed symlinked directory (`src/link -> /somewhere/else`, and real
 * repositories do have `src -> ../shared/src`) is checked out into the worktree
 * with the symlink intact. A slice owning `src/link/victim.ts` is handed
 * `Write(src/link/victim.ts)`, which the vendor happily honours, and the bytes
 * land in `/somewhere/else/victim.ts` — outside the worktree, outside the
 * repository, unversioned and unrecoverable. Worse, the run does not merely
 * fail to prevent it: `git status` inside the worktree sees nothing, so
 * `engine.commit` finds an empty tree and the slice is reported as `NO_CHANGES`
 * — "exited cleanly but changed no file". The supervisor is blind to the
 * damage. This was reproduced against the compiled binary in both directions.
 *
 * LEXICAL CONTAINMENT IS NOT CONTAINMENT. `src/plan/validate.ts` already
 * rejects absolute paths, globs, control characters and `..` traversal, and
 * that is worth having, but `resolve` and `relative` are pure string arithmetic
 * that never touch a disk. `src/link/victim.ts` passes every lexical test ever
 * written. Only `realpath` can see the symlink, which is why this proof is made
 * here — the only place that holds a REAL worktree on disk, the slice's owned
 * paths, and the moment before the spawn, all three at once.
 *
 * Each owned path is resolved from its deepest EXISTING ancestor: components
 * that exist get their symlinks followed, and the still-missing tail is
 * rejoined lexically. A path that simply does not exist yet is NORMAL and is
 * not a violation — the worker creates its own files now, so most owned paths
 * are missing at this moment. Only a path whose existing components lead
 * outside is refused.
 *
 * THE ROOT IS RESOLVED TOO, AND THAT IS LOAD-BEARING. On macOS `/tmp` is a
 * symlink to `/private/tmp` and `/var` to `/private/var`, so a worktree root
 * reached through a symlink is the ordinary case, not an edge case. Comparing a
 * resolved child against an unresolved root would report an escape for every
 * legitimate path under `/tmp` — a guard that fails closed on every run is a
 * guard that gets deleted.
 *
 * IT WRITES NOTHING. `realpath` is the only filesystem call it makes. An
 * earlier version of this check lived inside the function that pre-created
 * owned paths as empty placeholders; when that subsystem was correctly deleted,
 * the containment proof went with it and nothing noticed, because no test
 * stated containment as a property in its own right. It is a free-standing,
 * separately-tested stage now precisely so that cannot happen twice.
 */
async function proveOwnedPathsContained(
  worktreePath: string,
  ownedPaths: readonly string[],
): Promise<Containment> {
  const root = resolve(worktreePath);
  const resolvedRoot = await resolveThroughExisting(root);
  if (!resolvedRoot.ok) {
    return {
      ok: false,
      message: `refusing to launch a worker into worktree root ${root}: its real path could not be resolved: ${resolvedRoot.message}`,
    };
  }
  const realRoot = resolvedRoot.path;

  for (const ownedPath of ownedPaths) {
    // Restated here rather than trusted from the plan gate three modules away:
    // this is the code that is about to declare the path writable, so it is the
    // code that has to be able to prove the claim.
    if (ownedPath === "" || ownedPath.includes("\0")) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: it is empty or contains a NUL byte`,
      };
    }
    if (isAbsolute(ownedPath)) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: it is absolute and does not belong to worktree root ${root}`,
      };
    }
    // Refused BEFORE `resolve`, because `resolve` is where the evidence is
    // destroyed. It collapses `..` lexically, so `link/../evil.ts` becomes
    // `<root>/evil.ts` and the `link` component is erased before `realpath` is
    // ever offered a chance to look at it. The proof below would then be made
    // about a path the operating system will not follow: the OS resolving
    // `link/..` walks to the parent of the SYMLINK'S TARGET, not back to the
    // root. Compared segment-wise rather than by substring so that ordinary
    // filenames like `a..b.ts` and `..hidden.ts` stay legal.
    if (ownedPath.split("/").includes("..")) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: it contains a ".." segment, which may leave worktree root ${root} through a symbolic link`,
      };
    }
    const target = resolve(root, ownedPath);
    if (escapes(root, target)) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: it resolves to ${target}, outside worktree root ${root}`,
      };
    }
    const real = await resolveThroughExisting(target);
    if (!real.ok) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: the real path of ${target} could not be resolved: ${real.message}`,
      };
    }
    if (escapes(realRoot, real.path)) {
      return {
        ok: false,
        message: `refusing to grant owned path ${JSON.stringify(ownedPath)}: an existing path component is a symbolic link leading to ${real.path}, outside worktree root ${realRoot}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Whether `target` lies outside `root`.
 *
 * The root itself counts as an escape: an owned path that IS the worktree
 * directory is not a file the worker can be granted.
 */
function escapes(root: string, target: string): boolean {
  const inside = relative(root, target);
  return (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  );
}

type ResolvedTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * Where `target` would really land: its deepest existing ancestor resolved
 * through every symlink, with the not-yet-existing tail rejoined.
 *
 * Walking up on ENOENT is what makes this usable for a file the worker has not
 * created yet, while still following a symlink in any component that does
 * exist. The missing tail is rejoined lexically because those components do not
 * exist, so no symlink can be hiding in them; whoever creates them next creates
 * real directories inside an already-proven parent.
 *
 * BUT ENOENT FROM `realpath` MEANS TWO DIFFERENT THINGS, and the whole
 * correctness of the walk turns on telling them apart. `realpath` reports
 * ENOENT both for a component that is genuinely absent and for one that EXISTS
 * as a dangling symbolic link — a link whose target is not there. Treating the
 * second as the first walks straight past a component the operating system will
 * very much act on, and rejoins its name lexically as though it were an
 * ordinary directory yet to be created. The path that comes back then looks
 * contained while describing somewhere the write will never go — or, when the
 * dangling link is the FINAL component, somewhere entirely outside the
 * worktree, because a write to a dangling link FOLLOWS it and creates the file
 * at its target. That is a real containment breach, not merely a wasted lane.
 *
 * `lstat` is what separates the two: it does not follow the final link, so it
 * succeeds on a dangling symlink exactly where `realpath` fails. A component it
 * can see is a component that exists, and an existing component this function
 * cannot resolve is a proof it cannot complete. It refuses instead.
 *
 * Any other error (ENOTDIR from a file used as a directory, ELOOP from a
 * symlink cycle) is REPORTED rather than thrown, and reporting it fails the
 * slice. A containment proof that cannot be completed is not a pass.
 */
async function resolveThroughExisting(target: string): Promise<ResolvedTarget> {
  const missing: string[] = [];
  let candidate = target;
  for (;;) {
    try {
      const real = await realpath(candidate);
      return {
        ok: true,
        path: missing.length === 0 ? real : join(real, ...missing.reverse()),
      };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return { ok: false, message: describeError(error) };
      }
      // Only a component that is genuinely absent may be walked past. One that
      // exists and still would not resolve stops the walk here.
      const unresolvable = await describeUnresolvable(candidate);
      if (unresolvable !== null) {
        return { ok: false, message: unresolvable };
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        // The filesystem root itself does not resolve. Nothing above this can
        // be checked, so refuse rather than guess.
        return {
          ok: false,
          message: `no existing ancestor of ${target} could be resolved`,
        };
      }
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Why `candidate` exists yet cannot be resolved, or `null` when it is genuinely
 * absent and the walk above may step past it.
 *
 * Reached only after `realpath` has already answered ENOENT for this exact
 * path, so `lstat` is being asked one narrow question: is there something here
 * at all? It answers yes for a dangling symbolic link and no for an absent
 * name, which is precisely the distinction `realpath` erased.
 *
 * The link's own target is read for the message rather than resolved, because
 * resolving it is the thing that just failed. It is reported verbatim — it may
 * be relative, and reading it is the only way the operator learns which link on
 * disk to repair.
 */
async function describeUnresolvable(candidate: string): Promise<string | null> {
  let entry: Stats;
  try {
    entry = await lstat(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // Nothing is here, not even a broken link. This is the ordinary case:
      // the worker has not created its file yet.
      return null;
    }
    // Something is here that cannot even be inspected. Unprovable either way,
    // so it is refused rather than assumed absent.
    return `path component ${candidate} could not be inspected: ${describeError(error)}`;
  }
  if (!entry.isSymbolicLink()) {
    return `path component ${candidate} exists but its real path could not be resolved`;
  }
  try {
    const linkTarget = await readlink(candidate);
    return `path component ${candidate} is a symbolic link to ${linkTarget}, whose target could not be resolved`;
  } catch {
    return `path component ${candidate} is a symbolic link whose target could not be resolved`;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * How long `cancelQuietly` waits for a cancelled worker's completion to settle
 * before reporting that termination could not be confirmed.
 */
const CANCELLATION_COMPLETION_BOUND_MS = 100;

/**
 * Terminates the worker's whole process group, reporting rather than throwing.
 *
 * A rejected `cancel`, a non-cancellation completion, or a completion that does
 * not settle promptly means the worker may still be running. That is exactly
 * the thing the user pressed Ctrl-C to stop, so it is said out loud in the
 * slice's failure message AND carried up as a cleanup failure, rather than
 * swallowed. It must not throw: this runs on the way to a recorded failure, and
 * losing the record to a second failure would leave the report with nothing to
 * show for the interrupt at all.
 *
 * Returns null when completion confirms cancellation, and the reason
 * termination was not confirmed otherwise.
 */
async function cancelQuietly(
  spawned: SpawnedWorker,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const reason: CancelReason = {
    kind: "shutdown",
    message: interruptMessage(signal?.reason),
  };
  try {
    await spawned.cancel(reason);
  } catch (error) {
    // Null for success rather than an empty string, so a caller that has to
    // report the failure structurally can tell the two apart without testing a
    // string for emptiness.
    return `terminating its process group failed: ${describeError(error)}`;
  }

  // WorkerLifecycle settles completion before cancel resolves. Bound this read
  // anyway: an out-of-contract adapter must not wedge shutdown indefinitely.
  const completion: Promise<WorkerOutcome> = spawned.completion;
  const completed = await settleWithin(
    completion,
    CANCELLATION_COMPLETION_BOUND_MS,
  );
  if (completed === COMPLETION_TIMEOUT) {
    return `termination was not confirmed because completion did not settle within ${CANCELLATION_COMPLETION_BOUND_MS} ms`;
  }
  if (!completed.ok) {
    return `termination was not confirmed because completion rejected: ${describeError(completed.error)}`;
  }
  if (!completed.value.ok) {
    if (completed.value.failure.kind === "CANCELLED") {
      return null;
    }
    return `termination was not confirmed because completion settled with ${completed.value.failure.kind}: ${completed.value.failure.message}`;
  }
  return "termination was not confirmed because completion settled successfully";
}

/**
 * The `SliceFailure` for an attempt an interrupt stopped.
 *
 * `WORKER_FAILED` carrying a `CANCELLED` `WorkerFailure` rather than a new
 * `SliceFailureKind`, because that is the same shape the vendor adapters
 * themselves produce for a cancellation (`cancellationFailure` in
 * `src/worker/shared.ts` returns `kind: "CANCELLED"`, `retryable: false` for a
 * `shutdown` reason). One vocabulary for "a worker was stopped on purpose",
 * whether the stop came from this file or from the adapter's own idle timer.
 *
 * `retryable: false` is what stops the attempt loop from spending the slice's
 * escalation on a run that is already shutting down.
 */
function cancellationFailure(
  signal: AbortSignal | undefined,
  detail: string,
): SliceFailure {
  const message = `${detail}: ${interruptMessage(signal?.reason)}`;
  return {
    kind: "WORKER_FAILED",
    message,
    failure: {
      kind: "CANCELLED",
      message,
      retryable: false,
      statusCode: null,
    },
  };
}

interface DrainReport {
  readonly consumed: number;
  readonly error: unknown;
}

/** The one-line form of a verdict, for the run's log. */
function describeVerdict(review: SliceReview): string {
  if (review.verdict === "skipped") {
    return `skipped (${review.reason}): ${review.message}`;
  }
  const reviewer = `${review.reviewer.vendor}/${review.reviewer.model}`;
  const blocking = countBlocking(review.findings);
  const concerns = review.findings.length - blocking;
  return `${review.verdict} by ${reviewer} (${blocking} blocking, ${concerns} concern(s)) in ${review.durationMs}ms`;
}

function countBlocking(findings: readonly ReviewFinding[]): number {
  return findings.filter((finding) => finding.severity === "blocking").length;
}

/**
 * The blocking findings as one sentence, for the failure message.
 *
 * Every blocking finding is named rather than only the first: the message is
 * what a user reads when deciding whether the gate was right, and "and 3 more"
 * makes that decision impossible without digging the structured review out of
 * the report. The concerns are deliberately absent — they did not cause this
 * failure, and they are still carried on `SliceFailure.review`.
 */
function summarizeBlocking(findings: readonly ReviewFinding[]): string {
  const blocking = findings.filter(
    (finding) => finding.severity === "blocking",
  );
  if (blocking.length === 0) {
    // Unreachable through `adjudicate`, which only rejects when at least one
    // blocking finding exists. Stated rather than asserted so a future caller
    // cannot produce an empty sentence.
    return "(no blocking finding was recorded)";
  }
  return blocking
    .map((finding) => {
      const where =
        finding.path === null
          ? ""
          : finding.line === null
            ? `${finding.path}: `
            : `${finding.path}:${finding.line}: `;
      return `${where}${finding.summary}`;
    })
    .join("; ");
}

function commitMessage(
  slice: Slice,
  attempt: number,
  routed: RoutedWorker,
): string {
  return `${slice.id}: ${slice.title}\n\nattempt ${attempt} on ${routed.vendor}/${routed.model} at ${routed.effort} effort\n`;
}

/**
 * Every caller of this is on the path between "the worktree exists" and "the
 * child process started", so no worker ran: a missing vendor entry, a spec the
 * builder refused, a missing adapter, a spawn that threw. The model is not
 * implicated by any of them, which is why `workerRan` is false here.
 */
function launchFailure(message: string): WorktreeOutcome {
  return {
    ok: false,
    workerRan: false,
    outcome: null,
    review: null,
    failure: {
      kind: "WORKER_FAILED",
      message,
      failure: {
        kind: "LAUNCH_FAILURE",
        message,
        retryable: false,
        statusCode: null,
      },
    },
  };
}

/**
 * Whether a second attempt could plausibly reach a different answer.
 *
 * `WORKER_FAILED` is the only member carrying the vendor's own verdict, and
 * that verdict is taken at face value: `AUTH_FAILURE`, `PERMISSION_DENIED`,
 * `REFUSED` and `BAD_MODEL` all arrive with `retryable: false` because the
 * cause is the operator's credentials or configuration, and no second model
 * changes either one.
 *
 * `WORKTREE_FAILED` is the one member that answers this question two different
 * ways, which is what `SliceFailure.deterministic` exists to record. A worktree
 * that could not be CREATED is retried into a DIFFERENT slot — a different path
 * and a different branch — so the condition that caused it may simply not exist
 * there, and it is retried. A refusal that `proveOwnedPathsContained` derived
 * from the slice's owned paths and the repository's symbolic links carries the
 * marker, because the next slot has the same owned paths and the same symbolic
 * links: the second attempt is guaranteed to produce the identical refusal with
 * a different attempt number in it, and the report would show a duplicate
 * failure that reads like flakiness.
 *
 * `REVIEW_REJECTED` IS THE MEMBER THIS WHOLE MECHANISM WAS BUILT FOR, and it is
 * retryable without qualification. The escalation rule — a slice that fails its
 * gate re-routes to the next model up the competence table — described a path
 * that existed here and could not be reached, because until the cross-vendor
 * gate landed nothing in this product was a gate. A rejection is the one failure
 * that is unambiguously ABOUT THE MODEL: the worker finished, produced a diff,
 * and a second vendor read it and said it was wrong. `#runInWorktree` records
 * it with `workerRan: true`, so the failing pair goes on `excluded` and the
 * second attempt is genuinely a different model at a higher rung rather than
 * the same one asked twice.
 *
 * The remaining members stay retryable under the existing policy.
 * `ROUTING_FAILED` has no routed worker to blame, so its retry carries neither
 * an exclusion nor `escalated`; this function does not broaden that routing
 * failure into evidence that a model deserves `xhigh`. `NO_CHANGES` and
 * `COMMIT_FAILED` follow a worker run, so they do produce the exclusion that
 * earns escalation.
 *
 * THE FALL-THROUGH IS DELIBERATE BUT IT IS NOT SELF-CHECKING. A member added to
 * `SliceFailure` becomes retryable here without stopping the build, because
 * this reads `kind` rather than switching exhaustively on it. That is a known
 * hazard of this function and the reason each retryable member is named above:
 * the list is the check.
 */
function isRetryable(failure: SliceFailure | null): boolean {
  if (failure === null) {
    return true;
  }
  if (failure.kind === "WORKER_FAILED") {
    return failure.failure.retryable;
  }
  if (failure.kind === "WORKTREE_FAILED") {
    return failure.deterministic !== true;
  }
  return true;
}

/**
 * Add a note to a failure without flattening the union.
 *
 * A `switch` rather than a spread because each member carries different extra
 * fields, and a new member added to `SliceFailure` must stop compiling here
 * rather than silently losing its payload.
 */
function appendNote(failure: SliceFailure, note: string): SliceFailure {
  const message = `${failure.message}; ${note}`;
  switch (failure.kind) {
    case "ROUTING_FAILED":
      return {
        kind: "ROUTING_FAILED",
        message,
        reason: failure.reason,
        rejected: failure.rejected,
      };
    case "WORKTREE_FAILED":
      // The marker is copied, not dropped. A cleanup note is appended AFTER the
      // attempt has already failed, and losing the marker here would hand
      // `isRetryable` a failure that looks retryable purely because tidying up
      // also went wrong.
      return {
        kind: "WORKTREE_FAILED",
        message,
        ...(failure.deterministic === true
          ? { deterministic: true as const }
          : {}),
      };
    case "WORKER_FAILED":
      return { kind: "WORKER_FAILED", message, failure: failure.failure };
    case "REVIEW_REJECTED":
      // The verdict is copied rather than dropped for the same reason
      // `WORKTREE_FAILED` keeps its marker: the findings are the diagnosis, and
      // losing them because tidying up also failed would leave a user with a
      // rejection they cannot evaluate.
      return { kind: "REVIEW_REJECTED", message, review: failure.review };
    case "NO_CHANGES":
      return { kind: "NO_CHANGES", message };
    case "COMMIT_FAILED":
      return { kind: "COMMIT_FAILED", message };
  }
}
