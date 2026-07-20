import { createHash } from 'node:crypto';
import {
  MAX_QUEUE_TRACK_ARTIST_LENGTH,
  MAX_QUEUE_TRACK_ARTISTS,
  MAX_QUEUE_TRACK_COVER_URL_LENGTH,
  MAX_QUEUE_TRACK_ID_LENGTH,
  MAX_QUEUE_TRACK_NAME_LENGTH,
  MAX_QUEUE_TRACK_QUERY_LENGTH,
  MAX_QUEUE_TRACKS
} from '../../shared/queue.js';
import type { TemporaryQueueBanTrackInput } from './temporary-bans.js';
import { recordTemporaryQueueBans } from './temporary-bans.js';
import { getDb } from './db.js';
import { getPref, setPref } from './prefs.js';

export type QueueTrack = {
  ncmId: string;
  query?: string;
  name?: string;
  artists?: string[];
  durationMs?: number;
  coverImgUrl?: string | null;
};

type QueueState = {
  queue: QueueTrack[];
  currentIndex: number;
  contentRevision: number;
  stateRevision: number;
};

export type QueueStateSnapshot = {
  queue: QueueTrack[];
  currentIndex: number;
  revision: number;
};

export type PreparedQueueAppend = {
  snapshot: QueueStateSnapshot;
  persist(): void;
  commitCache(): void;
};

const userQueues = new Map<string, QueueState>();
const QUEUE_STATE_PREF_KEY = 'queue.state.v2';
const QUEUE_MUTATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function getState(userId: string): QueueState {
  const cached = userQueues.get(userId);
  if (cached) return cached;
  const persisted = readPersistedState(userId);
  userQueues.set(userId, persisted);
  return persisted;
}

function clampIndex(queue: QueueTrack[], index: number): number {
  if (queue.length === 0) return 0;
  if (!Number.isInteger(index)) return 0;
  return Math.min(Math.max(index, 0), queue.length - 1);
}

export function getQueue(userId: string): QueueTrack[] {
  return [...getState(userId).queue];
}

export function setQueue(userId: string, tracks: QueueTrack[]): void {
  assertQueueTracks(tracks);
  const current = getState(userId);
  commitState(userId, {
    queue: [...tracks], currentIndex: 0,
    contentRevision: current.contentRevision + 1,
    stateRevision: current.stateRevision + 1
  });
}

export function setQueueState(userId: string, tracks: QueueTrack[], nextCurrentIndex = 0): void {
  applyQueueState(userId, tracks, nextCurrentIndex);
}

export function compareAndSetQueueState(
  userId: string,
  expectedRevision: number,
  tracks: QueueTrack[],
  nextCurrentIndex = 0
): { applied: boolean; snapshot: QueueStateSnapshot } {
  const normalizedTracks = normalizeQueueTracks(tracks);
  assertQueueTracks(normalizedTracks);
  const current = getState(userId);
  if (current.stateRevision !== expectedRevision) {
    return { applied: false, snapshot: getQueueStateSnapshot(userId) };
  }
  const clampedCurrentIndex = clampIndex(normalizedTracks, nextCurrentIndex);
  if (sameQueue(current.queue, normalizedTracks) && current.currentIndex === clampedCurrentIndex) {
    return { applied: true, snapshot: getQueueStateSnapshot(userId) };
  }
  applyQueueState(userId, normalizedTracks, clampedCurrentIndex);
  return { applied: true, snapshot: getQueueStateSnapshot(userId) };
}

