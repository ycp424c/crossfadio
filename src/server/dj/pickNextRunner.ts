import type { NcmClient } from '../ncm/client.js';

export type DjPickNextEventSink = (payload: Record<string, unknown>) => void;

export type DjPickNextRunResult =
  | { status: 'already-running' }
  | { status: 'done' }
  | { status: 'timeout' };

export type RunDjPickNextInput = {
  userId: string;
  ncmClient: NcmClient;
  emit?: DjPickNextEventSink;
  signal?: AbortSignal;
  onTimeout?(event: TimeoutEvent): void;
};

export type DjPickNextRunner = {
  isRunning(userId: string): boolean;
  run(input: RunDjPickNextInput): Promise<DjPickNextRunResult>;
};

type RunPickNext = (input: {
  userId: string;
  ncmClient: NcmClient;
  emit?: DjPickNextEventSink;
  signal: AbortSignal;
}) => Promise<void>;

type TimeoutEvent = {
  userId: string;
  targetPickCount: number;
  jobTimeoutMs: number;
};

type CreateDjPickNextRunnerInput = {
  getTargetPickCount(userId: string): number;
  getJobTimeoutMs(targetPickCount: number): number;
  runPickNext: RunPickNext;
  onTimeout?(event: TimeoutEvent): void;
};

export function createDjPickNextRunner(input: CreateDjPickNextRunnerInput): DjPickNextRunner {
  const runningUsers = new Set<string>();

  return {
    isRunning(userId) {
      return runningUsers.has(userId);
    },

    async run(runInput) {
      const { userId, ncmClient, emit, signal: parentSignal } = runInput;
      if (runningUsers.has(userId)) return { status: 'already-running' };

      runningUsers.add(userId);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortFromParent: (() => void) | undefined;

      try {
        const targetPickCount = input.getTargetPickCount(userId);
        const jobTimeoutMs = input.getJobTimeoutMs(targetPickCount);
        const controller = new AbortController();
        abortFromParent = (): void => {
          controller.abort(parentSignal?.reason ?? new Error('aborted'));
        };

        if (parentSignal?.aborted) {
          abortFromParent();
        } else {
          parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        }

        const jobTimer = new Promise<'timeout'>((resolve) => {
          timeoutId = setTimeout(() => {
            controller.abort(new Error('job-timeout'));
            resolve('timeout');
          }, jobTimeoutMs);
        });

        const jobPromise = input.runPickNext({ userId, ncmClient, emit, signal: controller.signal });

        const result = await Promise.race([
          jobPromise.then(() => 'done' as const),
          jobTimer
        ]);

        if (result === 'timeout') {
          const timeoutEvent = { userId, targetPickCount, jobTimeoutMs };
          // Notify the client immediately so the UI can react. The notification
          // is strictly best-effort: a throwing callback must never skip the
          // wait for the underlying job to settle (which would release the
          // running lock and any permit held by callers early) and must never
          // turn into an unhandled rejection.
          try {
            (runInput.onTimeout ?? input.onTimeout)?.(timeoutEvent);
          } catch {
            // Notification failures are isolated — the timeout result below is
            // still delivered once the underlying job truly settles.
          }
          // The running lock (and any permit released by callers on this
          // promise) must stay held until the underlying runPickNext truly
          // settles. If the job ignores the abort, no new task may start.
          await jobPromise.catch(() => undefined);
          return { status: 'timeout' };
        }
        return { status: 'done' };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (abortFromParent) parentSignal?.removeEventListener('abort', abortFromParent);
        runningUsers.delete(userId);
      }
    }
  };
}
