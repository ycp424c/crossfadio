import { describe, expect, it, vi } from 'vitest';
import {
  PLAYER_QUEUE_RESTORE_LIMIT,
  PLAYER_QUEUE_STORAGE_KEY,
  PLAYER_QUEUE_STORAGE_TTL_MS,
  getPlayerQueueStorageKey,
  persistQueueSnapshot,
  restorePersistedQueueSnapshot
} from '../../src/renderer/playerQueueCache';
import type { QueueTrackDto } from '../../src/shared/schema';

function makeTrack(id: number): QueueTrackDto {
  return {
    id: String(id),
    name: `Track ${id}`,
    artists: [`Artist ${id}`],
    durationMs: id * 1000,
    coverImgUrl: null
  };
}

function makeStorage(initial?: string, userId = 'user-a'): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(getPlayerQueueStorageKey(userId), initial);
  }

  return {
    get length() {
      return data.size;
    },
    clear: vi.fn(() => data.clear()),
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(data.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => data.delete(key)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    })
  };
}

describe('player queue cache', () => {
  it('persists only the active restore window from the current track', () => {
    const storage = makeStorage();
    const queue = Array.from({ length: 120 }, (_, index) => makeTrack(index + 1));

    persistQueueSnapshot('user-a', queue, 7, storage, 1_000);

    const raw = storage.getItem(getPlayerQueueStorageKey('user-a'));
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw ?? '{}') as { queue: QueueTrackDto[]; currentIndex: number; savedAt: number };
    expect(saved.queue[0]?.id).toBe('8');
    expect(saved.queue.at(-1)?.id).toBe('107');
    expect(saved.queue).toHaveLength(PLAYER_QUEUE_RESTORE_LIMIT);
    expect(saved.currentIndex).toBe(0);
    expect(saved.savedAt).toBe(1_000);
  });

  it('crops legacy oversized snapshots when restoring', () => {
    const queue = Array.from({ length: 150 }, (_, index) => makeTrack(index + 1));
    const storage = makeStorage(JSON.stringify({ queue, currentIndex: 15 }));

    const restored = restorePersistedQueueSnapshot('user-a', storage, 2_000);

    expect(restored?.queue[0]?.id).toBe('16');
    expect(restored?.queue.at(-1)?.id).toBe('115');
    expect(restored?.queue).toHaveLength(PLAYER_QUEUE_RESTORE_LIMIT);
    expect(restored?.currentIndex).toBe(0);
  });

  it('removes expired queue snapshots', () => {
    const queue = [makeTrack(1), makeTrack(2), makeTrack(3)];
    const savedAt = 2_000;
    const storage = makeStorage(JSON.stringify({ queue, currentIndex: 0, savedAt }));

    expect(restorePersistedQueueSnapshot(
      'user-a', storage, savedAt + PLAYER_QUEUE_STORAGE_TTL_MS
    )?.queue).toEqual(queue);
    expect(restorePersistedQueueSnapshot(
      'user-a', storage, savedAt + PLAYER_QUEUE_STORAGE_TTL_MS + 1
    )).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(getPlayerQueueStorageKey('user-a'));
  });

  it('never restores a queue snapshot owned by another account', () => {
    const storage = makeStorage();
    const queue = [makeTrack(1), makeTrack(2)];

    persistQueueSnapshot('user-a', queue, 0, storage, 1_000);

    expect(restorePersistedQueueSnapshot('user-b', storage, 2_000)).toBeNull();
    expect(restorePersistedQueueSnapshot('user-a', storage, 2_000)?.queue).toEqual(queue);
    expect(getPlayerQueueStorageKey('user-a')).not.toBe(getPlayerQueueStorageKey('user-b'));
    expect(getPlayerQueueStorageKey('user-a')).toContain(PLAYER_QUEUE_STORAGE_KEY);
  });
});
