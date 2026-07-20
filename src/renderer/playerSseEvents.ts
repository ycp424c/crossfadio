import {
  selectionDecisionTraceSchema,
  selectionJourneySnapshotSchema,
  selectionJourneySseEventSchema,
  type QueueTrackDto,
  type SelectionDecisionTrace,
  type SelectionJourneySnapshot
} from '@shared/schema';

export type PlayerPersistentSseEvent =
  | {
      type: 'connected';
      queue: QueueTrackDto[];
      currentIndex: number;
      revision: number;
      journeys: SelectionJourneySnapshot[];
      data: Record<string, unknown>;
    }
  | {
      type: 'queue-updated';
      queue: QueueTrackDto[];
      currentIndex: number;
      revision: number | null;
      data: Record<string, unknown>;
    }
  | {
      type: 'selection.journey';
      snapshot: SelectionJourneySnapshot;
      data: Record<string, unknown>;
    };

export type PlayerPickNextSseEvent =
  | {
      type: 'queue-updated';
      queue: QueueTrackDto[];
      currentIndex: number;
      revision: number | null;
      data: Record<string, unknown>;
    }
  | {
      type: 'dj.debug';
      excludedIds: string[];
      excludedDedupeKeys: string[];
      /** Transitional opaque diagnostics; semantic selection data lives in selectionTrace. */
      candidateScoreTable: unknown[];
      selectionTrace: SelectionDecisionTrace | null;
      data: Record<string, unknown>;
    }
  | {
      type: 'dj.pick-next.done';
      added: boolean;
      reason: string | null;
      data: Record<string, unknown>;
    }
  | {
      type: 'selection.journey';
      snapshot: SelectionJourneySnapshot;
      data: Record<string, unknown>;
    };

export function parsePlayerPersistentSseEvent(type: string, data: unknown): PlayerPersistentSseEvent | null {
  const payload = recordPayload(data);
  if (!payload) return null;

  if (type === 'connected') {
    const revision = optionalRevision(payload.revision);
    const journeys = selectionJourneySnapshotSchema.array().safeParse(payload.journeys);
    if (revision === null || !journeys.success) return null;
    return {
      type,
      queue: queueFromSsePayload(payload.queue),
      currentIndex: numberField(payload.currentIndex),
      revision,
      journeys: journeys.data,
      data: payload
    };
  }

  if (type === 'queue-updated') {
    return {
      type,
      queue: queueFromSsePayload(payload.queue),
      currentIndex: numberField(payload.currentIndex),
      revision: optionalRevision(payload.revision),
      data: payload
    };
  }

  if (type === 'selection.journey') {
    const event = selectionJourneySseEventSchema.safeParse(payload);
    return event.success ? { type, snapshot: event.data.snapshot, data: payload } : null;
  }

  return null;
}

export function parsePlayerPickNextSseEvent(type: string, data: unknown): PlayerPickNextSseEvent | null {
  const payload = recordPayload(data);
  if (!payload) return null;

  if (type === 'queue-updated') {
    return {
      type,
      queue: queueFromSsePayload(payload.queue),
      currentIndex: numberField(payload.currentIndex),
      revision: optionalRevision(payload.revision),
      data: payload
    };
  }

  if (type === 'dj.debug') {
    return {
      type,
      excludedIds: stringArray(payload.excludedIds),
      excludedDedupeKeys: stringArray(payload.excludedDedupeKeys),
      candidateScoreTable: Array.isArray(payload.candidateScoreTable) ? payload.candidateScoreTable : [],
      selectionTrace: parseSelectionTrace(payload.selectionTrace),
      data: payload
    };
  }

  if (type === 'dj.pick-next.done') {
    return {
      type,
      added: payload.added === true,
      reason: typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : null,
      data: payload
    };
  }

  if (type === 'selection.journey') {
    const event = selectionJourneySseEventSchema.safeParse(payload);
    return event.success ? { type, snapshot: event.data.snapshot, data: payload } : null;
  }

  return null;
}

export function queueTrackFromSsePayload(payload: unknown): QueueTrackDto | null {
  const track = recordPayload(payload);
  if (!track) return null;
  const rawId = track.ncmId ?? track.id;
  if (rawId === null || rawId === undefined || rawId === '') return null;
  const id = String(rawId);

  return {
    id,
    name: typeof track.name === 'string' ? track.name : `Track ${id}`,
    artists: stringArray(track.artists),
    durationMs: numberField(track.durationMs),
    coverImgUrl: typeof track.coverImgUrl === 'string' ? track.coverImgUrl : null
  };
}

function queueFromSsePayload(payload: unknown): QueueTrackDto[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map(queueTrackFromSsePayload)
    .filter((track): track is QueueTrackDto => track !== null);
}

function parseSelectionTrace(payload: unknown): SelectionDecisionTrace | null {
  const parsed = selectionDecisionTraceSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function recordPayload(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function optionalRevision(value: unknown): number | null {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

function stringArray(payload: unknown): string[] {
  return Array.isArray(payload) ? payload.filter((value): value is string => typeof value === 'string') : [];
}

function numberField(payload: unknown): number {
  return typeof payload === 'number' && Number.isFinite(payload) ? payload : 0;
}
