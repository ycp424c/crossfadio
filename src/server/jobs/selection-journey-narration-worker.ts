import type {
  SelectionDecisionTrace,
  SelectionJourneySnapshot,
  SelectionJourneySseEvent
} from '../../shared/selection.js';
import {
  narrateSelectionJourney,
  type SelectionJourneyNarrationClient,
  type SelectionNarrationEntity
} from '../dj/selection-journey-narrator.js';
import {
  completeSelectionJourneyNarration,
  completePersistedSelectionJourneyNarration,
  failSelectionJourneyNarrationTerminal,
  getLatestSelectionJourney,
  getSelectionJourney,
  type SelectionJourneyRecord
} from '../store/selection-journeys.js';
import {
  claimNextSelectionNarration,
  discardExpiredSelectionNarration,
  discardSelectionNarration,
  failSelectionNarration,
  getSelectionNarration,
  listExpiredSelectionNarrations,
  releaseSelectionNarration,
  selectionNarrationExpirationCode,
  selectionNarrationFailureIsTerminal,
  type SelectionNarrationFailureCode,
  type SelectionNarrationRecord
} from '../store/selection-narration-outbox.js';
import { LlmError } from '../llm/client.js';

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
const NARRATION_DEADLINE_MS = 24 * 60 * 60_000;
const NARRATION_ATTEMPT_TIMEOUT_REASON = 'narration_attempt_timeout';

export type SelectionNarrationContext = {
  userId: string;
  trace: SelectionDecisionTrace;
  djPersona: string;
  toneTags: string[];
  entityWhitelist: SelectionNarrationEntity[];
};

export type SelectionNarrationWorkerResult =
  | 'idle'
  | 'preempted'
  | 'completed'
  | 'retry'
  | 'dead'
  | 'stale';

export type SelectionJourneyNarrationWorker = {
  runOnce(): Promise<SelectionNarrationWorkerResult>;
  start(): void;
  stop(): Promise<void>;
  preempt(): void;
};

