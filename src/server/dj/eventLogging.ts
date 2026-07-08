import { randomUUID } from 'node:crypto';
import { appendDjEvent } from '../store/dj-events.js';
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
  batchRationale?: string;
};

type SelectedTrackEventInput = {
  id: string;
  name?: string;
  artist?: string;
  selectionRationale?: string;
  batchRationale?: string;
  source?: string;
  pickOrder: number;
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
      activeDirective: truncate(input.activeDirective, 800) || undefined,
      batchRationale: truncate(input.batchRationale, 1000) || undefined
    }
  });

  return { runId, selectionStartedEventId: event.id };
}

export function appendQueueAppendEvents(input: {
  userId: string;
  context: DjSelectionEventContext;
  tracks: SelectedTrackEventInput[];
}): void {
  if (input.tracks.length === 0) return;

  const selectionEvents = input.tracks.map((track) => appendDjEvent({
    userId: input.userId,
    type: 'track_selected',
    correlationId: input.context.runId,
    causationEventId: input.context.selectionStartedEventId,
    runId: input.context.runId,
    trackId: track.id,
    payload: {
      trackId: track.id,
      trackName: truncate(track.name, 300) || track.id,
      artist: truncate(track.artist, 300) || undefined,
      selectionRationale: truncate(track.selectionRationale, 1000) || 'Selected by Crossfadio DJ fallback.',
      batchRationale: truncate(track.batchRationale, 1000) || undefined,
      source: truncate(track.source, 80) || undefined,
      pickOrder: track.pickOrder
    }
  }));

  appendDjEvent({
    userId: input.userId,
    type: 'queue_changed',
    correlationId: input.context.runId,
    causationEventId: selectionEvents[selectionEvents.length - 1]?.id ?? input.context.selectionStartedEventId,
    runId: input.context.runId,
    payload: {
      action: 'append',
      trackIds: input.tracks.map((track) => track.id),
      position: 'end',
      afterQueuePreview: getQueue(input.userId).slice(0, 12).map(toQueuePreview)
    }
  });
}

export function queueTrackArtist(track: QueueTrack): string | undefined {
  return track.artists?.length ? track.artists.join(' / ') : undefined;
}

function toQueuePreview(track: QueueTrack): { id: string; name?: string; artist?: string } {
  return {
    id: track.ncmId,
    ...(track.name ? { name: track.name } : {}),
    ...(queueTrackArtist(track) ? { artist: queueTrackArtist(track) } : {})
  };
}

function truncate(value: string | undefined, maxLength: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}
