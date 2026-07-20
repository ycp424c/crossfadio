import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTENING_EPISODE_DAILY_LIMIT } from '../../src/shared/listening';

const indexPlayedTrackMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../src/server/music-agent/entity-indexer.js', () => ({
  indexPlayedTrack: indexPlayedTrackMock
}));

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  indexPlayedTrackMock.mockClear();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-listening-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Listening Episode HTTP protocol', () => {
  it('creates once when PUT is retried with the same client episode id', async () => {
    const { createPutListeningEpisodeHandler } = await import(
      '../../src/server/http/routes/listening-episodes.js'
    );
    const handler = createPutListeningEpisodeHandler();
    const body = {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: {
        id: '909',
        name: 'My Cookie Can',
        artists: ['卫兰']
      },
      durationMs: 200_000,
      checkpointSeq: 0
    };

    const first = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-a',
      body
    });
    await handler(first.req, first.res, vi.fn());

    const retried = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-a',
      body
    });
    await handler(retried.req, retried.res, vi.fn());

    expect(first.res.status).toHaveBeenCalledWith(201);
    expect(first.res.json).toHaveBeenCalledWith({
      ok: true,
      created: true,
      episode: expect.objectContaining({
        clientEpisodeId: 'episode-a',
        outcome: null
      })
    });
    expect(retried.res.status).toHaveBeenCalledWith(200);
    expect(retried.res.json).toHaveBeenCalledWith({
      ok: true,
      created: false,
      episode: expect.objectContaining({
        clientEpisodeId: 'episode-a',
        outcome: null
      })
    });
    expect(indexPlayedTrackMock).toHaveBeenCalledTimes(1);
    expect(indexPlayedTrackMock).toHaveBeenCalledWith({
      userId: 'route-user',
      track: {
        songId: '909',
        songName: 'My Cookie Can',
        artistName: '卫兰'
      }
    });
  });

  it('rejects reuse of a client episode id for a different track', async () => {
    const { createPutListeningEpisodeHandler } = await import(
      '../../src/server/http/routes/listening-episodes.js'
    );
    const handler = createPutListeningEpisodeHandler();
    const first = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-conflict',
      body: {
        playerInstanceId: 'player-a',
        deckId: 'main',
        track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
        durationMs: 200_000,
        checkpointSeq: 0
      }
    });
    await handler(first.req, first.res, vi.fn());
    const reused = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-conflict',
      body: {
        playerInstanceId: 'player-a',
        deckId: 'main',
        track: { id: '910', name: 'Different Song', artists: ['卫兰'] },
        durationMs: 180_000,
        checkpointSeq: 0
      }
    });
    await handler(reused.req, reused.res, vi.fn());

    expect(reused.res.status).toHaveBeenCalledWith(409);
    expect(indexPlayedTrackMock).toHaveBeenCalledTimes(1);
  });

  it('returns a stable 429 response when the UTC-day episode quota is exhausted', async () => {
    const { createPutListeningEpisodeHandler } = await import(
      '../../src/server/http/routes/listening-episodes.js'
    );
    const { createListeningEpisode } = await import(
      '../../src/server/store/listening-episodes.js'
    );
    const now = new Date();
    const body = {
      playerInstanceId: 'player-quota',
      deckId: 'main',
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      durationMs: 200_000,
      checkpointSeq: 0 as const
    };
    for (let index = 0; index < LISTENING_EPISODE_DAILY_LIMIT; index += 1) {
      createListeningEpisode('route-quota-user', `quota-${index}`, body, { now });
    }
    indexPlayedTrackMock.mockClear();

    const request = makeReqRes({
      userId: 'route-quota-user',
      clientEpisodeId: 'quota-overflow',
      body
    });
    await createPutListeningEpisodeHandler()(request.req, request.res, vi.fn());

    expect(request.res.status).toHaveBeenCalledWith(429);
    expect(request.res.json).toHaveBeenCalledWith({
      ok: false,
      error: 'listening_episode_daily_quota_exceeded',
      dailyLimit: LISTENING_EPISODE_DAILY_LIMIT,
      quotaResetsAt: expect.any(String)
    });
    expect(indexPlayedTrackMock).not.toHaveBeenCalled();
  });

  it('ignores a stale checkpoint without rolling episode progress backward', async () => {
    const {
      createPatchListeningEpisodeHandler,
      createPutListeningEpisodeHandler
    } = await import('../../src/server/http/routes/listening-episodes.js');
    const create = createPutListeningEpisodeHandler();
    const patch = createPatchListeningEpisodeHandler();
    const created = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-checkpoint',
      body: {
        playerInstanceId: 'player-a',
        deckId: 'main',
        track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
        durationMs: 200_000,
        checkpointSeq: 0
      }
    });
    await create(created.req, created.res, vi.fn());

    const checkpoint = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-checkpoint',
      body: {
        checkpointSeq: 2,
        positionMs: 30_000,
        listenedMs: 20_000,
        durationMs: 200_000
      }
    });
    await patch(checkpoint.req, checkpoint.res, vi.fn());

    const stale = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-checkpoint',
      body: {
        checkpointSeq: 1,
        positionMs: 5_000,
        listenedMs: 5_000,
        durationMs: 200_000
      }
    });
    await patch(stale.req, stale.res, vi.fn());

    expect(checkpoint.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: true,
      episode: expect.objectContaining({
        checkpointSeq: 2,
        listenedMs: 20_000,
        positionMs: 30_000
      })
    });
    expect(stale.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: false,
      episode: expect.objectContaining({
        checkpointSeq: 2,
        listenedMs: 20_000,
        positionMs: 30_000
      })
    });
  });

  it('normalizes fractional millisecond checkpoints from an already loaded player', async () => {
    const {
      createPatchListeningEpisodeHandler,
      createPutListeningEpisodeHandler
    } = await import('../../src/server/http/routes/listening-episodes.js');
    const create = createPutListeningEpisodeHandler();
    const patch = createPatchListeningEpisodeHandler();
    const created = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-fractional',
      body: {
        playerInstanceId: 'player-a',
        deckId: 'main',
        track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
        durationMs: 200_000,
        checkpointSeq: 0
      }
    });
    await create(created.req, created.res, vi.fn());

    const checkpoint = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-fractional',
      body: {
        checkpointSeq: 1,
        positionMs: 1_000.4,
        listenedMs: 1_000.75,
        durationMs: 200_000.4
      }
    });
    await patch(checkpoint.req, checkpoint.res, vi.fn());

    expect(checkpoint.res.status).not.toHaveBeenCalledWith(400);
    expect(checkpoint.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: true,
      episode: expect.objectContaining({
        checkpointSeq: 1,
        positionMs: 1_000,
        listenedMs: 1_001,
        durationMs: 200_000
      })
    });
  });

  it('creates and checkpoints an episode in one idempotent keepalive request', async () => {
    const { createPatchListeningEpisodeHandler } = await import(
      '../../src/server/http/routes/listening-episodes.js'
    );
    const patch = createPatchListeningEpisodeHandler();
    const body = {
      create: {
        playerInstanceId: 'player-pagehide',
        deckId: 'main',
        track: { id: 'keepalive-track', name: 'Keepalive Song', artists: ['Keepalive Artist'] },
        durationMs: 100_000,
        checkpointSeq: 0
      },
      checkpoint: {
        checkpointSeq: 1,
        positionMs: 5_000,
        listenedMs: 5_000,
        durationMs: 100_000
      }
    };

    const first = makeReqRes({
      userId: 'route-user', clientEpisodeId: 'episode-keepalive', body
    });
    await patch(first.req, first.res, vi.fn());
    const retried = makeReqRes({
      userId: 'route-user', clientEpisodeId: 'episode-keepalive', body
    });
    await patch(retried.req, retried.res, vi.fn());

    expect(first.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: true,
      episode: expect.objectContaining({
        clientEpisodeId: 'episode-keepalive',
        checkpointSeq: 1,
        positionMs: 5_000
      })
    });
    expect(retried.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: false,
      episode: expect.objectContaining({ checkpointSeq: 1, positionMs: 5_000 })
    });
    expect(indexPlayedTrackMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the same terminal outcome idempotently and rejects a different one', async () => {
    const {
      createPatchListeningEpisodeHandler,
      createPutListeningEpisodeHandler
    } = await import('../../src/server/http/routes/listening-episodes.js');
    const create = createPutListeningEpisodeHandler();
    const patch = createPatchListeningEpisodeHandler();
    const created = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-final',
      body: {
        playerInstanceId: 'player-a',
        deckId: 'main',
        track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
        durationMs: 200_000,
        checkpointSeq: 0
      }
    });
    await create(created.req, created.res, vi.fn());

    const finalBody = {
      checkpointSeq: 1,
      positionMs: 60_000,
      listenedMs: 30_000,
      durationMs: 200_000,
      outcome: 'skipped'
    };
    const finalized = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-final',
      body: finalBody
    });
    await patch(finalized.req, finalized.res, vi.fn());
    const retried = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-final',
      body: finalBody
    });
    await patch(retried.req, retried.res, vi.fn());
    const conflicting = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'episode-final',
      body: { ...finalBody, checkpointSeq: 2, outcome: 'completed' }
    });
    await patch(conflicting.req, conflicting.res, vi.fn());

    expect(finalized.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: true,
      episode: expect.objectContaining({ outcome: 'skipped', checkpointSeq: 1 })
    });
    expect(retried.res.json).toHaveBeenCalledWith({
      ok: true,
      updated: false,
      episode: expect.objectContaining({ outcome: 'skipped', checkpointSeq: 1 })
    });
    expect(conflicting.res.status).toHaveBeenCalledWith(409);
  });

  it('persists a 24-hour temporary exclusion only for a skip before halfway', async () => {
    const {
      createPatchListeningEpisodeHandler,
      createPutListeningEpisodeHandler
    } = await import('../../src/server/http/routes/listening-episodes.js');
    const { getActiveTemporaryQueueBans } = await import('../../src/server/store/temporary-bans.js');
    const create = createPutListeningEpisodeHandler();
    const patch = createPatchListeningEpisodeHandler();

    for (const [clientEpisodeId, positionMs] of [['early', 49_000], ['half', 50_000]] as const) {
      const created = makeReqRes({
        userId: 'route-user',
        clientEpisodeId,
        body: {
          playerInstanceId: 'player-a', deckId: 'main',
          track: { id: `${clientEpisodeId}-track`, name: `${clientEpisodeId} Song`, artists: ['Artist'] },
          durationMs: 100_000, checkpointSeq: 0
        }
      });
      await create(created.req, created.res, vi.fn());
      const finalized = makeReqRes({
        userId: 'route-user',
        clientEpisodeId,
        body: {
          checkpointSeq: 1, positionMs, listenedMs: 1_000,
          durationMs: 100_000, outcome: 'skipped'
        }
      });
      await patch(finalized.req, finalized.res, vi.fn());
    }

    expect(getActiveTemporaryQueueBans('route-user').map((ban) => ban.id)).toEqual(['early-track']);
  });

  it('repairs a missing early-skip exclusion when terminal finalization is retried', async () => {
    const { createPatchListeningEpisodeHandler } = await import(
      '../../src/server/http/routes/listening-episodes.js'
    );
    const {
      createListeningEpisode,
      finalizeListeningEpisode
    } = await import('../../src/server/store/listening-episodes.js');
    const { getActiveTemporaryQueueBans } = await import('../../src/server/store/temporary-bans.js');
    const createdAt = new Date(Date.now() - 5_000);
    createListeningEpisode('route-user', 'repair-early-skip', {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: { id: 'repair-track', name: 'Repair Song', artists: ['Artist'] },
      durationMs: 100_000,
      checkpointSeq: 0
    }, { now: createdAt });
    const finalBody = {
      checkpointSeq: 1,
      positionMs: 20_000,
      listenedMs: 4_000,
      durationMs: 100_000,
      outcome: 'skipped' as const
    };
    finalizeListeningEpisode('route-user', 'repair-early-skip', finalBody, {
      now: new Date(createdAt.getTime() + 4_000)
    });
    expect(getActiveTemporaryQueueBans('route-user')).toEqual([]);

    const retried = makeReqRes({
      userId: 'route-user',
      clientEpisodeId: 'repair-early-skip',
      body: finalBody
    });
    createPatchListeningEpisodeHandler()(retried.req, retried.res, vi.fn());

    expect(getActiveTemporaryQueueBans('route-user').map((ban) => ban.id)).toEqual(['repair-track']);
  });
});

function makeReqRes(input: {
  userId: string;
  clientEpisodeId: string;
  body: unknown;
}) {
  const req = {
    userId: input.userId,
    params: { clientEpisodeId: input.clientEpisodeId },
    body: input.body
  } as unknown as Request & { userId: string };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn()
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  return { req, res };
}