export function createSelectionJourneyNarrationWorker(input: {
  client?: SelectionJourneyNarrationClient;
  loadContext(
    record: SelectionNarrationRecord,
    journey: SelectionJourneyRecord
  ): Promise<SelectionNarrationContext> | SelectionNarrationContext;
  narrate?: (input: SelectionNarrationContext & {
    journey: SelectionJourneySnapshot;
    signal: AbortSignal;
  }) => Promise<string>;
  publish?: (
    userId: string,
    event: SelectionJourneySseEvent
  ) => Promise<void> | void;
  isForegroundLlmBusy?: () => boolean;
  now?: () => Date;
  leaseMs?: number;
  attemptTimeoutMs?: number;
  pollMs?: number;
  onError?: (error: unknown) => void;
}): SelectionJourneyNarrationWorker {
  if (!input.narrate && !input.client) {
    throw new Error('selection_narration_client_required');
  }
  const now = input.now ?? (() => new Date());
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const attemptTimeoutMs = Math.max(
    1,
    Math.min(input.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, Math.max(1, leaseMs - 1_000))
  );
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  let activeController: AbortController | null = null;
  let activeDone: Promise<void> | null = null;
  let resolveActive: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const publishSnapshot = async (
    userId: string,
    snapshot: SelectionJourneySnapshot
  ): Promise<void> => {
    try {
      await input.publish?.(userId, { type: 'selection.journey', snapshot });
    } catch (error) {
      input.onError?.(error);
    }
  };

  const runOnce = async (): Promise<SelectionNarrationWorkerResult> => {
    if (running || input.isForegroundLlmBusy?.()) return 'preempted';
    running = true;
    activeDone = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    try {
      const claimedAt = now();
      const expired = listExpiredSelectionNarrations(claimedAt);
      for (const record of expired) {
        const errorCode = selectionNarrationExpirationCode(record, claimedAt);
        if (!errorCode) continue;
        try {
          const current = currentJourneyFor(record);
          if (!current || current.snapshot.narration.status !== 'pending') {
            discardExpiredSelectionNarration({
              record,
              reason: 'narration_journey_stale',
              now: claimedAt
            });
            continue;
          }
          const saved = failJourneyNarrationIfCurrent(record, claimedAt, errorCode, 'expiration');
          if (saved) await publishSnapshot(record.userId, saved.snapshot);
        } catch (error) {
          input.onError?.(error);
        }
      }
      const record = claimNextSelectionNarration({ now: claimedAt, leaseMs });
      if (!record) return expired.length > 0 ? 'dead' : 'idle';

      const journey = currentJourneyFor(record);
      if (!journey) {
        discardSelectionNarration({
          id: record.id,
          leaseUntil: record.leaseUntil!,
          reason: 'narration_journey_stale',
          now: now()
        });
        return 'stale';
      }

      if (journey.snapshot.narration.status === 'polished') {
        const saved = completePersistedSelectionJourneyNarration({
          outboxId: record.id,
          journeyId: record.journeyId,
          userId: record.userId,
          runId: record.runId,
          journeyVersion: record.journeyVersion,
          factsHash: record.factsHash,
          leaseUntil: record.leaseUntil!,
          expectedRevision: journey.snapshot.revision,
          completedAt: now()
        });
        if (!saved) return 'stale';
        await publishSnapshot(record.userId, saved.snapshot);
        return 'completed';
      }

      if (input.isForegroundLlmBusy?.()) {
        releaseSelectionNarration({ id: record.id, leaseUntil: record.leaseUntil!, now: now() });
        return 'preempted';
      }

      const controller = new AbortController();
      activeController = controller;
      try {
        const attempt = (async (): Promise<string> => {
          const context = await input.loadContext(record, journey);
          if (input.isForegroundLlmBusy?.()) controller.abort('foreground_llm_busy');
          if (controller.signal.aborted) throw abortError();
          return input.narrate
            ? input.narrate({ ...context, journey: journey.snapshot, signal: controller.signal })
            : narrateSelectionJourney({
                client: input.client!,
                journey: journey.snapshot,
                ...context,
                signal: controller.signal
              });
        })();
        const text = await waitForNarrationAttempt(attempt, controller, attemptTimeoutMs);
        if (controller.signal.aborted) throw abortError();

        const current = currentJourneyFor(record);
        const lease = getSelectionNarration(record.id);
        const finishedAt = now();
        const deadlineExceeded = finishedAt.getTime() - Date.parse(record.createdAt) >= NARRATION_DEADLINE_MS;
        if (deadlineExceeded) {
          const saved = failJourneyNarrationIfCurrent(
            record,
            finishedAt,
            'narration_deadline_exceeded',
            'expiration'
          );
          if (!saved) return 'stale';
          await publishSnapshot(record.userId, saved.snapshot);
          return 'dead';
        }
        if (
          !current
          || lease?.status !== 'processing'
          || lease.leaseUntil !== record.leaseUntil
          || Date.parse(record.leaseUntil!) <= finishedAt.getTime()
        ) {
          discardSelectionNarration({
            id: record.id,
            leaseUntil: record.leaseUntil!,
            reason: 'narration_result_stale',
            now: finishedAt
          });
          return 'stale';
        }

        const saved = completeSelectionJourneyNarration({
          outboxId: record.id,
          journeyId: record.journeyId,
          userId: record.userId,
          runId: record.runId,
          journeyVersion: record.journeyVersion,
          factsHash: record.factsHash,
          leaseUntil: record.leaseUntil!,
          expectedRevision: current.snapshot.revision,
          snapshot: {
            ...current.snapshot,
            revision: current.snapshot.revision + 1,
            updatedAt: finishedAt.toISOString(),
            narration: { status: 'polished', text }
          },
          completedAt: finishedAt
        });
        if (!saved) return 'stale';
        await publishSnapshot(record.userId, saved.snapshot);
        return 'completed';
      } catch (error) {
        const attemptTimedOut = isNarrationAttemptTimeout(error, controller.signal);
        if (controller.signal.aborted && !attemptTimedOut) {
          releaseSelectionNarration({
            id: record.id,
            leaseUntil: record.leaseUntil!,
            now: now()
          });
          return 'preempted';
        }
        const failedAt = now();
        const errorCode = attemptTimedOut ? 'narration_timeout' : narrationErrorCode(error);
        const expirationCode = selectionNarrationExpirationCode(record, failedAt);
        if (expirationCode || selectionNarrationFailureIsTerminal(record)) {
          const saved = failJourneyNarrationIfCurrent(
            record,
            failedAt,
            expirationCode ?? errorCode,
            expirationCode ? 'expiration' : 'failure'
          );
          if (!saved) return 'stale';
          await publishSnapshot(record.userId, saved.snapshot);
          return 'dead';
        }
        const failed = failSelectionNarration({
          id: record.id,
          leaseUntil: record.leaseUntil!,
          errorCode,
          now: failedAt
        });
        return 'retry';
      } finally {
        if (activeController === controller) activeController = null;
      }
    } finally {
      running = false;
      resolveActive?.();
      resolveActive = null;
      activeDone = null;
    }
  };

  const failJourneyNarrationIfCurrent = (
    record: SelectionNarrationRecord,
    failedAt: Date,
    errorCode: SelectionNarrationFailureCode,
    terminalCause: 'failure' | 'expiration'
  ): SelectionJourneyRecord | null => {
    const current = currentJourneyFor(record);
    if (!current || current.snapshot.narration.status !== 'pending') return null;
    return failSelectionJourneyNarrationTerminal({
      outboxId: record.id,
      journeyId: record.journeyId,
      userId: record.userId,
      runId: record.runId,
      journeyVersion: record.journeyVersion,
      factsHash: record.factsHash,
      expectedOutboxStatus: record.status === 'processing' ? 'processing' : 'pending',
      expectedAttemptCount: record.attemptCount,
      expectedLeaseUntil: record.leaseUntil,
      expectedRevision: current.snapshot.revision,
      errorCode,
      terminalCause,
      failedAt,
      snapshot: {
        ...current.snapshot,
        revision: current.snapshot.revision + 1,
        updatedAt: failedAt.toISOString(),
        narration: { status: 'failed' }
      }
    });
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
      const waitForActive = activeDone;
      activeController?.abort('worker_stopped');
      await waitForActive;
    },
    preempt() {
      activeController?.abort('foreground_llm_busy');
    }
  };
}

