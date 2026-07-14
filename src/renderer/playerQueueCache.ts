import type { QueueTrackDto } from '@shared/schema';

export const PLAYER_QUEUE_STORAGE_KEY = 'crossfadio.player.queue.v1';
export const PLAYER_QUEUE_RESTORE_LIMIT = 100;
export const PLAYER_QUEUE_STORAGE_TTL_MS = 12 * 60 * 60 * 1000;

export type PersistedQueueSnapshot = {
  queue: QueueTrackDto[];
  currentIndex: number;
};

type StoredQueueSnapshot = Partial<PersistedQueueSnapshot> & {
  savedAt?: unknown;
};

export function restorePersistedQueueSnapshot(
  storage: Storage = localStorage,
  nowMs = Date.now()
): PersistedQueueSnapshot | null {
  try {
    const raw = storage.getItem(PLAYER_QUEUE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredQueueSnapshot;
    if (isExpiredSnapshot(parsed.savedAt, nowMs)) {
      storage.removeItem(PLAYER_QUEUE_STORAGE_KEY);
      return null;
    }

    const queue = Array.isArray(parsed.queue)
      ? parsed.queue
          .map((track) => normalizePersistedTrack(track))
          .filter((track): track is QueueTrackDto => track !== null)
      : [];

    const snapshot = buildRestoreWindow(queue, parsed.currentIndex);
    if (!snapshot) {
      storage.removeItem(PLAYER_QUEUE_STORAGE_KEY);
      return null;
    }

    return snapshot;
  } catch {
    storage.removeItem(PLAYER_QUEUE_STORAGE_KEY);
    return null;
  }
}

export function persistQueueSnapshot(
  queue: QueueTrackDto[],
  currentIndex: number,
  storage: Storage = localStorage,
  nowMs = Date.now()
): void {
  try {
    const snapshot = buildRestoreWindow(queue, currentIndex);
    if (!snapshot) {
      storage.removeItem(PLAYER_QUEUE_STORAGE_KEY);
      return;
    }

    storage.setItem(
      PLAYER_QUEUE_STORAGE_KEY,
      JSON.stringify({ ...snapshot, savedAt: nowMs })
    );
  } catch {
    // localStorage may be unavailable or full; playback should continue normally.
  }
}

function buildRestoreWindow(queue: QueueTrackDto[], currentIndex: unknown): PersistedQueueSnapshot | null {
  if (queue.length === 0) return null;

  const requestedIndex = typeof currentIndex === 'number' ? currentIndex : 0;
  const safeIndex = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(queue.length - 1, requestedIndex))
    : 0;
  const restoreWindow = queue.slice(safeIndex, safeIndex + PLAYER_QUEUE_RESTORE_LIMIT);

  if (restoreWindow.length === 0) return null;
  return { queue: restoreWindow, currentIndex: 0 };
}

function isExpiredSnapshot(savedAt: unknown, nowMs: number): boolean {
  return typeof savedAt === 'number'
    && Number.isFinite(savedAt)
    && nowMs - savedAt > PLAYER_QUEUE_STORAGE_TTL_MS;
}

function normalizePersistedTrack(track: unknown): QueueTrackDto | null {
  if (!track || typeof track !== 'object') return null;
  const t = track as Record<string, unknown>;
  if (typeof t.id !== 'string' || t.id.length === 0 || typeof t.name !== 'string') {
    return null;
  }

  return {
    id: t.id,
    name: t.name,
    artists: Array.isArray(t.artists) ? t.artists.filter((artist): artist is string => typeof artist === 'string') : [],
    durationMs: typeof t.durationMs === 'number' && Number.isFinite(t.durationMs) && t.durationMs >= 0
      ? Math.floor(t.durationMs)
      : 0,
    coverImgUrl: typeof t.coverImgUrl === 'string' && t.coverImgUrl.length > 0 ? t.coverImgUrl : null
  };
}
