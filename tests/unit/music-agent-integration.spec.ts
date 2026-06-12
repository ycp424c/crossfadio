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
  it('keeps the base LLM budget for small auto-fill batches and raises it for large batches', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/server/music-agent/index.ts'), 'utf8');
    const pickNextBudget = source.slice(source.indexOf('function pickNextBudget'), source.indexOf('function chatRecommendBudget'));

    expect(pickNextBudget).toContain('const largeBatch = targetPickCount >= 4');
    expect(pickNextBudget).toContain('maxLlmCalls: largeBatch ? 12 : 10');
    expect(pickNextBudget).toContain('maxCandidates: largeBatch ? 160 : 120');
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

  it('tracks fallback rate and fallback reasons for MusicAgent run logs', async () => {
    const { createMusicAgentFallbackStatsTracker } = await import('../../src/server/music-agent/index.js');
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
    const tracker = createMusicAgentFallbackStatsTracker();

    expect(tracker.record({ ...baseEvent, reason: 'ranked_tool_completed' })).toMatchObject({
      totalRuns: 1,
      convergenceRuns: 1,
      fallbackRuns: 0,
      fallbackRate: 0,
      fallbackReasons: {}
    });
    expect(tracker.record({ ...baseEvent, reason: 'llm_response_timeout' })).toMatchObject({
      totalRuns: 2,
      convergenceRuns: 1,
      fallbackRuns: 1,
      fallbackRate: 0.5,
      fallbackReasons: {
        llm_response_timeout: 1
      }
    });
    expect(tracker.record({ ...baseEvent, reason: 'tool_budget_exhausted' })).toMatchObject({
      totalRuns: 3,
      convergenceRuns: 1,
      fallbackRuns: 2,
      fallbackRate: 0.667,
      fallbackReasons: {
        llm_response_timeout: 1,
        tool_budget_exhausted: 1
      }
    });
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

  it('excludes active temporary queue bans before ranking MusicAgent candidates', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['blocked-id', 'fresh-1', 'fresh-2']),
      getSongDetails: vi.fn(async () => [
        { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'], durationMs: 200_000 },
        { id: 'fresh-1', name: 'Fresh One', artists: ['Fresh Artist'], durationMs: 200_000 },
        { id: 'fresh-2', name: 'Fresh Two', artists: ['Another Artist'], durationMs: 200_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const { recordTemporaryQueueBans } = await import('../../src/server/store/temporary-bans.js');
    recordTemporaryQueueBans('user-temp-ban-agent', [
      { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'] }
    ], new Date('2026-06-04T07:30:00+08:00'));
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 10 } }))
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({
      userId: 'user-temp-ban-agent',
      ncmClient: ncmClient as any,
      now: new Date('2026-06-04T08:00:00+08:00')
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['fresh-1', 'fresh-2']);
    expect(JSON.stringify(result.trace)).not.toContain('blocked-id');
  });

  it('does not apply temporary queue bans to explicit chat recommendations', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['blocked-id', 'fresh-id']),
      getSongDetails: vi.fn(async () => [
        { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'], durationMs: 200_000 },
        { id: 'fresh-id', name: 'Fresh Song', artists: ['Fresh Artist'], durationMs: 200_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const { recordTemporaryQueueBans } = await import('../../src/server/store/temporary-bans.js');
    recordTemporaryQueueBans('user-temp-ban-chat', [
      { id: 'blocked-id', name: 'Blocked Song', artists: ['Blocked Artist'] }
    ], new Date('2026-06-04T07:30:00+08:00'));
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 10 } }))
      .queueResponse(JSON.stringify({
        type: 'final',
        say: '按你的请求放这首。',
        picks: [{ id: 'blocked-id', reason: '用户明确点名想听', source: 'liked' }],
        rejected: []
      }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.recommendFromChat({
      userId: 'user-temp-ban-chat',
      ncmClient: ncmClient as any,
      userText: '就放 Blocked Song',
      now: new Date('2026-06-04T08:00:00+08:00')
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['blocked-id']);
  });

  it('prepares external quality signals before the extra final-pick prompt', async () => {
    const pollutedTitle = "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix";
    const searchTracks = [
      { id: 'polluted-extra-final', name: pollutedTitle, artists: ['Compilation Artist'] },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `clean-extra-${index + 1}`,
        name: `Clean Extra ${index + 1}`,
        artists: [`Clean Artist ${index + 1}`]
      }))
    ];
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['liked-quality-seed']),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => {
        if (id === 'liked-quality-seed') {
          return { id, name: 'Liked Seed', artists: ['Liked Artist'], durationMs: 200_000 };
        }
        if (id === 'polluted-extra-final') {
          return {
            id,
            name: pollutedTitle,
            artists: ['Compilation Artist'],
            durationMs: 180_000,
            qualitySignals: { popularity: 5, titlePollution: 'strong' }
          };
        }
        return {
          id,
          name: `Clean Extra ${id}`,
          artists: [`Clean Artist ${id}`],
          durationMs: 180_000,
          qualitySignals: { popularity: 75, titlePollution: 'none' }
        };
      })),
      searchSongs: vi.fn(async () => searchTracks),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 5 } }))
      .queueResponse(JSON.stringify({
        type: 'final',
        say: '从补充候选里选一首干净的。',
        picks: [{ id: 'clean-extra-1', reason: '干净的外部候选', source: 'search' }],
        rejected: []
      }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({ userId: 'user-extra-final-quality', ncmClient: ncmClient as any });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['clean-extra-1']);
    expect(ncmClient.getSongDetails).toHaveBeenCalledWith([
      'polluted-extra-final',
      ...searchTracks.slice(1).map((track) => track.id)
    ]);
    expect(JSON.stringify(fake.completeCalls[1].messages)).not.toContain('polluted-extra-final');
  });

  it('rejects hard-filtered candidates from extra final-pick output', async () => {
    const pollutedTitle = "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix";
    const searchTracks = [
      { id: 'polluted-extra-final', name: pollutedTitle, artists: ['Compilation Artist'] },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `clean-reject-${index + 1}`,
        name: `Clean Reject ${index + 1}`,
        artists: [`Clean Reject Artist ${index + 1}`]
      }))
    ];
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['liked-reject-seed']),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => {
        if (id === 'liked-reject-seed') {
          return { id, name: 'Liked Seed', artists: ['Liked Artist'], durationMs: 200_000 };
        }
        return {
          id,
          name: id === 'polluted-extra-final' ? pollutedTitle : `Clean Reject ${id}`,
          artists: [id === 'polluted-extra-final' ? 'Compilation Artist' : `Clean Reject Artist ${id}`],
          durationMs: 180_000,
          qualitySignals: id === 'polluted-extra-final'
            ? { popularity: 5, titlePollution: 'strong' }
            : { popularity: 75, titlePollution: 'none' }
        };
      })),
      searchSongs: vi.fn(async () => searchTracks),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 5 } }))
      .queueResponse(JSON.stringify({
        type: 'final',
        say: '错误地选中了低质候选。',
        picks: [{ id: 'polluted-extra-final', reason: '看起来贴合', source: 'search' }],
        rejected: []
      }));

    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({ userId: 'user-extra-final-reject', ncmClient: ncmClient as any });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).not.toContain('polluted-extra-final');
    expect(result.picks.every((pick) => pick.id.startsWith('clean-reject-'))).toBe(true);
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

  it('preserves exact search queries, records a run query funnel, and persists selected query stats', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => query.includes('午后')
        ? [
            { id: 'sky-1', name: 'Sky One', artists: ['Sky Singer'] },
            { id: 'sky-2', name: 'Sky Two', artists: ['Sky Singer'] }
          ]
        : [
            { id: 'ocean-1', name: 'Ocean One', artists: ['Ocean Singer'] }
          ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const { getUserQueryStats } = await import('../../src/server/store/music-query-stats.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-query-funnel',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好轻松女声',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    await tools.recall_from_ncm_search?.({ queries: ['午后 女声', '海洋 女声'], limit: 5 });
    tools.recordFinalPicks?.([{ id: 'ocean-1', reason: '更贴合', source: 'search' }]);

    expect(ncmClient.searchSongs.mock.calls.map((call) => call[0])).toEqual(['午后 女声', '海洋 女声']);
    expect(tools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: '午后 女声',
        resultCount: 2,
        addedCount: 2,
        selectedCount: 0
      }),
      expect.objectContaining({
        query: '海洋 女声',
        resultCount: 1,
        addedCount: 1,
        selectedCount: 1
      })
    ]);
    expect(getUserQueryStats('user-query-funnel').map((item) => item.normalized_query)).toContain('海洋 女声');
  });

  it('enriches external search candidates with quality signals before ranking', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => {
        if (id === 'polluted-low-pop') {
          return {
            id,
            name: "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix",
            artists: ['Compilation Artist'],
            qualitySignals: { popularity: 8, titlePollution: 'strong' }
          };
        }
        return {
          id,
          name: 'City Light',
          artists: ['Fresh Artist'],
          qualitySignals: { popularity: 72, titlePollution: 'none' }
        };
      })),
      searchSongs: vi.fn(async () => [
        {
          id: 'polluted-low-pop',
          name: "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix",
          artists: ['Compilation Artist']
        },
        { id: 'fresh-search', name: 'City Light', artists: ['Fresh Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-quality-rank',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 23:30', daypart: '深夜', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好安静女声和 dream pop',
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

    await tools.recall_from_ncm_search?.({ queries: ['unique quality rank query'], limit: 10 });
    const rank = await tools.rank_candidates?.({ limit: 5 });

    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(['polluted-low-pop', 'fresh-search']);
    expect(rank?.summary).toContain('fresh-search:City Light-Fresh Artist');
    expect(rank?.summary).not.toContain('polluted-low-pop');
    expect(rank?.problems).toContain('filtered 1 low-quality external candidates');
    expect(candidatePool.get('fresh-search')?.qualitySignals?.popularity).toBe(72);
  });

  it('enriches every external candidate batch before ranking large pools', async () => {
    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({ maxCandidates: 120 });
    const baseScores = {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      planFit: 0.5,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.5
    };
    for (let index = 1; index <= 85; index += 1) {
      candidatePool.upsert({
        id: `external-${index}`,
        name: index === 85
          ? "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix"
          : `External ${index}`,
        artist: `External Artist ${index}`,
        sources: ['search'],
        evidence: ['large pool'],
        scores: index === 85
          ? { ...baseScores, intentMatch: 1, tasteMatch: 1, timeFit: 1, planFit: 1, novelty: 1, sourceConfidence: 1 }
          : baseScores
      });
    }
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => ({
        id,
        name: id,
        artists: [id],
        qualitySignals: id === 'external-85'
          ? { popularity: 5, titlePollution: 'strong' }
          : { popularity: 75, titlePollution: 'none' }
      }))),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const tools = createMusicAgentTools({
      userId: 'user-large-quality-rank',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 23:30', daypart: '深夜', weather: null },
        activeDirective: '',
        currentPlanSegment: null,
        tasteSummary: '偏好安静女声和 dream pop',
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
        maxCandidates: 120
      }
    });

    const rank = await tools.rank_candidates?.({ limit: 20 });

    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(2);
    expect(ncmClient.getSongDetails.mock.calls[0][0]).toHaveLength(80);
    expect(ncmClient.getSongDetails.mock.calls[1][0]).toEqual([
      'external-81',
      'external-82',
      'external-83',
      'external-84',
      'external-85'
    ]);
    expect(rank?.summary).not.toContain('external-85');
    expect(rank?.problems).toContain('filtered 1 low-quality external candidates');
  });

  it('retries quality signal preparation after a detail request failure', async () => {
    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    candidatePool.upsert({
      id: 'retry-quality',
      name: 'Retry Quality',
      artist: 'Retry Artist',
      sources: ['search'],
      evidence: ['retry'],
      scores: {
        intentMatch: 1,
        tasteMatch: 1,
        timeFit: 1,
        planFit: 1,
        novelty: 1,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 1
      }
    });
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn()
        .mockRejectedValueOnce(new Error('temporary detail outage'))
        .mockResolvedValueOnce([
          {
            id: 'retry-quality',
            name: 'Retry Quality',
            artists: ['Retry Artist'],
            qualitySignals: { popularity: 5, titlePollution: 'strong' }
          }
        ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const tools = createMusicAgentTools({
      userId: 'user-quality-retry',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 23:30', daypart: '深夜', weather: null },
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
        maxNcmSearches: 1,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const firstRank = await tools.rank_candidates?.({ limit: 5 });
    const secondRank = await tools.rank_candidates?.({ limit: 5 });

    expect(firstRank?.problems?.[0]).toContain('quality detail failed');
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(2);
    expect(secondRank?.summary).not.toContain('retry-quality');
    expect(secondRank?.problems).toContain('filtered 1 low-quality external candidates');
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

  it('reuses short-lived recall caches for liked, style, and trending recalls', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['liked-1']),
      getSongDetails: vi.fn(async () => [
        { id: 'liked-1', name: 'Liked One', artists: ['Liked Artist'] }
      ]),
      searchSongs: vi.fn(async (query: string) => [
        { id: `${query}-1`, name: `${query} One`, artists: [`${query} Artist`] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'user-cache',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '下午 city pop',
        currentPlanSegment: null,
        tasteSummary: '偏好 city pop',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 5,
        maxLlmCalls: 2,
        maxToolCalls: 5,
        maxNcmSearches: 10,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    await tools.recall_from_liked?.({ limit: 1 });
    await tools.recall_from_liked?.({ limit: 1 });
    const afterLikedCalls = ncmClient.searchSongs.mock.calls.length;
    await tools.recall_from_style_expansion?.({ queries: ['city pop'], limit: 1 });
    const afterFirstStyleCalls = ncmClient.searchSongs.mock.calls.length;
    await tools.recall_from_style_expansion?.({ queries: ['city pop'], limit: 1 });
    const afterSecondStyleCalls = ncmClient.searchSongs.mock.calls.length;
    await tools.expand_queries?.({ trendQueries: ['trend city pop'] });
    await tools.recall_from_trending?.({ limit: 1 });
    const afterFirstTrendCalls = ncmClient.searchSongs.mock.calls.length;
    await tools.recall_from_trending?.({ limit: 1 });
    const afterSecondTrendCalls = ncmClient.searchSongs.mock.calls.length;

    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(1);
    expect(afterLikedCalls).toBe(0);
    expect(afterFirstStyleCalls).toBeGreaterThan(0);
    expect(afterSecondStyleCalls).toBe(afterFirstStyleCalls);
    expect(afterFirstTrendCalls).toBeGreaterThan(afterSecondStyleCalls);
    expect(afterSecondTrendCalls).toBe(afterFirstTrendCalls);
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