function currentJourneyFor(record: SelectionNarrationRecord): SelectionJourneyRecord | null {
  const latest = getLatestSelectionJourney(record.userId, record.runId);
  if (
    !latest
    || latest.id !== record.journeyId
    || latest.snapshot.journeyVersion !== record.journeyVersion
    || latest.factsHash !== record.factsHash
  ) return null;
  return getSelectionJourney(record.userId, record.runId, record.journeyVersion);
}

const KNOWN_NARRATION_FAILURE_CODES = new Set<SelectionNarrationFailureCode>([
  'invalid_narration_text',
  'invalid_narration_plan',
  'narration_entity_not_whitelisted',
  'narration_reason_not_in_trace',
  'narration_selection_not_in_trace',
  'narration_trace_run_mismatch',
  'selection_narration_trace_missing'
]);

function narrationErrorCode(error: unknown): SelectionNarrationFailureCode {
  if (error instanceof LlmError) {
    if (error.status === 429) return 'narration_provider_rate_limited';
    if (error.status === 408 || error.status === 504) return 'narration_timeout';
    if (error.status !== undefined && error.status >= 500) return 'narration_provider_server_error';
    if (error.status !== undefined && error.status >= 400) return 'narration_provider_client_error';
    return 'narration_provider_error';
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'narration_timeout';
  }
  if (
    error instanceof Error
    && KNOWN_NARRATION_FAILURE_CODES.has(error.message as SelectionNarrationFailureCode)
  ) {
    return error.message as SelectionNarrationFailureCode;
  }
  return 'narration_failed';
}

function abortError(): Error {
  const error = new Error('selection_narration_preempted');
  error.name = 'AbortError';
  return error;
}

async function waitForNarrationAttempt<T>(
  attempt: Promise<T>,
  controller: AbortController,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(narrationTimeoutError());
      controller.abort(NARRATION_ATTEMPT_TIMEOUT_REASON);
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(controller.signal.reason === NARRATION_ATTEMPT_TIMEOUT_REASON
        ? narrationTimeoutError()
        : abortError());
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([attempt, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

function narrationTimeoutError(): DOMException {
  return new DOMException('Selection narration attempt timed out', 'TimeoutError');
}

function isNarrationAttemptTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.reason === NARRATION_ATTEMPT_TIMEOUT_REASON
    || (error instanceof DOMException && error.name === 'TimeoutError');
}
