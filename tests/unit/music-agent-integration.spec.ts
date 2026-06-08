import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCompleteOptions, LlmMessage, LlmResponse } from '../../src/server/llm/client.js';
import type { MusicAgentLlmClient } from '../../src/server/music-agent/schema.js';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

vi.mock('../../src/server/weather.js', () => ({
  fetchWeather: vi.fn(async () => null)
}));

class FakeLlmClient implements MusicAgentLlmClient {
  readonly completeCalls: Array<{ messages: LlmMessage[]; opts?: LlmCompleteOptions }> = [];
  private readonly responses: string[] = [];

  queueResponse(content: string): this {
    this.responses.push(content);
    return this;
  }

  async complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmResponse> {
    this.completeCalls.push({ messages: [...messages], opts });
    return { content: this.responses.shift() ?? '{}', model: 'fake-music-agent-model' };
  }
}

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-music-agent-integration-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('MusicAgent facade', () => {
  it('allows ten LLM calls for automatic pick-next runs', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/server/music-agent/index.ts'), 'utf8');
    const pickNextBudget = source.slice(source.indexOf('function pickNextBudget'), source.indexOf('function chatRecommendBudget'));

    expect(pickNextBudget).toContain('maxLlmCalls: 10');
  });

  it('labels local ranked convergence separately from fallback logs', async () => {
    const { musicAgentRunLogMessage } = await import('../../src/server/music-agent/index.js');
    const baseEvent = {
      mode: 'pick_next',
      status: 'ok',
      candidateCount: 2,
      pickCount: 2,
      step: 1,
      llmCalls: 1,
      toolCalls: 1,
      elapsedMs: 100,
      budget: {
        maxMs: 60_000,
        maxSteps: 8,
        maxLlmCalls: 4,
        maxToolCalls: 8,
        maxNcmSearches: 8,
        maxPlaylistFetches: 3,
        maxTrendFetchMs: 2_000,
        maxCandidates: 120
      }
    } as const;

    expect(musicAgentRunLogMessage({ ...baseEvent, reason: 'ranked_tool_completed' }))
      .toBe('MusicAgent ranked convergence');
    expect(musicAgentRunLogMessage({ ...baseEvent, reason: 'budget_reached' }))
      .toBe('MusicAgent ranked fallback');
  });

  it('recalls liked songs and returns a validated run output', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['101']),
      getSongDetails: vi.fn(async () => [
        { id: 101, name: 'Soft Song', artists: ['Singer'], durationMs: 200_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 5 } }))
      .queueResponse(JSON.stringify({
        type: 'final',
        say: '这首来自你的红心歌单。',
        picks: [{ id: '101', reason: '红心里适合当下的一首', source: 'liked' }],
        rejected: []
      }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const { musicAgentRunOutputSchema } = await import('../../src/server/music-agent/schema.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({ userId: 'user-1', ncmClient: ncmClient as any });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.picks[0].id).toBe('101');
    expect(result.say).toContain('红心');
    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(['101']);
  });

  it('excludes queued and recently played tracks before ranking MusicAgent candidates', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['queued-id', 'duplicate-id', 'fresh-1', 'fresh-2']),
      getSongDetails: vi.fn(async () => [
        { id: 'queued-id', name: 'Queued Song', artists: ['Queued Artist'], durationMs: 200_000 },
        { id: 'duplicate-id', name: 'Recent Song (Live)', artists: ['Recent Artist'], durationMs: 200_000 },
        { id: 'fresh-1', name: 'Fresh One', artists: ['Fresh Artist'], durationMs: 200_000 },
        { id: 'fresh-2', name: 'Fresh Two', artists: ['Another Artist'], durationMs: 200_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 10 } }))
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const { buildCandidateDedupeKey } = await import('../../src/server/music-agent/candidates.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      excludeTrackIds: new Set(['queued-id']),
      excludeTrackDedupeKeys: new Set([buildCandidateDedupeKey({ name: 'Recent Song', artist: 'Recent Artist' })])
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['fresh-1', 'fresh-2']);
    expect(JSON.stringify(result.trace)).not.toContain('queued-id');
    expect(JSON.stringify(result.trace)).not.toContain('duplicate-id');
  });

  it('passes chat recommendation text into the tool-loop prompt', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const fake = new FakeLlmClient().queueResponse('not json at all');

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    await agent.recommendFromChat({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      userText: '想听低沉一点的爵士女声，不要太吵'
    });

    expect(JSON.stringify(fake.completeCalls[0].messages)).toContain('想听低沉一点的爵士女声，不要太吵');
  });

  it('passes resolved chat action queries into the tool-loop prompt', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const fake = new FakeLlmClient().queueResponse('not json at all');

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    await agent.recommendFromChat({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      userText: '按刚才说的来两首',
      actions: [
        {
          type: 'add_to_queue',
          pick: { query: '落日飞车 city pop 女声' }
        }
      ]
    } as any);

    expect(JSON.stringify(fake.completeCalls[0].messages)).toContain('按刚才说的来两首');
    expect(JSON.stringify(fake.completeCalls[0].messages)).toContain('落日飞车 city pop 女声');
  });

  it('returns empty_pool instead of throwing when malformed LLM output leaves the pool empty', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const fake = new FakeLlmClient().queueResponse('not json at all');

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({ userId: 'user-1', ncmClient: ncmClient as any });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
  });
});

