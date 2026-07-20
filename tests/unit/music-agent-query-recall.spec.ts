import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import {
  runRecallFromQueries,
  type QueryRecallState
} from '../../src/server/music-agent/query-recall';
import { queryFunnelSnapshot } from '../../src/server/music-agent/query-funnel';
import { _resetLikedRecallCacheForTest } from '../../src/server/music-agent/liked-recall';
import type { EntityRecallNcmClient } from '../../src/server/music-agent/entity-recall';
import type { MusicAgentContextSummary, MusicCandidate, MusicCandidateScores } from '../../src/server/music-agent/schema';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  _resetLikedRecallCacheForTest();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-query-recall-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { _resetDbForTest, initDb } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('MusicAgent query recall', () => {
  it('recalls exact query tracks, records query funnel, and keeps exact-recall provenance', async () => {
    const pool = new CandidatePool();
    const queryState = state();
    const consumeNcmSearch = vi.fn(() => true);
    const ncmClient = ncmClientStub({
      searchSongs: vi.fn(async () => [{
        id: 'query-track-1',
        name: 'Exact Song',
        artists: ['Exact Artist']
      }])
    });

    const result = await runRecallFromQueries({
      queries: ['Exact Song Exact Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-recall-user',
      ncmClient,
      candidatePool: pool,
      context: context(),
      queryPlan: null,
      queryState,
      consumeNcmSearch,
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    });

    expect(result.summary).toContain('网易云搜索 recall searched 1 queries and added 1 candidates');
    expect(result.problems).toEqual(['candidate admission: inserted=1']);
    expect(consumeNcmSearch).toHaveBeenCalledTimes(1);
    expect(pool.list()).toEqual([
      expect.objectContaining({
        id: 'query-track-1',
        sources: ['search'],
        provenance: [{ kind: 'exact_recall', source: 'search' }],
        evidence: ['网易云搜索: Exact Song Exact Artist']
      })
    ]);
    expect(queryFunnelSnapshot(queryState)).toEqual([
      expect.objectContaining({
        query: 'Exact Song Exact Artist',
        source: 'search',
        searchedCount: 1,
        resultCount: 1,
        addedCount: 1,
        uniqueResultCount: 1
      })
    ]);
  });

  it('skips repeated exact query searches within the same run state', async () => {
    const pool = new CandidatePool();
    const queryState = state();
    const ncmClient = ncmClientStub({
      searchSongs: vi.fn(async () => [{
        id: 'repeat-track-1',
        name: 'Repeat Song',
        artists: ['Repeat Artist']
      }])
    });
    const base = {
      queries: ['Repeat Song Repeat Artist'],
      source: 'search' as const,
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-recall-user',
      ncmClient,
      candidatePool: pool,
      context: context(),
      queryPlan: null,
      queryState,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    };

    await runRecallFromQueries(base);
    const repeated = await runRecallFromQueries(base);

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(repeated.summary).toContain('网易云搜索 recall searched 0 queries and added 0 candidates');
    expect(repeated.problems).toContain('skipped 1 repeated search query in this run');
  });

  it('keeps liked explore search results observable until Selection Policy', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({
      id: 'liked-song',
      name: 'Liked Song',
      artist: 'Liked Artist',
      sources: ['liked']
    }));
    const queryState = state();
    const ncmClient = ncmClientStub({
      getLikedSongIds: vi.fn(async () => ['liked-song', 'liked-artist-anchor']),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => id === 'liked-song'
        ? { id, name: 'Liked Song', artists: ['Liked Artist'] }
        : { id, name: 'Liked Artist Anchor', artists: ['Known Artist / Guest Artist'] })),
      searchSongs: vi.fn(async () => [
        { id: 'liked-song', name: 'Liked Song', artists: ['Liked Artist'] },
        { id: 'same-artist-search', name: 'Same Artist Search', artists: ['Known Artist'] },
        { id: 'fresh-search', name: 'Fresh Search', artists: ['Fresh Artist'] }
      ])
    });

    const result = await runRecallFromQueries({
      queries: ['Known Song Known Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-liked-dedupe-user',
      ncmClient,
      candidatePool: pool,
      context: context({ discoveryMode: 'explore' }),
      queryPlan: null,
      queryState,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    });

    expect(result.summary).toContain('added 3 candidates');
    expect(result.problems).not.toContain('skipped 1 liked tracks from discovery search results');
    expect(pool.list().map((item) => item.id)).toEqual(['liked-song', 'same-artist-search', 'fresh-search']);
    expect(pool.get('liked-song')?.sources).toEqual(['liked', 'search']);
    expect(pool.get('same-artist-search')?.scores).not.toHaveProperty('recentPenalty');
    expect(pool.get('fresh-search')?.scores).not.toHaveProperty('recentPenalty');
    expect(queryFunnelSnapshot(queryState)).toEqual([
      expect.objectContaining({
        query: 'Known Song Known Artist',
        resultCount: 3,
        uniqueResultCount: 3,
        addedCount: 3
      })
    ]);
  });

  it('does not invent an artist fallback when liked-only search results remain eligible', async () => {
    const pool = new CandidatePool();
    const queryState = state();
    const ncmClient = ncmClientStub({
      getLikedSongIds: vi.fn(async () => ['liked-song']),
      getSongDetails: vi.fn(async () => [
        { id: 'liked-song', name: 'Known Song', artists: ['Known Artist'] }
      ]),
      searchSongs: vi.fn(async () => [
        { id: 'liked-song', name: 'Known Song', artists: ['Known Artist'] }
      ]),
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Known Artist' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'fresh-fallback', name: 'Fresh Fallback', artists: ['Known Artist'] }
      ])
    });

    const result = await runRecallFromQueries({
      queries: ['Only Liked Known Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-liked-only-fallback-user',
      ncmClient,
      candidatePool: pool,
      context: context({ discoveryMode: 'explore' }),
      queryPlan: null,
      queryState,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    });

    expect(result.summary).toContain('added 1 candidates');
    expect(result.problems).not.toContain('skipped 1 liked tracks from discovery search results');
    expect(pool.list().map((item) => item.id)).toEqual(['liked-song']);
    expect(ncmClient.searchArtists).not.toHaveBeenCalled();
    expect(ncmClient.getArtistTopSongs).not.toHaveBeenCalled();
    expect(queryFunnelSnapshot(queryState)).toEqual([
      expect.objectContaining({
        query: 'Only Liked Known Artist',
        resultCount: 1,
        uniqueResultCount: 1,
        addedCount: 1
      })
    ]);
  });

  it('does not load a parallel liked profile before explore search admission', async () => {
    const pool = new CandidatePool();
    const queryState = state();
    const ncmClient = ncmClientStub({
      getLikedSongIds: vi.fn(async () => ['liked-song']),
      getSongDetails: vi.fn(async () => {
        throw new Error('detail timeout');
      }),
      searchSongs: vi.fn(async () => [
        { id: 'liked-song', name: 'Liked Song', artists: ['Liked Artist'] },
        { id: 'same-artist-search', name: 'Same Artist Search', artists: ['Liked Artist'] }
      ])
    });

    const result = await runRecallFromQueries({
      queries: ['Liked Song Liked Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-liked-detail-failure-user',
      ncmClient,
      candidatePool: pool,
      context: context({ discoveryMode: 'explore' }),
      queryPlan: null,
      queryState,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    });

    expect(result.summary).toContain('added 2 candidates');
    expect(result.problems).not.toContain('liked artist profile unavailable');
    expect(result.problems).not.toContain('skipped 1 liked tracks from discovery search results');
    expect(ncmClient.getLikedSongIds).not.toHaveBeenCalled();
    expect(ncmClient.getSongDetails).not.toHaveBeenCalled();
    expect(pool.list().map((item) => item.id)).toEqual(['liked-song', 'same-artist-search']);
    expect(pool.get('same-artist-search')?.scores).not.toHaveProperty('recentPenalty');
    expect(queryFunnelSnapshot(queryState)).toEqual([
      expect.objectContaining({
        query: 'Liked Song Liked Artist',
        resultCount: 2,
        uniqueResultCount: 2,
        addedCount: 2
      })
    ]);
  });

  it('keeps comfort search independent from the liked search guard', async () => {
    const pool = new CandidatePool();
    const queryState = state();
    const ncmClient = ncmClientStub({
      getLikedSongIds: vi.fn(async () => ['liked-song']),
      getSongDetails: vi.fn(async () => [
        { id: 'liked-song', name: 'Liked Song', artists: ['Liked Artist'] }
      ]),
      searchSongs: vi.fn(async () => [
        { id: 'liked-song', name: 'Liked Song', artists: ['Liked Artist'] }
      ])
    });

    await runRecallFromQueries({
      queries: ['Comfort Song Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-comfort-user',
      ncmClient,
      candidatePool: pool,
      context: context({ discoveryMode: 'comfort' }),
      queryPlan: null,
      queryState,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5
    });

    expect(ncmClient.getLikedSongIds).not.toHaveBeenCalled();
    expect(pool.list().map((item) => item.id)).toEqual(['liked-song']);
    expect(pool.get('liked-song')?.sources).toEqual(['search']);
  });

  it('returns alternative_query_required when autonomous retrieval history blocks every query', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    appendRetrievalAttempts({
      userId: 'query-history-user',
      runId: 'previous-run',
      requestKind: 'autonomous',
      attemptedAt: new Date(Date.now() - 10 * 60 * 1_000),
      entries: [{
        query: 'Repeat Song Repeat Artist',
        normalizedQuery: 'repeat song repeat artist',
        source: 'search',
        searchedCount: 1,
        resultCount: 4,
        addedCount: 1,
        selectedCount: 0,
      }],
    });
    const searchSongs = vi.fn(async () => []);

    const result = await runRecallFromQueries({
      queries: ['Repeat Song Repeat Artist'],
      source: 'search',
      evidencePrefix: '网易云搜索',
      scores: scores(),
      userId: 'query-history-user',
      ncmClient: ncmClientStub({ searchSongs }),
      candidatePool: new CandidatePool(),
      context: context({ request: 'auto-fill' }),
      queryPlan: null,
      queryState: state(),
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 5,
    });

    expect(searchSongs).not.toHaveBeenCalled();
    expect(result.problems).toContain('alternative_query_required');
  });
});

function state(): QueryRecallState {
  return {
    queryFunnel: new Map(),
    searchedQueryLimits: new Map()
  };
}

function ncmClientStub(overrides: Partial<EntityRecallNcmClient> = {}): EntityRecallNcmClient {
  return {
    getLikedSongIds: vi.fn(async () => []),
    getSongDetails: vi.fn(async () => []),
    searchSongs: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    ...overrides
  };
}

function context(overrides: Partial<MusicAgentContextSummary> = {}): MusicAgentContextSummary {
  return {
    request: 'chat-recommend',
    discoveryMode: 'explore',
    currentUserText: '',
    currentMoment: { localTime: '周五 15:00', daypart: '下午', weather: null },
    activeDirective: '',
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}

function scores(): MusicCandidateScores {
  return {
    intentMatch: 0.7,
    tasteMatch: 0.7,
    timeFit: 0.7,
    contextFit: 0.5,
    novelty: 0.5,
    sourceConfidence: 0.7
  };
}

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'candidate',
    name: 'Song',
    artist: 'Artist',
    sources: ['search'],
    evidence: [],
    scores: scores(),
    ...overrides
  };
}