export function compareAndSetQueueStateWithTemporaryBans(input: {
  userId: string;
  mutationId: string;
  expectedRevision: number;
  tracks: QueueTrack[];
  nextCurrentIndex?: number;
  temporaryBanTracks?: TemporaryQueueBanTrackInput[];
  now?: Date;
}): {
  applied: boolean;
  reason?: 'queue_revision_conflict' | 'queue_mutation_id_conflict';
  snapshot: QueueStateSnapshot;
} {
  const db = getDb();
  const now = input.now ?? new Date();
  const temporaryBanTracks = input.temporaryBanTracks ?? [];
  const normalizedTracks = normalizeQueueTracks(input.tracks);
  assertQueueTracks(normalizedTracks);
  const requestHash = queueMutationRequestHash({
    expectedRevision: input.expectedRevision,
    tracks: normalizedTracks,
    nextCurrentIndex: input.nextCurrentIndex ?? 0,
    temporaryBanTracks
  });
  let committedState: QueueState | undefined;

  const result = db.transaction(() => {
    const existing = db.prepare(`
      SELECT request_hash AS requestHash, resulting_revision AS resultingRevision
      FROM queue_state_mutations
      WHERE user_id = ? AND mutation_id = ?
    `).get(input.userId, input.mutationId) as {
      requestHash: string;
      resultingRevision: number;
    } | undefined;
    const current = getState(input.userId);
    if (existing) {
      return existing.requestHash === requestHash
        ? {
            applied: true,
            snapshot: snapshotFromState(current)
          }
        : {
            applied: false,
            reason: 'queue_mutation_id_conflict' as const,
            snapshot: snapshotFromState(current)
          };
    }
    if (current.stateRevision !== input.expectedRevision) {
      return {
        applied: false,
        reason: 'queue_revision_conflict' as const,
        snapshot: snapshotFromState(current)
      };
    }

    const nextState = nextQueueState(current, normalizedTracks, input.nextCurrentIndex ?? 0);
    setPref(input.userId, QUEUE_STATE_PREF_KEY, nextState);
    if (temporaryBanTracks.length > 0) {
      recordTemporaryQueueBans(input.userId, temporaryBanTracks, now);
    }
    db.prepare(`
      INSERT INTO queue_state_mutations (
        user_id, mutation_id, request_hash, resulting_revision, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(input.userId, input.mutationId, requestHash, nextState.stateRevision, now.toISOString());
    db.prepare('DELETE FROM queue_state_mutations WHERE created_at < ?')
      .run(new Date(now.getTime() - QUEUE_MUTATION_RETENTION_MS).toISOString());
    committedState = nextState;
    return { applied: true, snapshot: snapshotFromState(nextState) };
  }).immediate();

  if (committedState) userQueues.set(input.userId, committedState);
  return result;
}

function applyQueueState(userId: string, tracks: QueueTrack[], nextCurrentIndex: number): void {
  const current = getState(userId);
  commitState(userId, nextQueueState(current, tracks, nextCurrentIndex, true));
}

export function getCurrentIndex(userId: string): number {
  return getState(userId).currentIndex;
}

export function getQueueRevision(userId: string): number {
  return getState(userId).contentRevision;
}

export function getQueueStateRevision(userId: string): number {
  return getState(userId).stateRevision;
}

export function getQueueStateSnapshot(userId: string): QueueStateSnapshot {
  const state = getState(userId);
  return {
    queue: [...state.queue],
    currentIndex: state.currentIndex,
    revision: state.stateRevision
  };
}

export function advanceCurrent(userId: string): void {
  const s = getState(userId);
  if (s.currentIndex < s.queue.length - 1) {
    commitState(userId, { ...s, queue: [...s.queue], currentIndex: s.currentIndex + 1, stateRevision: s.stateRevision + 1 });
  }
}

export function swapNext(userId: string, track: QueueTrack): void {
  const s = getState(userId);
  if (s.queue.length === 0) {
    commitState(userId, {
      ...s, queue: [track], currentIndex: 0,
      contentRevision: s.contentRevision + 1, stateRevision: s.stateRevision + 1
    });
    return;
  }
  const queue = [...s.queue];
  const insertAt = Math.min(s.currentIndex + 1, s.queue.length);
  queue.splice(insertAt, 0, track);
  const laterIdx = queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
  if (laterIdx !== -1) queue.splice(laterIdx, 1);
  commitState(userId, {
    ...s, queue,
    contentRevision: s.contentRevision + 1, stateRevision: s.stateRevision + 1
  });
}

export function addToQueue(userId: string, track: QueueTrack, position: 'end' | 'after_current'): void {
  const s = getState(userId);
  let queue = [...s.queue];
  if (position === 'end') {
    queue = queue.filter((t) => t.ncmId !== track.ncmId);
    queue.push(track);
  } else {
    const insertAt = Math.min(s.currentIndex + 1, queue.length);
    queue.splice(insertAt, 0, track);
    const laterIdx = queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
    if (laterIdx !== -1) queue.splice(laterIdx, 1);
  }
  commitState(userId, {
    ...s, queue,
    contentRevision: s.contentRevision + 1, stateRevision: s.stateRevision + 1
  });
}

export function prepareQueueAppend(
  userId: string,
  tracks: QueueTrack[]
): PreparedQueueAppend {
  assertQueueTracks(tracks);
  const current = getState(userId);
  let queue = [...current.queue];
  for (const track of tracks) {
    queue = queue.filter((item) => item.ncmId !== track.ncmId);
    queue.push(track);
  }
  const nextState = nextQueueState(current, queue, current.currentIndex);
  let persisted = false;

  return {
    snapshot: snapshotFromState(nextState),
    persist() {
      if (!getDb().inTransaction) {
        throw new Error('prepared queue append must be persisted inside a transaction');
      }
      setPref(userId, QUEUE_STATE_PREF_KEY, nextState);
      persisted = true;
    },
    commitCache() {
      if (!persisted) throw new Error('prepared queue append was not persisted');
      userQueues.set(userId, nextState);
    }
  };
}

export function skipCurrent(userId: string): void {
  advanceCurrent(userId);
}

export function banNcmId(userId: string, ncmId: string): void {
  const s = getState(userId);
  const beforeLength = s.queue.length;
  const queue = s.queue.filter((t) => t.ncmId !== ncmId);
  if (queue.length !== beforeLength) {
    commitState(userId, {
      queue,
      currentIndex: clampIndex(queue, s.currentIndex),
      contentRevision: s.contentRevision + 1,
      stateRevision: s.stateRevision + 1
    });
  }
}

function nextQueueState(
  current: QueueState,
  tracks: QueueTrack[],
  nextCurrentIndex: number,
  alwaysAdvanceStateRevision = false
): QueueState {
  const queue = normalizeQueueTracks(tracks);
  assertQueueTracks(queue);
  const currentIndex = clampIndex(queue, nextCurrentIndex);
  const contentChanged = !sameQueue(current.queue, queue);
  const stateChanged = contentChanged || current.currentIndex !== currentIndex;
  return {
    queue,
    currentIndex,
    contentRevision: current.contentRevision + (contentChanged ? 1 : 0),
    stateRevision: current.stateRevision + (stateChanged || alwaysAdvanceStateRevision ? 1 : 0)
  };
}

function snapshotFromState(state: QueueState): QueueStateSnapshot {
  return { queue: [...state.queue], currentIndex: state.currentIndex, revision: state.stateRevision };
}

function commitState(userId: string, state: QueueState): void {
  const normalizedState = { ...state, queue: normalizeQueueTracks(state.queue) };
  assertQueueTracks(normalizedState.queue);
  try {
    setPref(userId, QUEUE_STATE_PREF_KEY, normalizedState);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Database is not initialized.') throw error;
  }
  userQueues.set(userId, normalizedState);
}

function readPersistedState(userId: string): QueueState {
  try {
    const parsed = parseQueueState(getPref<unknown>(userId, QUEUE_STATE_PREF_KEY));
    if (parsed) return parsed;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Database is not initialized.') throw error;
  }
  return { queue: [], currentIndex: 0, contentRevision: 0, stateRevision: 0 };
}

function parseQueueState(value: unknown): QueueState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<QueueState>;
  if (!Array.isArray(record.queue)
    || record.queue.length > MAX_QUEUE_TRACKS
    || !record.queue.every(isPersistedQueueTrack)
    || !Number.isInteger(record.currentIndex) || Number(record.currentIndex) < 0
    || !Number.isInteger(record.contentRevision) || Number(record.contentRevision) < 0
    || !Number.isInteger(record.stateRevision) || Number(record.stateRevision) < 0) return null;
  const queue = record.queue.map((track) => ({ ...track }));
  return {
    queue,
    currentIndex: clampIndex(queue, Number(record.currentIndex)),
    contentRevision: Number(record.contentRevision),
    stateRevision: Number(record.stateRevision)
  };
}

function isPersistedQueueTrack(value: unknown): value is QueueTrack {
  if (!value || typeof value !== 'object') return false;
  const track = value as Record<string, unknown>;
  return boundedRequiredString(track.ncmId, MAX_QUEUE_TRACK_ID_LENGTH)
    && boundedOptionalString(track.query, MAX_QUEUE_TRACK_QUERY_LENGTH)
    && boundedOptionalString(track.name, MAX_QUEUE_TRACK_NAME_LENGTH)
    && (track.artists === undefined || (
      Array.isArray(track.artists)
      && track.artists.length <= MAX_QUEUE_TRACK_ARTISTS
      && track.artists.every((artist) => boundedRequiredString(artist, MAX_QUEUE_TRACK_ARTIST_LENGTH))
    ))
    && (track.durationMs === undefined || (
      typeof track.durationMs === 'number'
      && Number.isInteger(track.durationMs)
      && track.durationMs >= 0
    ))
    && (track.coverImgUrl === undefined || track.coverImgUrl === null
      || boundedRequiredString(track.coverImgUrl, MAX_QUEUE_TRACK_COVER_URL_LENGTH));
}

function assertQueueTracks(tracks: QueueTrack[]): void {
  if (tracks.length > MAX_QUEUE_TRACKS) throw new RangeError('queue exceeds limit');
  for (const track of tracks) {
    if (track.ncmId.length === 0 || track.ncmId.length > MAX_QUEUE_TRACK_ID_LENGTH) {
      throw new RangeError('queue track id exceeds limit');
    }
    if (track.query !== undefined && track.query.length > MAX_QUEUE_TRACK_QUERY_LENGTH) {
      throw new RangeError('queue track query exceeds limit');
    }
    if (track.name !== undefined && track.name.length > MAX_QUEUE_TRACK_NAME_LENGTH) {
      throw new RangeError('queue track name exceeds limit');
    }
    if (track.artists !== undefined && (
      track.artists.length > MAX_QUEUE_TRACK_ARTISTS
      || track.artists.some((artist) => artist.length === 0 || artist.length > MAX_QUEUE_TRACK_ARTIST_LENGTH)
    )) throw new RangeError('queue track artists exceed limit');
    if (typeof track.coverImgUrl === 'string'
      && track.coverImgUrl.length > MAX_QUEUE_TRACK_COVER_URL_LENGTH) {
      throw new RangeError('queue track cover URL exceeds limit');
    }
  }
}

function boundedRequiredString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function boundedOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function normalizeQueueTracks(tracks: QueueTrack[]): QueueTrack[] {
  return tracks.map((track) => track.coverImgUrl === ''
    ? { ...track, coverImgUrl: null }
    : { ...track });
}

function queueMutationRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameQueue(left: QueueTrack[], right: QueueTrack[]): boolean {
  return left.length === right.length && left.every((track, index) => (
    JSON.stringify(track) === JSON.stringify(right[index])
  ));
}
