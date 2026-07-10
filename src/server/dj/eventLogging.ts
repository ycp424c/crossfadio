import { randomUUID } from 'node:crypto';
import type { FinalSelectionResult } from './finalSelectionResult.js';
import {
  appendDjEvent,
  withDjEventTransaction
} from '../store/dj-events.js';
import { getQueue, type QueueTrack } from '../store/queue.js';

export type DjSelectionEventContext = {
  runId: string;
  selectionStartedEventId: string;
};

type SelectionStartedInput = {
  userId: string;
  targetPickCount: number;
  context?: DjSelectionEventContext;
  trigger?: 'auto_fill' | 'manual_pick_next' | 'chat_recommend' | 'system';
  activeDirective?: string;
};

type EventLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export function ensureSelectionStartedEvent(input: SelectionStartedInput): DjSelectionEventContext {
  if (input.context) return input.context;

  const runId = randomUUID();
  const event = appendDjEvent({
    userId: input.userId,
    type: 'selection_started',
    correlationId: runId,
    runId,
    payload: {
      trigger: input.trigger ?? 'auto_fill',
      targetCount: input.targetPickCount,
      activeDirective: truncate(input.activeDirective, 800) || undefined
    }
  });

  return { runId, selectionStartedEventId: event.id };
}

export function ensureSelectionStartedEventSafely(
  input: SelectionStartedInput,
  logger: EventLogger
): DjSelectionEventContext {
  try {
    return ensureSelectionStartedEvent(input);
  } catch (err) {
    const runId = input.context?.runId ?? randomUUID();
    logger.warn(
      { err, runId },
      'DJ pick-next: selection started event persistence failed'
    );
    return input.context ?? { runId, selectionStartedEventId: runId };
  }
}

export function appendFinalSelectionEvents(input: {
  userId: string;
  context: DjSelectionEventContext;
  finalSelection: FinalSelectionResult;
  queue?: QueueTrack[];
}): void {
  const finalTrackIds = input.finalSelection.tracks.map((track) => truncate(track.id, 200));
  const queue = input.queue ?? getQueue(input.userId);

  withDjEventTransaction(() => {
    const selectionEvents = input.finalSelection.tracks.map((track, index) => {
      const trackId = finalTrackIds[index] ?? truncate(track.id, 200);
      return appendDjEvent({
        userId: input.userId,
        type: 'track_selected',
        correlationId: input.context.runId,
        causationEventId: input.context.selectionStartedEventId,
        runId: input.context.runId,
        trackId,
        payload: {
          trackId,
          trackName: truncate(track.name || track.id, 300),
          ...(truncate(track.artist, 300) ? { artist: truncate(track.artist, 300) } : {}),
          selectionRationale: truncate(track.reason, 1000),
          batchRationale: truncate(input.finalSelection.rationale, 1000),
          source: truncate(track.source, 80),
          pickOrder: index + 1
        }
      });
    });

    const completionEvent = appendDjEvent({
      userId: input.userId,
      type: 'selection_completed',
      correlationId: input.context.runId,
      causationEventId: selectionEvents[selectionEvents.length - 1]?.id
        ?? input.context.selectionStartedEventId,
      runId: input.context.runId,
      payload: mapSelectionCompletedPayload(input.finalSelection, finalTrackIds)
    });

    appendDjEvent({
      userId: input.userId,
      type: 'queue_changed',
      correlationId: input.context.runId,
      causationEventId: completionEvent.id,
      runId: input.context.runId,
      payload: {
        action: 'append',
        trackIds: finalTrackIds,
        position: 'end',
        afterQueuePreview: queue.slice(0, 12).map(toQueuePreview)
      }
    });
  });
}

export const appendQueueAppendEvents = appendFinalSelectionEvents;

export function queueTrackArtist(track: QueueTrack): string | undefined {
  return track.artists?.length ? track.artists.join(' / ') : undefined;
}

function mapSelectionCompletedPayload(
  finalSelection: FinalSelectionResult,
  finalTrackIds: string[]
): Record<string, unknown> {
  const diagnostics = finalSelection.diagnostics;
  return {
    finalTrackIds,
    finalRationale: truncate(finalSelection.rationale, 1000),
    ...(truncate(finalSelection.proposedRationale, 1000)
      ? { proposedRationale: truncate(finalSelection.proposedRationale, 1000) }
      : {}),
    ...(diagnostics.targetCount !== undefined ? { targetCount: diagnostics.targetCount } : {}),
    ...(diagnostics.requestedPickCount !== undefined
      ? { requestedPickCount: diagnostics.requestedPickCount }
      : {}),
    appendedCount: diagnostics.appendedCount,
    ...(diagnostics.finalPickDiagnostics
      ? { finalPickDiagnostics: mapFinalPickDiagnostics(diagnostics.finalPickDiagnostics) }
      : {}),
    skippedPicks: diagnostics.skippedPicks.map((pick) => ({
      ...(truncate(pick.id, 200) ? { id: truncate(pick.id, 200) } : {}),
      ...(truncate(pick.name, 300) ? { name: truncate(pick.name, 300) } : {}),
      ...(truncate(pick.artist, 300) ? { artist: truncate(pick.artist, 300) } : {}),
      ...(truncate(pick.dedupeKey, 1000) ? { dedupeKey: truncate(pick.dedupeKey, 1000) } : {}),
      reason: pick.reason
    }))
  };
}

function mapFinalPickDiagnostics(
  diagnostics: NonNullable<FinalSelectionResult['diagnostics']['finalPickDiagnostics']>
): Record<string, number> {
  return {
    targetPickCount: diagnostics.targetPickCount,
    rawPickCount: diagnostics.rawPickCount,
    eligiblePickCount: diagnostics.eligiblePickCount,
    acceptedPickCount: diagnostics.acceptedPickCount,
    droppedPickCount: diagnostics.droppedPickCount,
    titleMotifDroppedCount: diagnostics.titleMotifDroppedCount,
    rankedBackfillCount: diagnostics.rankedBackfillCount,
    rejectedPickCount: diagnostics.rejectedPickCount,
    semanticConflictDroppedCount: diagnostics.semanticConflictDroppedCount ?? 0,
    qualityDroppedCount: diagnostics.qualityDroppedCount ?? 0,
    unassessedDroppedCount: diagnostics.unassessedDroppedCount ?? 0,
    assessmentValidationFailureCount: diagnostics.assessmentValidationFailureCount ?? 0
  };
}

function toQueuePreview(track: QueueTrack): { id: string; name?: string; artist?: string } {
  return {
    id: truncate(track.ncmId, 200),
    ...(truncate(track.name, 300) ? { name: truncate(track.name, 300) } : {}),
    ...(truncate(queueTrackArtist(track), 300)
      ? { artist: truncate(queueTrackArtist(track), 300) }
      : {})
  };
}

function truncate(value: string | undefined, maxLength: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}
