import type { TrackIdentityResolution } from '../ncm/resolver.js';
import {
  beginExplicitExclusionResolutionAttempt,
  completeExplicitExclusionResolution,
  DEFAULT_RESOLUTION_ATTEMPT_LEASE_MS,
  expireExplicitExclusionResolutions,
  failExplicitExclusionResolution,
  listDueExplicitExclusionResolutions,
  releaseExplicitExclusionResolution,
  type ExplicitExclusionResolutionRecord
} from '../store/explicit-exclusion-resolutions.js';

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const ATTEMPT_TIMEOUT_REASON = 'explicit_exclusion_resolution_timeout';

export type ExplicitExclusionResolutionWorkerResult =
  | 'idle'
  | 'completed'
  | 'retry'
  | 'dead'
  | 'busy'
  | 'preempted';

export type ExplicitExclusionResolutionWorker = {
  runOnce(): Promise<ExplicitExclusionResolutionWorkerResult>;
  start(): void;
  stop(): Promise<void>;
  preempt(): void;
};

export function createExplicitExclusionResolutionWorker(input: {
  resolve(
    record: ExplicitExclusionResolutionRecord,
    signal: AbortSignal
  ): Promise<TrackIdentityResolution>;
  now?: () => Date;
  pollMs?: number;
  leaseMs?: number;
  attemptTimeoutMs?: number;
  onStatus?: (record: ExplicitExclusionResolutionRecord) => void | Promise<void>;
  onError?: (error: unknown) => void;
}): ExplicitExclusionResolutionWorker {
  const now = input.now ?? (() => new Date());
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const leaseMs = Math.max(
    2,
    Math.trunc(input.leaseMs ?? DEFAULT_RESOLUTION_ATTEMPT_LEASE_MS)
  );
  const attemptTimeoutMs = Math.max(
    1,
    Math.min(input.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, leaseMs - 1)
  );
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<ExplicitExclusionResolutionWorkerResult> | null = null;
  let activeController: AbortController | null = null;

  const performRun = async (): Promise<ExplicitExclusionResolutionWorkerResult> => {
    const expired = expireExplicitExclusionResolutions(now());
    if (expired.length > 0) {
      for (const record of expired) await input.onStatus?.(record);
      return 'dead';
    }
    const due = listDueExplicitExclusionResolutions({ now: now(), limit: 1 })[0];
    if (!due) return 'idle';
    const attempt = beginExplicitExclusionResolutionAttempt({ id: due.id, now: now(), leaseMs });
    if (!attempt) return 'busy';

    const controller = new AbortController();
    activeController = controller;
    const attemptTimeout = setTimeout(() => controller.abort(ATTEMPT_TIMEOUT_REASON), attemptTimeoutMs);
    attemptTimeout.unref();
    let resolution: TrackIdentityResolution;
    try {
      resolution = await Promise.race([
        input.resolve(attempt, controller.signal),
        aborted(controller.signal)
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === ATTEMPT_TIMEOUT_REASON) {
          const failed = failExplicitExclusionResolution({
            id: attempt.id,
            leaseToken: attempt.leaseToken!,
            errorCode: 'resolution_timeout',
            now: now()
          });
          if (failed) await input.onStatus?.(failed);
          return failed?.status === 'dead' ? 'dead' : 'retry';
        }
        releaseExplicitExclusionResolution({
          id: attempt.id,
          leaseToken: attempt.leaseToken!,
          now: now()
        });
        return 'preempted';
      }
      input.onError?.(error);
      resolution = { status: 'unavailable' };
    } finally {
      clearTimeout(attemptTimeout);
      if (activeController === controller) activeController = null;
    }
    if (resolution.status === 'resolved') {
      const completed = completeExplicitExclusionResolution({
        id: attempt.id,
        leaseToken: attempt.leaseToken!,
        track: resolution.track,
        now: now()
      });
      if (completed) await input.onStatus?.(completed);
      return completed?.status === 'succeeded' ? 'completed' : 'dead';
    }

    const failed = failExplicitExclusionResolution({
      id: attempt.id,
      leaseToken: attempt.leaseToken!,
      errorCode: `resolution_${resolution.status}`,
      now: now()
    });
    if (failed) await input.onStatus?.(failed);
    return failed?.status === 'dead' ? 'dead' : 'retry';
  };

  const runOnce = (): Promise<ExplicitExclusionResolutionWorkerResult> => {
    if (running) return Promise.resolve('busy');
    running = performRun().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch(input.onError ?? (() => undefined));
      timer = setInterval(() => {
        void runOnce().catch(input.onError ?? (() => undefined));
      }, pollMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const active = running;
      activeController?.abort('explicit_exclusion_resolution_worker_stopped');
      await active;
    },
    preempt() {
      activeController?.abort('explicit_exclusion_resolution_preempted');
    }
  };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAborted = () => {
      const error = new Error(
        typeof signal.reason === 'string' ? signal.reason : 'explicit_exclusion_resolution_aborted'
      );
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) rejectAborted();
    else signal.addEventListener('abort', rejectAborted, { once: true });
  });
}
