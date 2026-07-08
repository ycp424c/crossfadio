import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import type { QueueTrack } from '../store/queue.js';
import { appendDjEvent, type DjEventRecord } from '../store/dj-events.js';
import type { DjContextSnapshot } from './context.js';
import { defaultDJAgentQueuePort, type DJAgentQueuePort } from './ports.js';

export function appendSelectionStartedEvent(input: {
  userId: string;
  runId: string;
  targetPickCount: number;
  snapshot: DjContextSnapshot;
}): DjEventRecord {
  return appendDjEvent({
    userId: input.userId,
    type: 'selection_started',
    correlationId: input.runId,
    runId: input.runId,
    payload: {
      trigger: 'auto_fill',
      targetCount: input.targetPickCount,
      activeDirective: truncate(input.snapshot.musicSelectionContext.activeDirective, 800) || undefined
    }
  });
}

export function appendMusicAgentSelectionEvents(input: {
  userId: string;
  runId: string;
  output: MusicAgentRunOutput;
  queueBeforeLength: number;
  selectionStartedEventId: string;
  queuePort?: DJAgentQueuePort;
}): void {
  if (input.output.status !== 'ok') return;

  const queuePort = input.queuePort ?? defaultDJAgentQueuePort;
  const queue = queuePort.getQueue(input.userId);
  const appendedTracks = queue.slice(input.queueBeforeLength);
  if (appendedTracks.length === 0) return;

  const picksById = new Map(input.output.picks.map((pick) => [pick.id, pick]));
  const selectionEvents = appendedTracks.map((track, index) => {
    const pick = picksById.get(track.ncmId);
    return appendDjEvent({
      userId: input.userId,
      type: 'track_selected',
      correlationId: input.runId,
      causationEventId: input.selectionStartedEventId,
      runId: input.runId,
      trackId: track.ncmId,
      payload: {
        trackId: track.ncmId,
        trackName: track.name || pick?.name || track.ncmId,
        artist: formatQueueArtist(track) || pick?.artist,
        selectionRationale: truncate(pick?.reason || input.output.say || 'Selected by MusicAgent.', 1000),
        batchRationale: truncate(input.output.say, 1000) || undefined,
        source: pick?.source,
        pickOrder: index + 1
      }
    });
  });

  appendDjEvent({
    userId: input.userId,
    type: 'queue_changed',
    correlationId: input.runId,
    causationEventId: selectionEvents[selectionEvents.length - 1]?.id ?? input.selectionStartedEventId,
    runId: input.runId,
    payload: {
      action: 'append',
      trackIds: appendedTracks.map((track) => track.ncmId),
      position: 'end',
      afterQueuePreview: queue.slice(0, 12).map(toQueuePreview)
    }
  });
}

function toQueuePreview(track: QueueTrack): { id: string; name?: string; artist?: string } {
  return {
    id: track.ncmId,
    ...(track.name ? { name: track.name } : {}),
    ...(formatQueueArtist(track) ? { artist: formatQueueArtist(track) } : {})
  };
}

function formatQueueArtist(track: QueueTrack): string | undefined {
  return track.artists?.length ? track.artists.join(' / ') : undefined;
}

function truncate(value: string | undefined, maxLength: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}
