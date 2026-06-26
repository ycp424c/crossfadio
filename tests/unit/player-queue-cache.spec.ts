import { describe, expect, it, vi } from 'vitest';
import {
  PLAYER_QUEUE_RESTORE_LIMIT,
  PLAYER_QUEUE_STORAGE_KEY,
  PLAYER_QUEUE_STORAGE_TTL_MS,
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

function makeStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(PLAYER_QUEUE_STORAGE_KEY, initial);
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
    const queue = Array.from({ length: 12 }, (_, index) => makeTrack(index + 1));

    persistQueueSnapshot(queue, 7, storage, 1_000);

    const raw = storage.getItem(PLAYER_QUEUE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw ?? '{}') as { queue: QueueTrackDto[]; currentIndex: number; savedAt: number };
    expect(saved.queue.map((track) => track.id)).toEqual(['8', '9', '10', '11']);
    expect(saved.queue).toHaveLength(PLAYER_QUEUE_RESTORE_LIMIT);
    expect(saved.currentIndex).toBe(0);
    expect(saved.savedAt).toBe(1_000);
  });

  it('crops legacy oversized snapshots when restoring', () => {
    const queue = Array.from({ length: 20 }, (_, index) => makeTrack(index + 1));
    const storage = makeStorage(JSON.stringify({ queue, currentIndex: 15 }));

    const restored = restorePersistedQueueSnapshot(storage, 2_000);

    expect(restored?.queue.map((track) => track.id)).toEqual(['16', '17', '18', '19']);
    expect(restored?.currentIndex).toBe(0);
  });

  it('removes expired queue snapshots', () => {
    const queue = [makeTrack(1), makeTrack(2), makeTrack(3)];
    const savedAt = 2_000;
    const storage = makeStorage(JSON.stringify({ queue, currentIndex: 0, savedAt }));

    expect(restorePersistedQueueSnapshot(storage, savedAt + PLAYER_QUEUE_STORAGE_TTL_MS + 1)).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(PLAYER_QUEUE_STORAGE_KEY);
  });
});
