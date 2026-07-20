import type { PreferenceExtractionApplyResult } from '../music-agent/preference-extraction.js';
import { recordPreferenceExtractionFailure } from '../music-agent/preference-extraction.js';
import {
  claimPreferenceExtractionBatch,
  listFairDuePreferenceExtractionBatches,
  releasePreferenceExtractionBatch,
  type PreferenceExtractionBatch,
  type PreferenceExtractionSourceClass
} from '../store/preference-extraction-batches.js';

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type PreferenceExtractionWorkerResult =
  | 'idle'
  | 'preempted'
  | 'completed'
  | 'retry';

export type PreferenceExtractionWorker = {
  runOnce(): Promise<PreferenceExtractionWorkerResult>;
  start(): void;
  stop(): Promise<void>;
  preempt(): void;
};

export function createPreferenceExtractionWorker(input: {
  processBatch(
    batch: PreferenceExtractionBatch,
    signal: AbortSignal
  ): Promise<PreferenceExtractionApplyResult>;
  isForegroundLlmBusy?: () => boolean;
  now?: () => Date;
  pollMs?: number;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): PreferenceExtractionWorker {
  const now = input.now ?? (() => new Date());
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const leaseMs = timeoutMs + Math.max(1_000, Math.ceil(timeoutMs / 2));
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let controller: AbortController | null = null;
  let active: Promise<void> | null = null;
  let resolveActive: (() => void) | null = null;
  let nextSourceClass: PreferenceExtractionSourceClass = 'current';
  const lastUserBySourceClass: Record<PreferenceExtractionSourceClass, string | null> = {
    current: null,
    legacy: null
  };

  const nextBatch = (): PreferenceExtractionBatch | null => {
    const sourceClasses: PreferenceExtractionSourceClass[] = [
      nextSourceClass,
      nextSourceClass === 'current' ? 'legacy' : 'current'
    ];
    for (const sourceClass of sourceClasses) {
      const batch = listFairDuePreferenceExtractionBatches({
        sourceClass,
        afterUserId: lastUserBySourceClass[sourceClass],
        now: now(),
        limit: 1
      })[0];
      if (!batch) continue;
      lastUserBySourceClass[sourceClass] = batch.userId;
      nextSourceClass = sourceClass === 'current' ? 'legacy' : 'current';
      return batch;
    }
    return null;
  };

  const runOnce = async (): Promise<PreferenceExtractionWorkerResult> => {
    if (running || input.isForegroundLlmBusy?.()) return 'preempted';
    const batch = nextBatch();
    if (!batch) return 'idle';
    const claimed = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: now(),
      leaseMs
    });
    if (!claimed?.leaseToken) return 'preempted';

    running = true;
    active = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => {
      activeController.abort('preference_extraction_timeout');
    }, timeoutMs);
    timeout.unref();
    try {
      if (input.isForegroundLlmBusy?.()) {
        releasePreferenceExtractionBatch({
          userId: claimed.userId,
          id: claimed.id,
          leaseToken: claimed.leaseToken,
          releasedAt: now().toISOString()
        });
        return 'preempted';
      }
      const result = await Promise.race([
        input.processBatch(claimed, activeController.signal),
        aborted(activeController.signal)
      ]);
      if (result.status === 'stale_attempt') return 'preempted';
      return result.status === 'retryable' ? 'retry' : 'completed';
    } catch (error) {
      if (!activeController.signal.aborted) {
        recordPreferenceExtractionFailure({
          userId: claimed.userId,
          batchId: claimed.id,
          leaseToken: claimed.leaseToken,
          errorCode: 'transport_error',
          attemptedAt: now().toISOString()
        });
        throw error;
      }
      if (activeController.signal.reason === 'preference_extraction_timeout') {
        recordPreferenceExtractionFailure({
          userId: claimed.userId,
          batchId: claimed.id,
          leaseToken: claimed.leaseToken,
          errorCode: 'timeout',
          attemptedAt: now().toISOString()
        });
        return 'retry';
      }
      releasePreferenceExtractionBatch({
        userId: claimed.userId,
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        releasedAt: now().toISOString()
      });
      return 'preempted';
    } finally {
      clearTimeout(timeout);
      controller = null;
      running = false;
      resolveActive?.();
      resolveActive = null;
      active = null;
    }
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
      const waitForActive = active;
      controller?.abort('preference_extraction_worker_stopped');
      await waitForActive;
    },
    preempt() {
      controller?.abort('foreground_llm_busy');
    }
  };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAborted = () => {
      const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'preference_extraction_aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) rejectAborted();
    else signal.addEventListener('abort', rejectAborted, { once: true });
  });
}
