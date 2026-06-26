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
import type { EntityRecallNcmClient } from '../../src/server/music-agent/entity-recall';
import type { MusicAgentContextSummary, MusicCandidateScores } from '../../src/server/music-agent/schema';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
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
      avoidArtists: new Set(),
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
      avoidArtists: new Set<string>(),
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

function context(): MusicAgentContextSummary {
  return {
    request: 'chat-recommend',
    discoveryMode: 'explore',
    currentUserText: '',
    currentMoment: { localTime: '周五 15:00', daypart: '下午', weather: null },
    activeDirective: '',
    currentPlanSegment: null,
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}

function scores(): MusicCandidateScores {
  return {
    intentMatch: 0.7,
    tasteMatch: 0.7,
    timeFit: 0.7,
    planFit: 0.5,
    novelty: 0.5,
    recentPenalty: 0,
    skipPenalty: 0,
    sourceConfidence: 0.7
  };
}
