import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetQueueStateHandler } from '../../src/server/http/routes/queue';

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
});
