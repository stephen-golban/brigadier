/**
 * One slice, from a routing decision to a commit.
 *
 * This is the only component in the codebase that touches a real subprocess and
 * a real filesystem in anger. Everything it reaches for arrives through
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
 */

import { mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
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
          attempts,
        };
      }
      if (attempt.branch !== null) {
        branch = attempt.branch;
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
    return {
      ok: false,
      branch: created.branch,
      workerRan: body.workerRan,
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

    // `buildClaudeCommand` passes `--disallowedTools Write` unconditionally,
    // because Claude's accepted `Write(glob)` rules are not consulted and so
    // cannot enforce a worker's lane (`src/contracts.ts`). The consequence is
    // that a Claude worker can only edit files that ALREADY EXIST — and most
    // real slices add files. So the supervisor creates them, empty, before the
    // worker launches, and deletes the ones the worker never touched before the
    // commit. Fixing this in the tool list instead would trade a placeholder
    // file for a worker that can write anywhere on the machine.
    const plan = await planPlaceholders(created.path, input.slice.ownedPaths);
    if (!plan.ok) {
      return {
        ok: false,
        workerRan: false,
        outcome: null,
        failure: { kind: "WORKTREE_FAILED", message: plan.message },
      };
    }
    let placeholders: readonly string[];
    try {
      placeholders = await createPlaceholders(plan.targets);
    } catch (error) {
      return {
        ok: false,
        workerRan: false,
        outcome: null,
        failure: {
          kind: "WORKTREE_FAILED",
          message: `could not pre-create owned path(s) under ${created.path}: ${describeError(error)}`,
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
    const [drained, completed] = await Promise.all([drain, settle(completion)]);

    if (drained.error !== null) {
      this.#ports.log(
        `slice ${sliceId} attempt ${attempt}: event stream ended in error after ${drained.consumed} event(s): ${describeError(drained.error)}`,
      );
    }

    // An untouched placeholder must never reach a commit, and it must not
    // survive a failed attempt either. Doing it here covers both paths.
    const placeholderNote = await removeEmptyPlaceholders(placeholders);
    if (placeholderNote !== null) {
      this.#ports.log(
        `slice ${sliceId} attempt ${attempt}: ${placeholderNote}`,
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

type PlaceholderPlan =
  | { readonly ok: true; readonly targets: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve every owned path against the worktree root and prove it stays inside
 * — first lexically, then against the real filesystem.
 *
 * `validatePlan` already rejects absolute paths, globs, control characters and
 * traversal, and this checks again anyway: these strings are about to become
 * `mkdir` and `writeFile` arguments, and a guarantee made three modules away is
 * not something the code performing the write can verify. Every path is checked
 * before any file is created, so a refusal leaves the worktree untouched rather
 * than half-populated.
 *
 * THE LEXICAL CHECK IS NOT ENOUGH. `resolve` and `relative` are pure string
 * arithmetic; neither one touches a disk. A worktree containing an ordinary
 * symlinked directory — `src -> ../../shared/src`, which real repositories have
 * — passes both and then `writeFile` lands the placeholder in the shared
 * location, while the supervisor believes the worker is isolated. Isolation is
 * the only thing the worktree design buys, so the containment proof has to be
 * made against the filesystem the write will actually use.
 *
 * So each target is resolved through `realpath` from its deepest EXISTING
 * ancestor: components that already exist get their symlinks followed, and the
 * still-missing tail is appended lexically because `createPlaceholders` will
 * create those itself, as real directories, and a directory this code creates
 * cannot be a symlink somebody else planted. Containment is then re-proved
 * against `realpath` of the worktree root, not the given one — on macOS the
 * root normally IS reached through a symlink (`/tmp -> /private/tmp`,
 * `/var -> /private/var`), so comparing a real target against a lexical root
 * would reject every legitimate path on the platform brigadier runs on.
 */
async function planPlaceholders(
  worktreePath: string,
  ownedPaths: readonly string[],
): Promise<PlaceholderPlan> {
  const root = resolve(worktreePath);
  // The same walk as the targets, and for the same reason: the root is usually
  // reached through a symlink (`/var`, `/tmp`), and it is not always on disk
  // yet either, since `createPlaceholders` will `mkdir -p` its way down.
  const resolvedRoot = await resolveThroughExisting(root);
  if (!resolvedRoot.ok) {
    return {
      ok: false,
      message: `refusing to pre-create owned paths under worktree root ${root}: its real path could not be resolved: ${resolvedRoot.message}`,
    };
  }
  const realRoot = resolvedRoot.path;
  const targets: string[] = [];
  for (const ownedPath of ownedPaths) {
    if (ownedPath === "" || ownedPath.includes("\0")) {
      return {
        ok: false,
        message: `refusing to pre-create owned path ${JSON.stringify(ownedPath)}: it is empty or contains a NUL byte`,
      };
    }
    if (isAbsolute(ownedPath)) {
      return {
        ok: false,
        message: `refusing to pre-create owned path ${JSON.stringify(ownedPath)}: it is absolute and does not belong to worktree root ${root}`,
      };
    }
    const target = resolve(root, ownedPath);
    const inside = relative(root, target);
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    ) {
      return {
        ok: false,
        message: `refusing to pre-create owned path ${JSON.stringify(ownedPath)}: it resolves to ${target}, outside worktree root ${root}`,
      };
    }
    const real = await resolveThroughExisting(target);
    if (!real.ok) {
      return {
        ok: false,
        message: `refusing to pre-create owned path ${JSON.stringify(ownedPath)}: the real path of ${target} could not be resolved: ${real.message}`,
      };
    }
    const reallyInside = relative(realRoot, real.path);
    if (
      reallyInside === "" ||
      reallyInside === ".." ||
      reallyInside.startsWith(`..${sep}`) ||
      isAbsolute(reallyInside)
    ) {
      return {
        ok: false,
        message: `refusing to pre-create owned path ${JSON.stringify(ownedPath)}: an existing path component is a symbolic link leading to ${real.path}, outside worktree root ${realRoot}`,
      };
    }
    targets.push(target);
  }
  return { ok: true, targets };
}

type ResolvedTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * Where `target` will really land: its deepest existing ancestor resolved
 * through every symlink, with the not-yet-existing tail rejoined.
 *
 * Walking up on ENOENT is what makes this work for a file that does not exist
 * yet — the whole point of a placeholder — while still following a symlink in
 * any component that does. Any other error (ENOTDIR from a file used as a
 * directory, ELOOP from a symlink cycle) is reported rather than thrown,
 * because this runs inside a stage that owes its caller a total answer.
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
 * Create the missing ones, and report only the files this call actually made.
 *
 * The exclusive `wx` flag is what makes "missing" true at the moment of the
 * write rather than at the moment of an earlier check: a file that already
 * exists is somebody else's, and deleting it later because it happened to be
 * empty would destroy a real, intentionally empty repository file.
 */
async function createPlaceholders(
  targets: readonly string[],
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, "", { flag: "wx" });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        continue;
      }
      throw error;
    }
    created.push(target);
  }
  return created;
}

/** Delete every pre-created file the worker never wrote to. */
async function removeEmptyPlaceholders(
  placeholders: readonly string[],
): Promise<string | null> {
  const failures: string[] = [];
  for (const placeholder of placeholders) {
    try {
      const info = await stat(placeholder);
      if (!info.isFile() || info.size !== 0) {
        continue;
      }
      await unlink(placeholder);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      failures.push(`${placeholder} (${describeError(error)})`);
    }
  }
  return failures.length === 0
    ? null
    : `could not remove untouched placeholder file(s): ${failures.join(", ")}`;
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

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : null;
  }
  return null;
}
