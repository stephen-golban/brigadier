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
  AnyWorker,
  CancelReason,
  Slice,
  SpawnedWorker,
  WorkerEvent,
  WorkerOutcome,
  WorkerSpec,
} from "../contracts.js";
import type {
  AnyQuotaOracle,
  ClaudeQuotaOracle,
  ClaudeQuotaWorkerEvent,
  QuotaWorkerEvent,
} from "../quota/contracts.js";
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
  SliceAttempt,
  SliceFailure,
  SliceResult,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "./contracts.js";
import { interruptMessage } from "./contracts.js";
import { buildWorkerSpec, type SpecBuildInput } from "./spec.js";

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
   * specifically that attempt 2 carries attempt 1's `(vendor, model)` in
   * `excluded` and sets `escalated`. Asserting that through the real router
   * would only show a different model came back, which is the same observation
   * a wrong request could produce by accident.
   */
  readonly route?: (
    request: RoutingRequest,
    input: RoutingInput,
  ) => RoutingDecision;
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
    }
  | {
      readonly ok: false;
      readonly failure: SliceFailure;
      readonly outcome: WorkerOutcome | null;
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

  constructor(options: SliceRunnerOptions) {
    this.#ports = options.ports;
    this.#env = options.env;
    this.#route = options.route ?? defaultRoute;
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
      // slice's only retry. Spending it on a failure the vendor itself calls
      // permanent — bad credentials, a denied permission, a refusal, an
      // unknown model — buys a slower report of the same answer.
      if (!isRetryable(attempt.record.failure)) {
        this.#ports.log(
          `slice ${sliceId} attempt ${index + 1}: not retrying a failure the worker reported as permanent`,
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
          failure: cancellationFailure(
            input.signal,
            `slice ${sliceId} attempt ${attempt} was cancelled before it was routed`,
          ),
          durationMs: elapsed(),
        },
      };
    }

    const decision = this.#routeAttempt(input, attempt, excluded);
    if (!decision.ok) {
      // On attempt 2 this is the expected "nothing stronger is available"
      // answer, not an error condition. It is recorded and the slice stops.
      this.#ports.log(
        `slice ${sliceId} attempt ${attempt}: routing failed (${decision.reason}): ${decision.message}`,
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
        failure,
        durationMs: elapsed(),
      },
    };
  }

  #routeAttempt(
    input: SliceRunInput,
    attempt: number,
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
      ...(attempt > 1 ? { escalated: true } : {}),
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
        failure: {
          kind: "WORKTREE_FAILED",
          message: `slice ${sliceId} attempt ${attempt}: ${contained.message}`,
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
        failure: {
          kind: "WORKER_FAILED",
          message: `slice ${sliceId} attempt ${attempt}: ${routed.vendor}/${routed.model} failed with ${outcome.failure.kind}: ${outcome.failure.message}`,
          failure: outcome.failure,
        },
      };
    }

    try {
      const result = await this.#ports.engine.commit({
        worktree: created,
        message: commitMessage(input.slice, attempt, routed),
      });
      return { ok: true, commit: result.commit, outcome };
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
    const oracle = claudeOracle(this.#ports.oracles);
    let consumed = 0;
    try {
      for await (const event of events) {
        consumed += 1;
        if (event.type !== "quota") {
          continue;
        }
        if (oracle === null || !isClaudeQuotaEvent(event)) {
          continue;
        }
        try {
          oracle.ingest(event);
        } catch (error) {
          this.#ports.log(
            `ignored a failure from the claude quota oracle: ${describeError(error)}`,
          );
        }
      }
    } catch (error) {
      return { consumed, error };
    }
    return { consumed, error: null };
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

/** What `raceAbort` resolves when the signal wins. */
const ABORTED = Symbol("aborted");
const CANCELLATION_COMPLETION_BOUND_MS = 100;
const COMPLETION_TIMEOUT = Symbol("completion timeout");

/**
 * `work`'s value, or `ABORTED` the moment the signal fires — whichever is first.
 *
 * THE LISTENER IS REMOVED IN A `finally`, AND THAT IS NOT TIDINESS. One signal
 * is shared by every slice in the run, so a listener left behind by each
 * finished slice accumulates on a single `AbortSignal` for the whole run; Node
 * warns at eleven and the leak is real regardless.
 *
 * `work` is not cancelled when the abort wins — nothing here could cancel it —
 * so every caller must hand in a promise that cannot reject. An abandoned
 * promise that rejects has no `await` left to catch it and becomes an unhandled
 * rejection at some unrelated later moment.
 */
async function raceAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    return ABORTED;
  }
  let onAbort: (() => void) | null = null;
  const interrupted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Settled<T> | typeof COMPLETION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof COMPLETION_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(COMPLETION_TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([settle(promise), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

/**
 * Launch a spec on an adapter without a type assertion.
 *
 * `workerFor` is typed `(vendor: Vendor) => AnyWorker | null`, which does not
 * correlate the vendor asked for with the adapter returned, so a mismatch is
 * representable and has to be handled rather than cast away. The throw is
 * caught by the caller and becomes a `LAUNCH_FAILURE`.
 */
async function spawnWorker(
  worker: AnyWorker,
  spec: WorkerSpec,
): Promise<SpawnedWorker> {
  if (worker.vendor === "claude") {
    if (spec.vendor !== "claude") {
      throw new Error(
        `vendor mismatch: a claude adapter cannot launch a ${spec.vendor} spec`,
      );
    }
    return worker.spawn(spec);
  }
  if (spec.vendor !== "codex") {
    throw new Error(
      `vendor mismatch: a codex adapter cannot launch a ${spec.vendor} spec`,
    );
  }
  return worker.spawn(spec);
}

function isClaudeQuotaEvent(
  event: QuotaWorkerEvent,
): event is ClaudeQuotaWorkerEvent {
  return event.snapshot.vendor === "claude";
}

function claudeOracle(
  oracles: readonly AnyQuotaOracle[],
): ClaudeQuotaOracle | null {
  for (const oracle of oracles) {
    // Only Claude's oracle is push-based. `typeof` guards a hand-rolled oracle
    // that claims the vendor without implementing the push half.
    if (oracle.vendor === "claude" && typeof oracle.ingest === "function") {
      return oracle;
    }
  }
  return null;
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
 * The other members stay retryable on purpose, and each for a reason that is
 * specific rather than optimistic. `ROUTING_FAILED` on attempt 1 is re-asked
 * with `escalated: true`, which is the only thing that unlocks `xhigh`, so the
 * second ask genuinely differs from the first. `WORKTREE_FAILED` is retried
 * into a DIFFERENT slot — a different path and a different branch — so the
 * condition that caused it may simply not exist there. `NO_CHANGES` and
 * `COMMIT_FAILED` describe a worker that did the wrong thing, which is the case
 * escalation exists for.
 */
function isRetryable(failure: SliceFailure | null): boolean {
  if (failure === null) {
    return true;
  }
  if (failure.kind === "WORKER_FAILED") {
    return failure.failure.retryable;
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
      return { kind: "WORKTREE_FAILED", message };
    case "WORKER_FAILED":
      return { kind: "WORKER_FAILED", message, failure: failure.failure };
    case "NO_CHANGES":
      return { kind: "NO_CHANGES", message };
    case "COMMIT_FAILED":
      return { kind: "COMMIT_FAILED", message };
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
