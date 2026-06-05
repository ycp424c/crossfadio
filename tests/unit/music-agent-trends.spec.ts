import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrendContext, TrendTrackHint } from '../../src/server/music-agent/schema.js';

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  vi.resetModules();
  previousDataDir = process.env.CROSSFADIO_DATA_DIR;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-trends-'));
  process.env.CROSSFADIO_DATA_DIR = tempDataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = previousDataDir;
  }
  fs.rmSync(tempDataDir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe('music-agent trend context', () => {
  it('builds trend context from NCM trend endpoints', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends.js');
    const topSongHint: TrendTrackHint = {
      title: 'New Song',
      artist: 'New Artist',
      source: 'ncm_top_song',
      reason: '新歌速递'
    };
    const ncmClient = {
      getSearchHotDetail: vi.fn(async () => [
        { searchWord: '新晋女声', content: '热门搜索' }
      ]),
      getTopSongHints: vi.fn(async () => [topSongHint]),
      getArtistToplist: vi.fn(async () => ['Hot Artist'])
    };

    const context = await buildTrendContext({
      ncmClient,
      locale: 'zh-CN',
      maxFetchMs: 100
    });

    expect(context.sources).toContain('ncm_search_hot');
    expect(context.hotStyles).toContain('新晋女声');
    expect(context.hotArtists).toContain('Hot Artist');
    expect(context.chartTrackHints[0]?.title).toBe('New Song');
    expect(context.confidence).toBeGreaterThan(0);
  });

  it('returns fresh cache without depending on NCM', async () => {
    const { buildTrendContext, readTrendCache, writeTrendCache } = await import(
      '../../src/server/music-agent/trends.js'
    );
    const cached: TrendContext = {
      fetchedAt: new Date().toISOString(),
      locale: 'zh-CN',
      sources: ['manual_cache'],
      hotArtists: ['Cached Artist'],
      hotStyles: ['Cached Style'],
      chartTrackHints: [
        {
          title: 'Cached Song',
          artist: 'Cached Artist',
          source: 'manual_cache',
          reason: 'cached'
        }
      ],
      confidence: 1
    };
    await writeTrendCache(cached);
    const ncmClient = {
      getSearchHotDetail: vi.fn(async () => {
        throw new Error('should not fetch search hot');
      }),
      getTopSongHints: vi.fn(async () => {
        throw new Error('should not fetch top songs');
      }),
      getArtistToplist: vi.fn(async () => {
        throw new Error('should not fetch artists');
      })
    };

    await expect(readTrendCache('zh-CN')).resolves.toEqual(cached);
    await expect(
      buildTrendContext({ ncmClient, locale: 'zh-CN', maxFetchMs: 100 })
    ).resolves.toEqual(cached);
    expect(ncmClient.getSearchHotDetail).not.toHaveBeenCalled();
    expect(ncmClient.getTopSongHints).not.toHaveBeenCalled();
    expect(ncmClient.getArtistToplist).not.toHaveBeenCalled();
  });

  it('returns empty context when NCM trend methods fail', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends.js');
    const ncmClient = {
      getSearchHotDetail: vi.fn(async () => {
        throw new Error('search hot unavailable');
      }),
      getTopSongHints: vi.fn(async () => {
        throw new Error('top songs unavailable');
      }),
      getArtistToplist: vi.fn(async () => {
        throw new Error('artists unavailable');
      })
    };

    const context = await buildTrendContext({
      ncmClient,
      locale: 'zh-CN',
      maxFetchMs: 100,
      ttlMs: 0
    });

    expect(context.sources).toEqual([]);
    expect(context.hotStyles).toEqual([]);
    expect(context.hotArtists).toEqual([]);
    expect(context.chartTrackHints).toEqual([]);
    expect(context.confidence).toBe(0);
  });

  it('does not call NCM when trend fetch budget is exhausted', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends.js');
    const ncmClient = {
      getSearchHotDetail: vi.fn(async () => [{ searchWord: 'should not load' }]),
      getTopSongHints: vi.fn(async () => [
        {
          title: 'Should Not Load',
          artist: 'No Artist',
          source: 'ncm_top_song' as const,
          reason: 'budget exhausted'
        }
      ]),
      getArtistToplist: vi.fn(async () => ['Should Not Load'])
    };

    const context = await buildTrendContext({
      ncmClient,
      locale: 'zh-CN',
      maxFetchMs: 0,
      ttlMs: 0
    });

    expect(context.sources).toEqual([]);
    expect(context.confidence).toBe(0);
    expect(ncmClient.getSearchHotDetail).not.toHaveBeenCalled();
    expect(ncmClient.getTopSongHints).not.toHaveBeenCalled();
    expect(ncmClient.getArtistToplist).not.toHaveBeenCalled();
  });

  it('keeps successful trend sources when one NCM source fails', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends.js');
    const ncmClient = {
      getSearchHotDetail: vi.fn(async () => {
        throw new Error('search hot unavailable');
      }),
      getTopSongHints: vi.fn(async () => [
        {
          title: 'Partial Song',
          artist: 'Partial Artist',
          source: 'ncm_top_song' as const,
          reason: '新歌速递'
        }
      ]),
      getArtistToplist: vi.fn(async () => ['Partial Artist'])
    };

    const context = await buildTrendContext({
      ncmClient,
      locale: 'zh-CN',
      maxFetchMs: 100,
      ttlMs: 0
    });

    expect(context.sources).toEqual(['ncm_top_song', 'ncm_artist_toplist']);
    expect(context.hotStyles).toEqual([]);
    expect(context.chartTrackHints[0]?.title).toBe('Partial Song');
    expect(context.hotArtists).toEqual(['Partial Artist']);
    expect(context.confidence).toBeCloseTo(2 / 3);
  });

  it('returns null when cached JSON is invalid', async () => {
    const cachePath = path.join(tempDataDir, 'cache', 'trends', 'zh-CN.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{invalid', 'utf8');
    const { readTrendCache } = await import('../../src/server/music-agent/trends.js');

    await expect(readTrendCache('zh-CN')).resolves.toBeNull();
  });
});
