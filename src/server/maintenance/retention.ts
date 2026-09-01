import {
  cleanupExpiredListeningEpisodes,
  cleanupStaleListeningEpisodes
} from '../store/listening-episodes.js';
import { cleanupAllExpiredPersonalDjContexts } from '../store/personal-dj-context.js';
import { cleanupDjEvents } from '../store/dj-events.js';
import { cleanupSelectionJourneys } from '../store/selection-journeys.js';
import { deleteExpiredRetrievalAttempts } from '../store/retrieval-attempts.js';
import { cleanupSelectionDebugTraces } from '../store/selection-debug-traces.js';
import { cleanupExpiredInferredPreferenceEvidence } from '../store/preference-evidence.js';
import { cleanupSelectionNarrationOutbox } from '../store/selection-narration-outbox.js';
import { cleanupSelectionReplay } from '../store/selection-replay.js';
import { deleteExpiredSourceReservoir } from '../store/source-reservoir.js';

const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60_000;

export type RetentionMaintenanceResult = {
  expiredEpisodes: number;
  staleEpisodes: number;
  personalDjContexts: number;
  djEvents: number;
  selectionJourneys: number;
  retrievalAttempts: number;
  sourceReservoir: number;
  debugTraces: number;
  inferredPreferenceEvidence: number;
  narrationOutbox: number;
  selectionReplay: number;
};

export function runRetentionMaintenance(now: Date = new Date()): RetentionMaintenanceResult {
  // Delete 90-day-old open episodes before the 24-hour stale finalizer refreshes their timestamp.
  const expiredEpisodes = cleanupExpiredListeningEpisodes(now);
  const staleEpisodes = cleanupStaleListeningEpisodes(now);
  return {
    expiredEpisodes,
    staleEpisodes,
    personalDjContexts: cleanupAllExpiredPersonalDjContexts(now),
    djEvents: cleanupDjEvents(now),
    selectionJourneys: cleanupSelectionJourneys(now.toISOString()),
    retrievalAttempts: deleteExpiredRetrievalAttempts(now),
    sourceReservoir: deleteExpiredSourceReservoir(now),
    debugTraces: cleanupSelectionDebugTraces(now),
    inferredPreferenceEvidence: cleanupExpiredInferredPreferenceEvidence(now),
    narrationOutbox: cleanupSelectionNarrationOutbox(now),
    selectionReplay: cleanupSelectionReplay(now.toISOString())
  };
}

export function startRetentionMaintenance(input: {
  intervalMs?: number;
  run?: () => unknown | Promise<unknown>;
  onError?: (error: unknown) => void;
} = {}): { stop(): void } {
  const run = input.run ?? (() => runRetentionMaintenance());
  let running = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    try {
      const result = run();
      if (isPromiseLike(result)) {
        void result.catch(input.onError ?? (() => undefined)).finally(() => {
          running = false;
        });
      } else {
        running = false;
      }
    } catch (error) {
      running = false;
      input.onError?.(error);
    }
  };

  tick();
  const timer = setInterval(tick, input.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}
