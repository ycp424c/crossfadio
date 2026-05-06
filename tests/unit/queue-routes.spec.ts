import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetLikedQueueHandler, createSetQueueStateHandler } from '../../src/server/http/routes/queue';

beforeEach(async () => {
  const q = await import('../../src/server/store/queue');
  q.setQueue('test-user', []);
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
