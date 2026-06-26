import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalEmbeddingApiKey = process.env.CROSSFADIO_EMBEDDING_API_KEY;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-entity-indexer-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  delete process.env.CROSSFADIO_EMBEDDING_API_KEY;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  if (originalEmbeddingApiKey === undefined) delete process.env.CROSSFADIO_EMBEDDING_API_KEY;
  else process.env.CROSSFADIO_EMBEDDING_API_KEY = originalEmbeddingApiKey;
});

describe('music entity indexer', () => {
  it('indexes liked NCM tracks into semantic entities and embeddings', async () => {
    const { runMusicEntityIndex } = await import('../../src/server/music-agent/entity-indexer.js');
    const {
      findSimilarMusicEntities,
      getMusicEntity
    } = await import('../../src/server/store/music-entities.js');
    const { getMusicEntityIndexState } = await import('../../src/server/store/music-entity-index-state.js');
    const logger = createLogger();
    const embeddingClient = createEmbeddingClient([
      Float32Array.from([1, 0, 0]),
      Float32Array.from([0.9, 0.1, 0])
    ]);
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['101', '102']),
      getSongDetails: vi.fn().mockResolvedValue([
        { id: '101', name: '红色高跟鞋', artists: ['蔡健雅'] },
        { id: '102', name: 'My Cookie Can', artists: ['卫兰'] }
      ])
    };

    const result = await runMusicEntityIndex({
      userId: 'user-index',
      ncmClient,
      embeddingClient,
      sources: ['liked'],
      limits: { liked: 2 },
      logger
    });

    expect(result).toMatchObject({
      status: 'completed',
      seenCount: 2,
      upsertedCount: 2,
      embeddedCount: 2,
      skippedCount: 0
    });
    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(['101', '102']);

    const entity = getMusicEntity('user-index', 'ncm:track:101');
    expect(entity).toMatchObject({
      type: 'track',
      provider: 'ncm',
      providerId: '101',
      title: '红色高跟鞋',
      artist: '蔡健雅'
    });
    expect(entity?.description).toContain('source: liked');
    expect(entity?.sourceSignals).toEqual(['liked', 'verified_track', 'ncm', 'entity_indexer']);

    const matches = findSimilarMusicEntities({
      userId: 'user-index',
      model: 'test-embedding',
      vector: Float32Array.from([1, 0, 0]),
      limit: 2
    });
    expect(matches.map((match) => match.entity.id)).toEqual(['ncm:track:101', 'ncm:track:102']);

    expect(getMusicEntityIndexState('user-index', 'liked')).toMatchObject({
      source: 'liked',
      cursor: '2/2',
      lastError: null
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-index',
        sources: ['liked'],
        sourceCounts: { liked: 2 },
        seenCount: 2,
        upsertedCount: 2,
        embeddedCount: 2,
        skippedCount: 0,
        embeddingModel: 'test-embedding'
      }),
      'Music entity index run completed'
    );
  });

  it('records source errors without throwing from the index run', async () => {
    const { runMusicEntityIndex } = await import('../../src/server/music-agent/entity-indexer.js');
    const { getMusicEntityIndexState } = await import('../../src/server/store/music-entity-index-state.js');
    const logger = createLogger();

    const result = await runMusicEntityIndex({
      userId: 'user-error',
      ncmClient: {
        getLikedSongIds: vi.fn().mockRejectedValue(new Error('ncm unavailable')),
        getSongDetails: vi.fn()
      },
      embeddingClient: createEmbeddingClient([]),
      sources: ['liked'],
      logger
    });

    expect(result.status).toBe('failed');
    expect(result.errors).toEqual({ liked: 'ncm unavailable' });
    expect(getMusicEntityIndexState('user-error', 'liked')?.lastError).toBe('ncm unavailable');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        userId: 'user-error',
        source: 'liked'
      }),
      'Music entity index source failed'
    );
  });

  it('still writes entities and logs clearly when embedding is unavailable', async () => {
    const { runMusicEntityIndex } = await import('../../src/server/music-agent/entity-indexer.js');
    const { getMusicEntity } = await import('../../src/server/store/music-entities.js');
    const logger = createLogger();

    const result = await runMusicEntityIndex({
      userId: 'user-no-embedding',
      ncmClient: {
        getLikedSongIds: vi.fn().mockResolvedValue(['201']),
        getSongDetails: vi.fn().mockResolvedValue([
          { id: '201', name: '没有人知道', artists: ['声音碎片'] }
        ])
      },
      embeddingClient: null,
      sources: ['liked'],
      logger
    });

    expect(result).toMatchObject({
      status: 'completed',
      seenCount: 1,
      upsertedCount: 1,
      embeddedCount: 0
    });
    expect(getMusicEntity('user-no-embedding', 'ncm:track:201')?.title).toBe('没有人知道');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-no-embedding',
        entityCount: 1
      }),
      'Music entity index embedding skipped: embedding client unavailable'
    );
  });

  it('backfills the current played track immediately', async () => {
    const { indexPlayedTrack } = await import('../../src/server/music-agent/entity-indexer.js');
    const {
      findSimilarMusicEntities,
      getMusicEntity
    } = await import('../../src/server/store/music-entities.js');
    const logger = createLogger();

    const result = await indexPlayedTrack({
      userId: 'user-play',
      track: { songId: '303', songName: 'Afterglow', artistName: 'Taylor Swift' },
      embeddingClient: createEmbeddingClient([Float32Array.from([0, 1])]),
      logger
    });

    expect(result).toMatchObject({
      status: 'completed',
      seenCount: 1,
      upsertedCount: 1,
      embeddedCount: 1
    });
    expect(getMusicEntity('user-play', 'ncm:track:303')).toMatchObject({
      title: 'Afterglow',
      artist: 'Taylor Swift',
      sourceSignals: ['play_start', 'verified_play', 'ncm', 'entity_indexer']
    });
    expect(findSimilarMusicEntities({
      userId: 'user-play',
      model: 'test-embedding',
      vector: Float32Array.from([0, 1]),
      limit: 1
    })[0]?.entity.id).toBe('ncm:track:303');
  });

  it('clears previous embedding errors after embeddings succeed', async () => {
    const { runMusicEntityIndex } = await import('../../src/server/music-agent/entity-indexer.js');
    const { getMusicEntityIndexState } = await import('../../src/server/store/music-entity-index-state.js');
    const logger = createLogger();
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['401']),
      getSongDetails: vi.fn().mockResolvedValue([
        { id: '401', name: 'Sweet Talk', artists: ['Samantha Jade'] }
      ])
    };

    const failedResult = await runMusicEntityIndex({
      userId: 'user-embedding-retry',
      ncmClient,
      embeddingClient: {
        embed: vi.fn().mockRejectedValue(new Error('embedding service down'))
      },
      sources: ['liked'],
      logger
    });

    expect(failedResult.status).toBe('partial');
    expect(getMusicEntityIndexState('user-embedding-retry', 'embedding')?.lastError).toBe(
      'embedding service down'
    );

    const recoveredResult = await runMusicEntityIndex({
      userId: 'user-embedding-retry',
      ncmClient,
      embeddingClient: createEmbeddingClient([Float32Array.from([0.5, 0.5])]),
      sources: ['liked'],
      logger
    });

    expect(recoveredResult.status).toBe('completed');
    expect(getMusicEntityIndexState('user-embedding-retry', 'embedding')).toMatchObject({
      lastError: null
    });
  });

  it('schedules a retry when recent plays has a stale error even if liked is fresh', async () => {
    const {
      scheduleMusicEntityIndexIfDue,
      _resetMusicEntityIndexSchedulerForTest
    } = await import('../../src/server/music-agent/entity-indexer.js');
    const {
      getMusicEntityIndexState,
      recordMusicEntityIndexError,
      recordMusicEntityIndexSuccess
    } = await import('../../src/server/store/music-entity-index-state.js');
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue([]),
      getSongDetails: vi.fn()
    };

    recordMusicEntityIndexSuccess({
      userId: 'user-recent-retry',
      source: 'liked',
      ranAt: new Date().toISOString()
    });
    recordMusicEntityIndexError({
      userId: 'user-recent-retry',
      source: 'recent_plays',
      error: 'recent plays load failed',
      ranAt: new Date(Date.now() - 31 * 60 * 1000).toISOString()
    });

    scheduleMusicEntityIndexIfDue('user-recent-retry', ncmClient);

    await vi.waitFor(() => {
      expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(getMusicEntityIndexState('user-recent-retry', 'recent_plays')).toMatchObject({
        lastError: null
      });
    });
    _resetMusicEntityIndexSchedulerForTest();
  });

  it('records source errors instead of success when persistence fails', async () => {
    const { runMusicEntityIndex } = await import('../../src/server/music-agent/entity-indexer.js');
    const { getDb } = await import('../../src/server/store/db.js');
    const { getMusicEntityIndexState } = await import('../../src/server/store/music-entity-index-state.js');
    const logger = createLogger();

    getDb().exec(`
      DROP TABLE music_entity_embeddings;
      DROP TABLE music_entities;
    `);

    await expect(runMusicEntityIndex({
      userId: 'user-persist-fail',
      ncmClient: {
        getLikedSongIds: vi.fn().mockResolvedValue(['501']),
        getSongDetails: vi.fn().mockResolvedValue([
          { id: '501', name: 'Persistence Blues', artists: ['Broken Table'] }
        ])
      },
      embeddingClient: null,
      sources: ['liked'],
      logger
    })).rejects.toThrow(/music_entities/);

    expect(getMusicEntityIndexState('user-persist-fail', 'liked')).toMatchObject({
      lastError: expect.stringContaining('music_entities')
    });
  });
});

function createEmbeddingClient(vectors: Float32Array[]) {
  return {
    embed: vi.fn(async (input: string | string[]) => {
      const inputs = Array.isArray(input) ? input : [input];
      return {
        vectors: inputs.map((_, index) => vectors[index] ?? Float32Array.from([1, 0])),
        model: 'test-embedding',
        dimensions: vectors[0]?.length ?? 2
      };
    })
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