describe('createMusicAgentTools', () => {
  it('returns relevant knowledge without changing the candidate pool', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好 city pop 女声',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 0,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.get_music_knowledge?.({ text: '午后 city pop 女声 不吵' });

    expect(observation?.summary).toContain('city pop');
    expect(observation?.summary).toContain('女声');
    expect(observation?.candidateCount).toBe(0);
    expect(candidatePool.count()).toBe(0);
  });

  it('clamps per-query NCM search limits and still upserts candidates', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 201, name: 'City Light', artists: ['Singer'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好 city pop 女声',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 1,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_ncm_search?.({ queries: ['city pop'], limit: 9999 });

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(ncmClient.searchSongs.mock.calls[0][0]).toBe('city pop');
    expect(ncmClient.searchSongs.mock.calls[0][1]).toBeLessThanOrEqual(20);
    expect(observation?.candidateCount).toBe(1);
    expect(candidatePool.get('201')).toMatchObject({
      id: '201',
      name: 'City Light',
      artist: 'Singer',
      sources: ['search']
    });
  });

  it('caps auto-fill liked recall so liked songs cannot fill the whole candidate pool', async () => {
    const likedIds = Array.from({ length: 30 }, (_, index) => `liked-${index + 1}`);
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => likedIds),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => ({
        id,
        name: `Liked ${id}`,
        artists: [`Artist ${id}`]
      }))),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好华语抒情与欧美流行女声',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 1,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_liked?.({ limit: 30 });

    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(likedIds.slice(0, 10));
    expect(observation?.candidateCount).toBe(10);
    expect(candidatePool.count()).toBe(10);
  });

  it('front-loads repeated artist penalties into query recall diversity', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'swift-1', name: 'Love Story', artists: ['Taylor Swift'] },
        { id: 'swift-2', name: 'This Love', artists: ['Taylor Swift'] },
        { id: 'janice-1', name: 'My Cookie Can', artists: ['卫兰'] },
        { id: 'fresh-1', name: 'Fresh City', artists: ['Fresh Artist'] },
        { id: 'fresh-2', name: 'Fresh Night', artists: ['Fresh Artist'] },
        { id: 'fresh-3', name: 'Fresh Noon', artists: ['Fresh Artist'] },
        { id: 'other-1', name: 'Other Light', artists: ['Other Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好华语抒情与欧美流行女声',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '1. Love Story - Taylor Swift; 2. 晨间新闻 - 蔡健雅',
        recentArtistPenalties: [
          { artist: 'taylor swift', penalty: 0.36 },
          { artist: '卫兰', penalty: 0.28 }
        ],
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 1,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const plan = await tools.expand_queries?.({ queries: ['午后流行女声'] });
    const recall = await tools.recall_from_ncm_search?.({ queries: ['Taylor Swift', '午后流行女声'], limit: 10 });
    const rank = await tools.rank_candidates?.({ limit: 5 });

    expect(plan?.summary).toContain('avoidArtists=taylor swift、卫兰');
    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(ncmClient.searchSongs.mock.calls[0][0]).toBe('午后流行女声');
    expect(recall?.problems).toContain('skipped 1 search queries for recently repeated artists');
    expect(recall?.problems).toContain('skipped 3 tracks from recently repeated artists');
    expect(recall?.problems).toContain('skipped 1 tracks after per-artist recall cap');
    expect(candidatePool.list().map((item) => item.id)).toEqual(['fresh-1', 'fresh-2', 'other-1']);
    expect(rank?.summary).toContain('adjusted=');
  });

  it('scores source candidates differently for explore and comfort discovery modes', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['liked-1']),
      getSongDetails: vi.fn(async () => [
        { id: 'liked-1', name: 'Known Song', artists: ['Known Artist'] }
      ]),
      searchSongs: vi.fn(async () => [
        { id: 'search-1', name: 'Fresh Search', artists: ['Search Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');

    async function rankedIds(discoveryMode: 'explore' | 'comfort') {
      const candidatePool = new CandidatePool();
      const tools = createMusicAgentTools({
        userId: 'user-1',
        ncmClient: ncmClient as any,
        context: {
          request: 'auto-fill',
          currentUserText: '',
          discoveryMode,
          currentMoment: { localTime: '周五 15:00', daypart: '下午', weather: null },
          activeDirective: '',
          currentPlanSegment: null,
          tasteSummary: '偏好熟悉女声，但探索模式要扩展',
          recentPreferenceSummary: '',
          recentPlaySignals: '',
          queueStateSummary: '',
          bannedSummary: ''
        },
        candidatePool,
        budget: {
          maxMs: 10_000,
          maxSteps: 4,
          maxLlmCalls: 2,
          maxToolCalls: 3,
          maxNcmSearches: 1,
          maxPlaylistFetches: 0,
          maxTrendFetchMs: 0,
          maxCandidates: 20
        }
      });
      await tools.recall_from_liked?.({ limit: 1 });
      await tools.recall_from_ncm_search?.({ query: 'fresh', limit: 1 });
      return candidatePool.topBy((candidate) => candidate.scores.intentMatch * 0.3
        + candidate.scores.tasteMatch * 0.2
        + candidate.scores.timeFit * 0.15
        + candidate.scores.planFit * 0.1
        + candidate.scores.sourceConfidence * 0.1
        + candidate.scores.novelty * 0.15
        - candidate.scores.recentPenalty
        - candidate.scores.skipPenalty, 2).map((candidate) => candidate.id);
    }

    expect(await rankedIds('explore')).toEqual(['search-1', 'liked-1']);
    expect(await rankedIds('comfort')).toEqual(['liked-1', 'search-1']);
  });

  it('reads cached trend context when chat trend fetch budget is zero', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
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
    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const { writeTrendCache } = await import('../../src/server/music-agent/trends.js');
    await writeTrendCache({
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
    });

    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-1',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 0,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.get_trend_context?.({});

    expect(observation?.summary).toContain('Cached Artist');
    expect(observation?.summary).toContain('Cached Style');
    expect(ncmClient.getSearchHotDetail).not.toHaveBeenCalled();
    expect(ncmClient.getTopSongHints).not.toHaveBeenCalled();
    expect(ncmClient.getArtistToplist).not.toHaveBeenCalled();
  });
});
