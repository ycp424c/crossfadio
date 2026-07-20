import { getLogger } from '../logger.js';
import { LlmClient } from '../llm/client.js';
import { resolveLlmConfig } from '../llm/config.js';
import {
  isForegroundLlmBusy,
  registerForegroundLlmPreemptor
} from '../llm/foreground-activity.js';
import { runPreferenceExtractionBatch } from '../music-agent/preference-extraction.js';
import {
  createPreferenceExtractionWorker,
  type PreferenceExtractionWorker
} from './preference-extraction-worker.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';

type WorkerOptions = Parameters<typeof createPreferenceExtractionWorker>[0];
type WorkerLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export type PreferenceExtractionRuntime = {
  start(): void;
  stop(): Promise<void>;
};

export function createPreferenceExtractionRuntime(input: {
  createWorker?: (options: WorkerOptions) => PreferenceExtractionWorker;
  logger?: WorkerLogger;
} = {}): PreferenceExtractionRuntime {
  const worker = (input.createWorker ?? createPreferenceExtractionWorker)({
    processBatch: (batch, signal) => runPreferenceExtractionBatch({
      batch,
      signal,
      client: new LlmClient(resolveLlmConfig(batch.userId))
    }),
    isForegroundLlmBusy,
    onError(error) {
      (input.logger ?? getLogger()).warn({
        error: safeOperationalError(error, 'preference_extraction_worker_failed')
      }, 'Preference Extraction worker failed');
    }
  });
  let unregisterPreemptor: (() => void) | null = null;

  return {
    start() {
      if (unregisterPreemptor) return;
      unregisterPreemptor = registerForegroundLlmPreemptor(() => worker.preempt());
      worker.start();
    },
    async stop() {
      unregisterPreemptor?.();
      unregisterPreemptor = null;
      await worker.stop();
    }
  };
}
