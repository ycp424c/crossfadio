import type { QueueTrackDto } from '@shared/schema';

export type CandidateScoreTableRow = {
  rank: number;
  id: string;
  song: string;
  artist: string;
  sources: string;
  baseScore: number;
  artistPenalty: number;
  trackPenalty: number;
  repeatPenalty: number;
  adjustedScore: number;
};

export type PlayerPersistentSseEvent =
  | {
      type: 'queue-updated';
      queue: QueueTrackDto[];
      currentIndex: number;
      data: Record<string, unknown>;
    }
  | {
      type: 'queue-appended';
      track: QueueTrackDto;
      data: Record<string, unknown>;
    };

export type PlayerPickNextSseEvent =
  | {
      type: 'queue-appended';
      track: QueueTrackDto;
      data: Record<string, unknown>;
    }
  | {
      type: 'dj.debug';
      excludedIds: string[];
      excludedDedupeKeys: string[];
      candidateScoreTable: CandidateScoreTableRow[];
      data: Record<string, unknown>;
    }
  | {
      type: 'dj.pick-next.done';
      added: boolean;
      reason: string | null;
      data: Record<string, unknown>;
    };

export function parsePlayerPersistentSseEvent(type: string, data: unknown): PlayerPersistentSseEvent | null {
  const payload = recordPayload(data);
  if (!payload) return null;

  if (type === 'queue-updated') {
    return {
      type,
      queue: queueFromSsePayload(payload.queue),
      currentIndex: numberField(payload.currentIndex),
      data: payload
    };
  }

  if (type === 'queue-appended') {
    const track = queueTrackFromSsePayload(payload.track);
    return track ? { type, track, data: payload } : null;
  }

  return null;
}

export function parsePlayerPickNextSseEvent(type: string, data: unknown): PlayerPickNextSseEvent | null {
  const payload = recordPayload(data);
  if (!payload) return null;

  if (type === 'queue-appended') {
    const track = queueTrackFromSsePayload(payload.track);
    return track ? { type, track, data: payload } : null;
  }

  if (type === 'dj.debug') {
    return {
      type,
      excludedIds: stringArray(payload.excludedIds),
      excludedDedupeKeys: stringArray(payload.excludedDedupeKeys),
      candidateScoreTable: candidateScoreTable(payload.candidateScoreTable),
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

function candidateScoreTable(payload: unknown): CandidateScoreTableRow[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((row): CandidateScoreTableRow | null => {
      const record = recordPayload(row);
      if (!record) return null;
      return {
        rank: numberField(record.rank),
        id: stringField(record.id),
        song: stringField(record.song),
        artist: stringField(record.artist),
        sources: stringField(record.sources),
        baseScore: numberField(record.baseScore),
        artistPenalty: numberField(record.artistPenalty),
        trackPenalty: numberField(record.trackPenalty),
        repeatPenalty: numberField(record.repeatPenalty),
        adjustedScore: numberField(record.adjustedScore)
      };
    })
    .filter((row): row is CandidateScoreTableRow => row !== null);
}

function recordPayload(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(payload: unknown): string[] {
  return Array.isArray(payload) ? payload.filter((value): value is string => typeof value === 'string') : [];
}

function stringField(payload: unknown): string {
  return typeof payload === 'string' ? payload : '';
}

function numberField(payload: unknown): number {
  return typeof payload === 'number' && Number.isFinite(payload) ? payload : 0;
}
