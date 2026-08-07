import type { CancelReason, LaunchedWorkerOutcome } from "../contracts.ts";
import {
  type DetachedProcess,
  shutdownProcessGroup,
} from "../shared/process.ts";

export interface WorkerLifecycleOptions {
  readonly processHandle: DetachedProcess;
  readonly idleTimeoutMs: number;
  readonly timeoutMs: number | null;
  readonly cancellationOutcome: (reason: CancelReason) => LaunchedWorkerOutcome;
  readonly unexpectedFailureOutcome: (error: unknown) => LaunchedWorkerOutcome;
  readonly shutdown?: ShutdownProcess;
}

export type ShutdownProcess = (pid: number) => Promise<void>;

/**
 * Owns the exactly-once timer, shutdown, cancellation, and settlement state
 * shared by all worker adapters.
 */
export class WorkerLifecycle {
  readonly completion: Promise<LaunchedWorkerOutcome>;

  private readonly options: WorkerLifecycleOptions;
  private readonly resolveCompletion: (outcome: LaunchedWorkerOutcome) => void;
  private idleTimer: ReturnType<typeof setTimeout>;
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private shutdownTask: Promise<void> | null = null;
  private claimed = false;
  private settled = false;

  constructor(options: WorkerLifecycleOptions) {
    this.options = options;
    let resolveCompletion: (outcome: LaunchedWorkerOutcome) => void = () => {};
    this.completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    this.resolveCompletion = resolveCompletion;

    this.idleTimer = setTimeout(() => {}, options.idleTimeoutMs);
    this.resetIdleTimer();
    if (options.timeoutMs !== null) {
      this.totalTimer = setTimeout(() => {
        void this.cancel({
          kind: "timeout",
          message: `worker exceeded ${options.timeoutMs} ms`,
        });
      }, options.timeoutMs);
      this.totalTimer.unref();
    }
  }

  resetIdleTimer = (): void => {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.cancel({
        kind: "timeout",
        message: `worker produced no output for ${this.options.idleTimeoutMs} ms`,
      });
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  };

  async cancel(reason: CancelReason): Promise<void> {
    if (!(await this.finish(this.options.cancellationOutcome(reason)))) {
      await this.completion;
    }
  }

  /** Attempts to settle after terminating the process tree. */
  async finish(outcome: LaunchedWorkerOutcome): Promise<boolean> {
    return this.finishWith(async () => outcome);
  }

  /**
   * Claims settlement before shutdown, then derives the outcome after streams
   * have reached EOF. This lets direct process exit close descendant-held
   * pipes without allowing another path to settle concurrently.
   */
  async finishWith(
    outcome: () => Promise<LaunchedWorkerOutcome>,
  ): Promise<boolean> {
    if (this.claimed) {
      return false;
    }
    this.claimed = true;

    let finalOutcome: LaunchedWorkerOutcome;
    try {
      await this.shutdown();
      finalOutcome = await outcome();
    } catch (error) {
      finalOutcome = this.options.unexpectedFailureOutcome(error);
    }
    this.settle(finalOutcome);
    return true;
  }

  private shutdown(): Promise<void> {
    const shutdown = this.options.shutdown ?? shutdownProcessGroup;
    this.shutdownTask ??= shutdown(this.options.processHandle.pid);
    return this.shutdownTask;
  }

  private settle(outcome: LaunchedWorkerOutcome): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    clearTimeout(this.idleTimer);
    if (this.totalTimer !== undefined) {
      clearTimeout(this.totalTimer);
    }
    this.options.processHandle.stdin.destroy();
    this.options.processHandle.stdout.destroy();
    this.options.processHandle.stderr.destroy();
    this.resolveCompletion(outcome);
  }
}
