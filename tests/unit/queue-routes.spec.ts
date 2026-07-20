import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetLikedQueueHandler, createSetQueueStateHandler } from '../../src/server/http/routes/queue';
import {
  _addEventClientForTests,
  _resetEventClientsForTests
} from '../../src/server/http/routes/sse-events';

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
  _resetEventClientsForTests();
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
    const q = await import('../../src/server/store/queue');

    handler({
      body: {
        queue: ['a', 'b', 'c'], currentIndex: 2,
        revision: q.getQueueStateRevision('test-user'),
        mutationId: '00000000-0000-4000-8000-000000000001'
      },
      userId: 'test-user'
    } as never, res as never, vi.fn());

    expect(res.body).toMatchObject({
      ok: true,
      revision: expect.any(Number),
      queue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      currentIndex: 2
    });
    expect(q.getQueue('test-user').map((track) => track.ncmId)).toEqual(['a', 'b', 'c']);
    expect(q.getCurrentIndex('test-user')).toBe(2);
  });

  it('broadcasts the authoritative queue snapshot after a renderer mutation succeeds', async () => {
    const frames: string[] = [];
    _addEventClientForTests('test-user', {
      write: vi.fn((chunk: string) => frames.push(chunk))
    } as never);
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');

    handler({
      body: {
        queue: ['broadcast-track'], currentIndex: 0,
        revision: q.getQueueStateRevision('test-user'),
        mutationId: '00000000-0000-4000-8000-000000000017'
      },
      userId: 'test-user'
    } as never, createJsonResponse() as never, vi.fn());

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('event: queue-updated');
    expect(frames[0]).toContain('"queue":[{"id":"broadcast-track"');
    expect(frames[0]).toContain(`"revision":${q.getQueueStateRevision('test-user')}`);
  });

  it('normalizes an empty cover URL before persistence so a fresh queue load keeps the state', async () => {
    const handler = createSetQueueStateHandler();
    const response = createJsonResponse();
    const q = await import('../../src/server/store/queue');
    const { getPref, setPref } = await import('../../src/server/store/prefs');

    handler({
      body: {
        queue: [{ id: 'coverless', name: 'Coverless', coverImgUrl: '' }],
        currentIndex: 0,
        revision: q.getQueueStateRevision('test-user'),
        mutationId: '00000000-0000-4000-8000-000000000016'
      },
      userId: 'test-user'
    } as never, response as never, vi.fn());

    const persisted = getPref<{
      queue: Array<{ ncmId: string; coverImgUrl?: string | null }>;
      currentIndex: number;
      contentRevision: number;
      stateRevision: number;
    }>('test-user', 'queue.state.v2');
    expect(response.body).toMatchObject({ ok: true, revision: expect.any(Number) });
    expect(persisted?.queue).toEqual([{
      ncmId: 'coverless', name: 'Coverless', coverImgUrl: null
    }]);

    setPref('fresh-process-user', 'queue.state.v2', persisted);
    expect(q.getQueueStateSnapshot('fresh-process-user')).toEqual({
      queue: [{ ncmId: 'coverless', name: 'Coverless', coverImgUrl: null }],
      currentIndex: 0,
      revision: persisted?.stateRevision
    });
  });

  it('records temporary bans from renderer queue removals while updating queue state', async () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();
    const q = await import('../../src/server/store/queue');

    handler({
      body: {
        queue: [{ id: 'keep-id', name: 'Keep Song', artists: ['Keep Artist'] }],
        currentIndex: 0,
        revision: q.getQueueStateRevision('test-user'),
        mutationId: '00000000-0000-4000-8000-000000000002',
        temporaryBanTracks: [
          { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'] }
        ]
      },
      userId: 'test-user'
    } as never, res as never, vi.fn());

    const { getActiveTemporaryQueueBanDedupeState } = await import('../../src/server/store/temporary-bans');
    const { buildCandidateDedupeKey } = await import('../../src/server/music-agent/candidates');
    const bans = getActiveTemporaryQueueBanDedupeState('test-user', new Date());

    expect(res.body).toMatchObject({
      ok: true,
      revision: expect.any(Number),
      queue: [{ id: 'keep-id' }],
      currentIndex: 0
    });
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

  it('rejects queue replacement without an expected revision', async () => {
    const handler = createSetQueueStateHandler();
    const res = createJsonResponse();

    handler({
      body: { queue: ['stale-client'], currentIndex: 0 },
      userId: 'test-user'
    } as never, res as never, vi.fn());

    const q = await import('../../src/server/store/queue');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid body' });
    expect(q.getQueue('test-user')).toEqual([]);
  });

  it('rejects an out-of-order full snapshot with the authoritative queue and revision', async () => {
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');
    const initialRevision = q.getQueueStateRevision('test-user');
    const fresh = createJsonResponse();
    handler({
      body: {
        queue: ['newer'], currentIndex: 0, revision: initialRevision,
        mutationId: '00000000-0000-4000-8000-000000000003'
      },
      userId: 'test-user'
    } as never, fresh as never, vi.fn());
    const stale = createJsonResponse();
    handler({
      body: {
        queue: ['stale'], currentIndex: 0, revision: initialRevision,
        mutationId: '00000000-0000-4000-8000-000000000004'
      },
      userId: 'test-user'
    } as never, stale as never, vi.fn());

    expect(fresh.body).toMatchObject({
      ok: true,
      revision: initialRevision + 1,
      queue: [{ id: 'newer' }],
      currentIndex: 0
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      ok: false,
      error: 'queue_revision_conflict',
      revision: initialRevision + 1,
      queue: [{
        id: 'newer', name: 'Track newer', artists: [], durationMs: 0, coverImgUrl: null
      }]
    });
    expect(q.getQueue('test-user')).toEqual([{ ncmId: 'newer' }]);
  });

  it('commits queue state and temporary bans atomically and replays a mutation idempotently', async () => {
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');
    const body = {
      queue: ['kept'],
      currentIndex: 0,
      revision: q.getQueueStateRevision('test-user'),
      mutationId: '00000000-0000-4000-8000-000000000005',
      temporaryBanTracks: [{ id: 'removed' }]
    };
    const first = createJsonResponse();
    handler({ body, userId: 'test-user' } as never, first as never, vi.fn());
    const second = createJsonResponse();
    handler({ body, userId: 'test-user' } as never, second as never, vi.fn());

    const { getDb } = await import('../../src/server/store/db');
    expect(first.body).toMatchObject({
      ok: true,
      revision: body.revision + 1,
      queue: [{ id: 'kept' }],
      currentIndex: 0
    });
    expect(second.body).toMatchObject({
      ok: true,
      revision: body.revision + 1,
      queue: [{ id: 'kept' }],
      currentIndex: 0
    });
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM queue_state_mutations WHERE user_id = ?'
    ).get('test-user')).toEqual({ count: 1 });
  });

  it('returns the current authoritative snapshot when an old successful mutation is replayed after a newer one', async () => {
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');
    const initialRevision = q.getQueueStateRevision('test-user');
    const firstBody = {
      queue: ['first'], currentIndex: 0, revision: initialRevision,
      mutationId: '00000000-0000-4000-8000-000000000011'
    };
    const first = createJsonResponse();
    handler({ body: firstBody, userId: 'test-user' } as never, first as never, vi.fn());

    const newer = createJsonResponse();
    handler({
      body: {
        queue: ['newer'], currentIndex: 0, revision: initialRevision + 1,
        mutationId: '00000000-0000-4000-8000-000000000012'
      },
      userId: 'test-user'
    } as never, newer as never, vi.fn());

    const replay = createJsonResponse();
    handler({ body: firstBody, userId: 'test-user' } as never, replay as never, vi.fn());

    expect(newer.body).toMatchObject({
      ok: true,
      revision: initialRevision + 2,
      queue: [{ id: 'newer' }],
      currentIndex: 0
    });
    expect(replay.body).toMatchObject({
      ok: true,
      revision: initialRevision + 2,
      queue: [{ id: 'newer' }],
      currentIndex: 0
    });
    expect(q.getQueue('test-user')).toEqual([{ ncmId: 'newer' }]);
  });

  it('rejects queue and temporary-ban payloads above the business limits', async () => {
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');
    const revision = q.getQueueStateRevision('test-user');

    for (const body of [
      {
        queue: Array.from({ length: 101 }, (_, index) => `track-${index}`),
        currentIndex: 0,
        revision,
        mutationId: '00000000-0000-4000-8000-000000000013'
      },
      {
        queue: [],
        currentIndex: 0,
        revision,
        mutationId: '00000000-0000-4000-8000-000000000014',
        temporaryBanTracks: Array.from({ length: 101 }, (_, index) => ({ id: `ban-${index}` }))
      },
      {
        queue: [{ id: 'x'.repeat(129) }],
        currentIndex: 0,
        revision,
        mutationId: '00000000-0000-4000-8000-000000000015'
      }
    ]) {
      const response = createJsonResponse();
      handler({ body, userId: 'test-user' } as never, response as never, vi.fn());
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ ok: false, error: 'invalid body' });
    }
  });

  it('discards oversized persisted queue state and bounds active temporary bans', async () => {
    const { setPref } = await import('../../src/server/store/prefs');
    const q = await import('../../src/server/store/queue');
    setPref('persisted-overflow-user', 'queue.state.v2', {
      queue: Array.from({ length: 101 }, (_, index) => ({ ncmId: `persisted-${index}` })),
      currentIndex: 0,
      contentRevision: 1,
      stateRevision: 1
    });

    expect(q.getQueueStateSnapshot('persisted-overflow-user')).toEqual({
      queue: [], currentIndex: 0, revision: 0
    });

    const { recordTemporaryQueueBans, getActiveTemporaryQueueBans } = await import(
      '../../src/server/store/temporary-bans'
    );
    const now = new Date('2026-06-04T08:00:00.000Z');
    for (let batch = 0; batch < 3; batch += 1) {
      recordTemporaryQueueBans(
        'bounded-ban-user',
        Array.from({ length: 100 }, (_, index) => ({ id: `ban-${batch}-${index}` })),
        now
      );
    }
    const active = getActiveTemporaryQueueBans('bounded-ban-user', now);
    expect(active).toHaveLength(200);
    expect(active[0]?.id).toBe('ban-1-0');
    expect(active.at(-1)?.id).toBe('ban-2-99');
  });

  it('rolls back both queue state and temporary bans when the durable mutation fails', async () => {
    const { getDb } = await import('../../src/server/store/db');
    getDb().exec(`
      CREATE TEMP TRIGGER fail_queue_state_mutation
      BEFORE INSERT ON queue_state_mutations
      BEGIN
        SELECT RAISE(ABORT, 'injected queue mutation failure');
      END;
    `);
    const handler = createSetQueueStateHandler();
    const q = await import('../../src/server/store/queue');
    const revision = q.getQueueStateRevision('test-user');

    expect(() => handler({
      body: {
        queue: ['must-not-commit'], currentIndex: 0, revision,
        mutationId: '00000000-0000-4000-8000-000000000006',
        temporaryBanTracks: [{ id: 'must-not-ban' }]
      },
      userId: 'test-user'
    } as never, createJsonResponse() as never, vi.fn())).toThrow('injected queue mutation failure');

    const { getActiveTemporaryQueueBanDedupeState } = await import('../../src/server/store/temporary-bans');
    expect(q.getQueue('test-user')).toEqual([]);
    expect(q.getQueueStateRevision('test-user')).toBe(revision);
    expect(getActiveTemporaryQueueBanDedupeState('test-user').ids.has('must-not-ban')).toBe(false);
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
