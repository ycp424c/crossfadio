import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetLikedQueueHandler, createSetQueueStateHandler } from '../../src/server/http/routes/queue';

beforeEach(async () => {
  const q = await import('../../src/server/store/queue');
  q.setQueue([]);
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

    handler({ body: { queue: ['a', 'b', 'c'], currentIndex: 2 } } as never, res as never, vi.fn());

    const q = await import('../../src/server/store/queue');
    expect(res.body).toEqual({ ok: true });
    expect(q.getQueue().map((track) => track.ncmId)).toEqual(['a', 'b', 'c']);
    expect(q.getCurrentIndex()).toBe(2);
  });

  it('rejects invalid queue payloads', () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();

    handler({ body: { queue: [123], currentIndex: 0 } } as never, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('loads liked songs into the in-memory queue', async () => {
    const handler = createGetLikedQueueHandler({
      getLikedSongIds: async () => ['101', '102'],
      getSongDetails: async () => [
        { id: 101, name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
        { id: 102, name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
      ]
    } as never);
    const res = createJsonResponse();

    await handler({ query: { limit: '20' } } as never, res as never, vi.fn());

    const q = await import('../../src/server/store/queue');
    expect(res.body).toEqual({
      ok: true,
      source: 'ncm-liked',
      tracks: [
        { id: '101', name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
        { id: '102', name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
      ],
      currentIndex: 0
    });
    expect(q.getQueue()).toEqual([
      { ncmId: '101', name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
      { ncmId: '102', name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
    ]);
  });
});
