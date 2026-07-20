import type { SelectionJourneySseEvent } from '../../shared/selection.js';
import { narrateSelectionJourney } from '../dj/selection-journey-narrator.js';
import { broadcastToUser } from '../http/broadcast.js';
import { LlmClient } from '../llm/client.js';
import { resolveLlmConfig } from '../llm/config.js';
import {
  isForegroundLlmBusy,
  registerForegroundLlmPreemptor
} from '../llm/foreground-activity.js';
import { getLogger } from '../logger.js';
import { listDjConfigurationEntries } from '../store/dj-configuration.js';
import { getSelectionDebugTrace } from '../store/selection-debug-traces.js';
import type { SelectionJourneyRecord } from '../store/selection-journeys.js';
import type { SelectionNarrationRecord } from '../store/selection-narration-outbox.js';
import {
  createSelectionJourneyNarrationWorker,
  type SelectionJourneyNarrationWorker,
  type SelectionNarrationContext
} from './selection-journey-narration-worker.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';

type WorkerOptions = Parameters<typeof createSelectionJourneyNarrationWorker>[0];
type WorkerLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export type SelectionNarrationRuntime = {
  start(): void;
  stop(): Promise<void>;
};

export function createSelectionNarrationRuntime(input: {
  createWorker?: (options: WorkerOptions) => SelectionJourneyNarrationWorker;
  logger?: WorkerLogger;
} = {}): SelectionNarrationRuntime {
  const createWorker = input.createWorker ?? createSelectionJourneyNarrationWorker;
  const worker = createWorker({
    loadContext: loadSelectionNarrationContext,
    narrate: async ({ journey, signal, ...context }) => narrateSelectionJourney({
      client: new LlmClient(resolveLlmConfig(context.userId)),
      journey,
      trace: context.trace,
      djPersona: context.djPersona,
      toneTags: context.toneTags,
      entityWhitelist: context.entityWhitelist,
      signal
    }),
    publish: publishSelectionJourney,
    isForegroundLlmBusy,
    onError(error) {
      (input.logger ?? getLogger()).warn({
        error: safeOperationalError(error, 'selection_narration_worker_failed')
      }, 'Selection Journey narration worker failed');
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

export async function loadSelectionNarrationContext(
  record: SelectionNarrationRecord,
  journey: SelectionJourneyRecord
): Promise<SelectionNarrationContext> {
  const trace = getSelectionDebugTrace(record.userId, record.runId)?.trace;
  if (!trace) throw new Error('selection_narration_trace_missing');

  const configuration = listDjConfigurationEntries(record.userId);
  const persona = configuration.find((entry) => (
    entry.kind === 'persona' && entry.entryKey === 'default'
  ));
  const tone = configuration.find((entry) => (
    entry.kind === 'narration_tone' && entry.entryKey === 'default'
  ));

  return {
    userId: record.userId,
    trace,
    djPersona: configurationText(persona?.value) || '一位温暖、简洁、尊重用户边界的 DJ',
    toneTags: configurationStrings(tone?.value),
    entityWhitelist: journeyEntities(journey)
  };
}

function publishSelectionJourney(userId: string, event: SelectionJourneySseEvent): void {
  broadcastToUser(userId, event);
}

function configurationText(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 4_000);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim().slice(0, 4_000) : '';
}

function configurationStrings(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { tags?: unknown }).tags)
      ? (value as { tags: unknown[] }).tags
      : [];
  return [...new Set(source.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function journeyEntities(journey: SelectionJourneyRecord): SelectionNarrationContext['entityWhitelist'] {
  const entities = [
    ...journey.snapshot.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      artist: candidate.artist
    })),
    ...journey.snapshot.selections.map((selection) => ({
      id: selection.trackId,
      name: selection.trackName,
      artist: selection.artist
    }))
  ];
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()];
}
