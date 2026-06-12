import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-music-entities-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('music entity store', () => {
  it('upserts verified music entities with provenance and semantic hints', async () => {
    const {
      getMusicEntity,
      upsertMusicEntity
    } = await import('../../src/server/store/music-entities.js');

    upsertMusicEntity({
      userId: 'user-entity',
      id: 'ncm:track:101',
      type: 'track',
      provider: 'ncm',
      providerId: '101',
      title: 'Candy',
      artist: '具島直子',
      album: 'miss.G',
      description: 'track: Candy\nartist: 具島直子\nstyle: city pop\nfit: relaxed afternoon female vocal',
      styleHints: ['city pop', 'japanese pop'],
      constraints: ['下午', '中低能量', '女声'],
      sourceSignals: ['liked', 'verified_track'],
      lastVerifiedAt: '2026-06-12T09:00:00.000Z'
    });

    const entity = getMusicEntity('user-entity', 'ncm:track:101');

    expect(entity).toMatchObject({
      userId: 'user-entity',
      id: 'ncm:track:101',
      type: 'track',
      provider: 'ncm',
      providerId: '101',
      title: 'Candy',
      artist: '具島直子',
      album: 'miss.G',
      selectedCount: 0,
      skippedCount: 0,
      lastVerifiedAt: '2026-06-12T09:00:00.000Z'
    });
    expect(entity?.styleHints).toEqual(['city pop', 'japanese pop']);
    expect(entity?.constraints).toEqual(['下午', '中低能量', '女声']);
    expect(entity?.sourceSignals).toEqual(['liked', 'verified_track']);
  });

  it('records entity feedback separately from query stats', async () => {
    const {
      getMusicEntity,
      recordMusicEntityFeedback,
      upsertMusicEntity
    } = await import('../../src/server/store/music-entities.js');
    const { getUserQueryStats } = await import('../../src/server/store/music-query-stats.js');

    upsertMusicEntity({
      userId: 'user-feedback',
      id: 'catalog:artist:gu-shima',
      type: 'artist',
      provider: 'catalog',
      title: '具島直子',
      description: 'artist: 具島直子\nstyle: city pop\nfit: relaxed female vocal',
      styleHints: ['city pop'],
      constraints: ['女声'],
      sourceSignals: ['seed_catalog']
    });

    recordMusicEntityFeedback({
      userId: 'user-feedback',
      entityId: 'catalog:artist:gu-shima',
      selectedCount: 2,
      skippedCount: 1,
      usedAt: '2026-06-12T10:00:00.000Z'
    });

    const entity = getMusicEntity('user-feedback', 'catalog:artist:gu-shima');
    expect(entity?.selectedCount).toBe(2);
    expect(entity?.skippedCount).toBe(1);
    expect(entity?.lastUsedAt).toBe('2026-06-12T10:00:00.000Z');
    expect(getUserQueryStats('user-feedback')).toEqual([]);
  });

  it('loads similar embedded entities with user and model isolation', async () => {
    const {
      findSimilarMusicEntities,
      upsertMusicEntity,
      upsertMusicEntityEmbedding
    } = await import('../../src/server/store/music-entities.js');

    upsertMusicEntity({
      userId: 'user-similar',
      id: 'track:city',
      type: 'track',
      provider: 'ncm',
      providerId: '201',
      title: 'City Light',
      artist: 'Fresh Artist',
      description: 'city pop relaxed female vocal',
      styleHints: ['city pop'],
      constraints: ['下午'],
      sourceSignals: ['liked']
    });
    upsertMusicEntity({
      userId: 'user-similar',
      id: 'track:rock',
      type: 'track',
      provider: 'ncm',
      providerId: '202',
      title: 'Rock Signal',
      artist: 'Loud Artist',
      description: 'rock guitar high energy',
      styleHints: ['rock'],
      constraints: ['高能量'],
      sourceSignals: ['history']
    });
    upsertMusicEntity({
      userId: 'other-user',
      id: 'track:other',
      type: 'track',
      provider: 'ncm',
      providerId: '203',
      title: 'Other City',
      artist: 'Other Artist',
      description: 'city pop relaxed',
      styleHints: ['city pop'],
      constraints: ['下午'],
      sourceSignals: ['liked']
    });

    upsertMusicEntityEmbedding({
      userId: 'user-similar',
      entityId: 'track:city',
      model: 'text-embedding-v4',
      vector: Float32Array.from([1, 0])
    });
    upsertMusicEntityEmbedding({
      userId: 'user-similar',
      entityId: 'track:rock',
      model: 'text-embedding-v4',
      vector: Float32Array.from([0, 1])
    });
    upsertMusicEntityEmbedding({
      userId: 'other-user',
      entityId: 'track:other',
      model: 'text-embedding-v4',
      vector: Float32Array.from([1, 0])
    });

    const matches = findSimilarMusicEntities({
      userId: 'user-similar',
      model: 'text-embedding-v4',
      vector: Float32Array.from([0.9, 0.1]),
      limit: 2
    });

    expect(matches.map((match) => match.entity.id)).toEqual(['track:city', 'track:rock']);
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
    expect(matches.map((match) => match.entity.userId)).toEqual(['user-similar', 'user-similar']);
  });
});
