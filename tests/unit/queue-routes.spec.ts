import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetLikedQueueHandler, createSetQueueStateHandler } from '../../src/server/http/routes/queue';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-queue-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { _resetDbForTest, initDb } = await import('../../src/server/store/db');
  _resetDbForTest();
  initDb();

  const q = await import('../../src/server/store/queue');
  q.setQueue('test-user', []);
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

function createJsonResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  };
  return res;
}

describe('queue routes', () => {
  it('updates in-memory queue state from renderer payload', async () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();

    handler({ body: { queue: ['a', 'b', 'c'], currentIndex: 2 }, userId: 'test-user' } as never, res as never, vi.fn());

    const q = await import('../../src/server/store/queue');
    expect(res.body).toEqual({ ok: true });
    expect(q.getQueue('test-user').map((track) => track.ncmId)).toEqual(['a', 'b', 'c']);
    expect(q.getCurrentIndex('test-user')).toBe(2);
  });

  it('records temporary bans from renderer queue removals while updating queue state', async () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();

    handler({
      body: {
        queue: [{ id: 'keep-id', name: 'Keep Song', artists: ['Keep Artist'] }],
        currentIndex: 0,
        temporaryBanTracks: [
          { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'] }
        ]
      },
      userId: 'test-user'
    } as never, res as never, vi.fn());

    const q = await import('../../src/server/store/queue');
    const { getActiveTemporaryQueueBanDedupeState } = await import('../../src/server/store/temporary-bans');
    const { buildCandidateDedupeKey } = await import('../../src/server/music-agent/candidates');
    const bans = getActiveTemporaryQueueBanDedupeState('test-user', new Date());

    expect(res.body).toEqual({ ok: true });
    expect(q.getQueue('test-user').map((track) => track.ncmId)).toEqual(['keep-id']);
    expect(bans.ids.has('blocked-id')).toBe(true);
    expect(bans.dedupeKeys.has(buildCandidateDedupeKey({ name: 'Blocked Song', artist: 'Blocked Artist' }))).toBe(true);
  });

  it('expires temporary queue bans after one day', async () => {
    const { recordTemporaryQueueBans, getActiveTemporaryQueueBanDedupeState } = await import('../../src/server/store/temporary-bans');
    const now = new Date('2026-06-04T08:00:00.000Z');

    recordTemporaryQueueBans('test-user', [
      { id: 'temporary-id', name: 'Temporary Song', artists: ['Temporary Artist'] }
    ], now);

    expect(getActiveTemporaryQueueBanDedupeState('test-user', new Date('2026-06-05T07:59:59.000Z')).ids.has('temporary-id')).toBe(true);
    expect(getActiveTemporaryQueueBanDedupeState('test-user', new Date('2026-06-05T08:00:01.000Z')).ids.has('temporary-id')).toBe(false);
  });

  it('rejects invalid queue payloads', () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();

    handler({ body: { queue: [123], currentIndex: 0 }, userId: 'test-user' } as never, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('returns liked songs without replacing the playback queue', async () => {
    const queueStore = await import('../../src/server/store/queue');
    queueStore.setQueue('test-user', [{ ncmId: 'currently-playing', name: 'Current Song' }]);

    const handler = createGetLikedQueueHandler();
    const res = createJsonResponse();

    await handler({
      query: { limit: '20' },
      userId: 'test-user',
      ncmClient: {
        getLikedSongIds: async () => ['101', '102'],
        getSongDetails: async () => [
          { id: 101, name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
          { id: 102, name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
        ]
      }
    } as never, res as never, vi.fn());

    expect(res.body).toEqual({
      ok: true,
      source: 'ncm-liked',
      tracks: [
        { id: '101', name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
        { id: '102', name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
      ],
      currentIndex: 0
    });
    expect(queueStore.getQueue('test-user')).toEqual([{ ncmId: 'currently-playing', name: 'Current Song' }]);
  });
});
