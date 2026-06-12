import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-query-stats-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('music-agent query stats', () => {
  it('preserves exact query terms while normalizing whitespace', async () => {
    const { sanitizeSearchQuery } = await import('../../src/server/music-agent/query-stats.js');

    expect(sanitizeSearchQuery(' 午后   city pop ')).toBe('午后 city pop');
    expect(sanitizeSearchQuery('深夜高速')).toBe('深夜高速');
    expect(sanitizeSearchQuery('夜里 安静 女声')).toBe('夜里 安静 女声');
  });

  it('persists and penalizes repeated user queries behind fresh alternatives', async () => {
    const {
      prepareSearchQueriesForRecall,
      recordUserQueryFunnel
    } = await import('../../src/server/music-agent/query-stats.js');

    recordUserQueryFunnel('query-user-repeat', [
      {
        query: '天空 女声',
        normalizedQuery: '天空 女声',
        source: 'search',
        searchedCount: 1,
        resultCount: 4,
        addedCount: 2,
        selectedCount: 0,
        scoreMultiplier: 1,
        repeatPenalty: 0,
        selectionRate: null
      }
    ]);

    const { _resetDbForTest, initDb } = await import('../../src/server/store/db.js');
    _resetDbForTest();
    initDb();

    const prepared = prepareSearchQueriesForRecall({
      userId: 'query-user-repeat',
      queries: ['天空 女声', '海洋 女声'],
      source: 'search',
      maxQueries: 2
    });

    expect(prepared.queries).toEqual(['海洋 女声', '天空 女声']);
    expect(prepared.funnelEntries[1]).toMatchObject({
      query: '天空 女声',
      repeatPenalty: expect.any(Number)
    });
    expect(prepared.funnelEntries[1].repeatPenalty).toBeGreaterThan(0);
  });

  it('gives a warm boost to queries with a better historical selection rate', async () => {
    const {
      prepareSearchQueriesForRecall,
      recordUserQueryFunnel
    } = await import('../../src/server/music-agent/query-stats.js');

    recordUserQueryFunnel('query-user-quality', [
      {
        query: '城市 女声',
        normalizedQuery: '城市 女声',
        source: 'search',
        searchedCount: 1,
        resultCount: 5,
        addedCount: 4,
        selectedCount: 2,
        scoreMultiplier: 1,
        repeatPenalty: 0,
        selectionRate: null
      },
      {
        query: '天空 女声',
        normalizedQuery: '天空 女声',
        source: 'search',
        searchedCount: 1,
        resultCount: 5,
        addedCount: 4,
        selectedCount: 0,
        scoreMultiplier: 1,
        repeatPenalty: 0,
        selectionRate: null
      }
    ]);

    const prepared = prepareSearchQueriesForRecall({
      userId: 'query-user-quality',
      queries: ['天空 女声', '城市 女声'],
      source: 'search',
      maxQueries: 2
    });

    expect(prepared.queries).toEqual(['城市 女声', '天空 女声']);
    expect(prepared.funnelEntries[0].selectionRate).toBeGreaterThan(
      prepared.funnelEntries[1].selectionRate ?? -1
    );
  });

  it('keeps very recent repeats behind fresh alternatives even after a warm selection boost', async () => {
    const {
      prepareSearchQueriesForRecall,
      recordUserQueryFunnel
    } = await import('../../src/server/music-agent/query-stats.js');

    recordUserQueryFunnel('query-user-repeat-boost', [
      {
        query: '城市 synth pop',
        normalizedQuery: '城市 synth pop',
        source: 'search',
        searchedCount: 1,
        resultCount: 8,
        addedCount: 2,
        selectedCount: 1,
        scoreMultiplier: 1,
        repeatPenalty: 0,
        selectionRate: null
      }
    ]);

    const prepared = prepareSearchQueriesForRecall({
      userId: 'query-user-repeat-boost',
      queries: ['城市 synth pop', '华语女声'],
      source: 'search',
      maxQueries: 2
    });

    expect(prepared.queries).toEqual(['华语女声', '城市 synth pop']);
    expect(prepared.funnelEntries[1]).toMatchObject({
      query: '城市 synth pop',
      selectionRate: 0.5
    });
    expect(prepared.funnelEntries[1].repeatPenalty).toBeGreaterThan(0.25);
  });
});
