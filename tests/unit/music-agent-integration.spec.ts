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
    expect(pickNextBudget).toContain('maxNcmSearches: largeBatch ? 18 : 10');
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

  it('injects the configured shortlist enricher and assessment persister into pickNext only', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['101']),
      getSongDetails: vi.fn(async () => [
        { id: 101, name: 'Soft Song', artists: ['Singer'], durationMs: 200_000 }
      ]),
      searchSongs: vi.fn(async () => []), getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []), getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 5 } }))
      .queueResponse(JSON.stringify({
        type: 'final', say: 'first', picks: [{ id: '101', reason: 'fit', source: 'liked' }],
        rejected: [], assessments: []
      }))
      .queueResponse(JSON.stringify({
        type: 'final', say: 'fused', picks: [{ id: '101', reason: 'fit', source: 'liked' }],
        rejected: [], assessments: [{
          id: '101',
          profile: { genres: [], moods: ['calm'], energy: 'low', aggression: 'low', vocalIntensity: 'low', lyricThemes: [], language: 'unknown' },
          confidence: { genres: 0.2, moods: 0.9, energy: 0.9, aggression: 0.9, vocalIntensity: 0.9, lyricThemes: 0.2, language: 0.2 },
          evidence: [{ claim: 'mood=calm', source: 'lyric_analysis' }]
        }]
      }));
    const enrich = vi.fn(async (candidates: any[]) => ({
      shortlist: candidates,
      expectedLyricVersions: [],
      promptPackets: candidates.map((candidate) => ({
        id: candidate.id, name: candidate.name, artist: candidate.artist,
        sources: candidate.sources, kind: 'base' as const
      })),
      diagnostics: {
        shortlistCount: candidates.length, cacheHits: 0, cacheMisses: candidates.length,
        lyricAttempted: 0, lyricSuccess: 0, lyricMissing: 0, lyricFail: 0,
        lyricTimeout: 0, lyricCancelled: 0, wikiAttempted: 0, wikiSuccess: 0,
        wikiFail: 0, wikiTimeout: 0, wikiCancelled: 0, cacheWriteFailed: 0,
        sampledChars: 0, elapsedMs: 0, deadlineReached: false
      }
    }));
    const persist = vi.fn();
    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const agent = new MusicAgent({
      llmClient: fake,
      lyricsSelectionMode: 'shadow',
      finalShortlistEnricher: enrich,
      persistTrackAssessments: persist
    });

    const result = await agent.pickNext({ userId: 'lyrics-aware', ncmClient: ncmClient as any });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('fused');
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reuses one default enricher across concurrent pickNext runs for single-flight and global NCM limits', async () => {
    const ids = ['101', '102', '103', '104'];
    let activeNcm = 0;
    let maxActiveNcm = 0;
    const sharedRequest = async <T>(value: T): Promise<T> => {
      activeNcm += 1;
      maxActiveNcm = Math.max(maxActiveNcm, activeNcm);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeNcm -= 1;
      return value;
    };
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ids),
      getSongDetails: vi.fn(async (requested: string[]) => requested.map((id) => ({
        id, name: `Song ${id}`, artists: [`Artist ${id}`], durationMs: 200_000,
        popularity: 80, album: { name: `Album ${id}` }
      }))),
      searchSongs: vi.fn(async () => []), getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []), getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => []),
      getLyric: vi.fn(async (id: string) => sharedRequest({
        id, lyric: '[00:00.00]quiet line', translation: null
      })),
      getSongWikiSummary: vi.fn(async () => sharedRequest({ tags: ['calm'] }))
    };
    const assessments = ids.map((id) => ({
      id,
      profile: { genres: [], moods: ['calm'], energy: 'low', aggression: 'low', vocalIntensity: 'low', lyricThemes: [], language: 'unknown' },
      confidence: { genres: 0.2, moods: 0.9, energy: 0.9, aggression: 0.9, vocalIntensity: 0.9, lyricThemes: 0.2, language: 0.2 },
      evidence: [{ claim: 'mood=calm', source: 'lyric_analysis' }]
    }));
    const concurrentLlm: MusicAgentLlmClient = {
      async complete(messages) {
        const prompt = messages.map((message) => message.content).join('\n');
        if (prompt.includes("Crossfadio's final music selector")) {
          return {
            content: JSON.stringify({
              type: 'final', say: 'fused', assessments,
              picks: [{ id: '101', reason: 'fit', source: 'liked' }], rejected: []
            }),
            model: 'test-model'
          };
        }
        if (prompt.includes('candidate_pool:\n[]')) {
          return {
            content: JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 4 } }),
            model: 'test-model'
          };
        }
        return {
          content: JSON.stringify({
            type: 'final', say: 'untrusted', assessments: [],
            picks: [{ id: '101', reason: 'fit', source: 'liked' }], rejected: []
          }),
          model: 'test-model'
        };
      }
    };
    const { MusicAgent } = await import('../../src/server/music-agent/index.js');
    const firstAgent = new MusicAgent({ llmClient: concurrentLlm, lyricsSelectionMode: 'shadow' });
    const secondAgent = new MusicAgent({ llmClient: concurrentLlm, lyricsSelectionMode: 'shadow' });
    const sharedContext = {
      request: 'auto-fill' as const, currentUserText: '', activeDirective: '',
      currentMoment: { localTime: 'now', daypart: 'evening', weather: null },
      tasteSummary: '', recentPreferenceSummary: '', recentPlaySignals: '',
      queueStateSummary: '', bannedSummary: ''
    };

    const results = await Promise.all([
      firstAgent.pickNext({ userId: 'concurrent-a', ncmClient: ncmClient as any, context: sharedContext }),
      secondAgent.pickNext({ userId: 'concurrent-b', ncmClient: ncmClient as any, context: sharedContext })
    ]);

    expect(results.every((result) => result.status === 'ok')).toBe(true);
    for (const id of ids) {
      expect(ncmClient.getLyric.mock.calls.filter((call) => call[0] === id)).toHaveLength(1);
      expect(ncmClient.getSongWikiSummary.mock.calls.filter((call) => call[0] === id)).toHaveLength(1);
    }
    expect(maxActiveNcm).toBeLessThanOrEqual(6);
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
      .queueResponse(JSON.stringify({
        type: 'tool_call',
        tool: 'recall_from_ncm_search',
        input: { queries: ['Clean Extra 1 Clean Artist 1'], limit: 8 }
      }))
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
      .queueResponse(JSON.stringify({
        type: 'tool_call',
        tool: 'recall_from_ncm_search',
        input: { queries: ['Clean Reject 1 Clean Reject Artist 1'], limit: 8 }
      }))
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

    const observation = await tools.recall_from_ncm_search?.({ queries: ['City Light Singer'], limit: 9999 });

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(ncmClient.searchSongs.mock.calls[0][0]).toBe('City Light Singer');
    expect(ncmClient.searchSongs.mock.calls[0][1]).toBeLessThanOrEqual(20);
    expect(observation?.candidateCount).toBe(1);
    expect(candidatePool.get('201')).toMatchObject({
      id: '201',
      name: 'City Light',
      artist: 'Singer',
      sources: ['search']
    });
  });

  it('reports candidate admission diagnostics for NCM search recall', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'invalid', name: '', artists: [] },
        { id: 'banned-id', name: 'Banned Song', artists: ['Banned Singer'] },
        { id: 'banned-dedupe', name: 'Blocked', artists: ['Other'] },
        { id: 'fresh-1', name: 'Fresh Song', artists: ['Fresh Artist'] },
        { id: 'fresh-duplicate', name: 'Fresh Song', artists: ['Fresh Artist / Guest'] },
        { id: 'cap-1', name: 'Cap One', artists: ['Cap Artist'] },
        { id: 'cap-2', name: 'Cap Two', artists: ['Cap Artist'] },
        { id: 'cap-3', name: 'Cap Three', artists: ['Cap Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { buildCandidateDedupeKey, CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({
      bannedIds: ['banned-id'],
      bannedTrackKeys: new Set([buildCandidateDedupeKey({ name: 'Blocked', artist: 'Other' })])
    });
    const tools = createMusicAgentTools({
      userId: 'admission-diagnostics',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_ncm_search?.({ queries: ['Diagnostic Song Artist'], limit: 20 });

    expect(observation?.candidateCount).toBe(3);
    expect(observation?.problems).toContain(
      'candidate admission: inserted=3; mergedByDedupe=1; invalid=1; rejectedByPool=2 (banned_id=1, banned_dedupe=1); skippedArtistCap=1'
    );
  });

  it('applies the per-artist recall cap to collaborators during query recall', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'shared-guest-1', name: 'Shared Guest One', artists: ['Primary One / Shared Guest'] },
        { id: 'shared-guest-2', name: 'Shared Guest Two', artists: ['Primary Two / Shared Guest'] },
        { id: 'shared-guest-3', name: 'Shared Guest Three', artists: ['Primary Three / Shared Guest'] },
        { id: 'fresh', name: 'Fresh Song', artists: ['Fresh Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'collaborator-recall-cap',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_ncm_search?.({ queries: ['Shared Guest Song Artist'], limit: 10 });

    expect(candidatePool.list().map((candidate) => candidate.id)).toEqual(['shared-guest-1', 'shared-guest-2', 'fresh']);
    expect(observation?.problems).toContain('skipped 1 tracks after per-artist recall cap');
  });

  it('explains why NCM recall has no executable search queries', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const tools = createMusicAgentTools({
      userId: 'no-query-diagnostics',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '',
        currentMoment: { localTime: '周一 18:08', daypart: '傍晚', weather: null },
        activeDirective: '',
        tasteSummary: '',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: '',
        recentArtistPenalties: [{ artist: '陈奕迅', penalty: 0.24 }]
      },
      candidatePool: new CandidatePool(),
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 3,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const emptyPlan = await tools.recall_from_ncm_search?.({ queries: [] });
    const avoided = await tools.recall_from_ncm_search?.({ queries: ['盲婚哑嫁 The Code — 陈奕迅'] });
    const semanticOnly = await tools.recall_from_ncm_search?.({ queries: ['粤语流行 女声 工作间隙放松'] });

    expect(emptyPlan?.summary).toContain('query plan empty');
    expect(avoided?.summary).toContain('all queries skipped for recently repeated artists');
    expect(semanticOnly?.summary).toContain('all queries skipped as semantic-only');
    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
  });

  it('counts query funnel addedCount as unique admitted candidates instead of merges', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'same-id', name: 'Same Song', artists: ['Same Artist'] },
        { id: 'same-id', name: 'Same Song', artists: ['Same Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'query-funnel-unique-added',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_ncm_search?.({ queries: ['Same Song Same Artist'], limit: 8 });

    expect(observation?.candidateCount).toBe(1);
    expect(tools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: 'Same Song Same Artist',
        resultCount: 2,
        addedCount: 1
      })
    ]);
  });

  it('falls back to artist expansion when exact-track search results are all banned', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'blocked-cover', name: '日出时让街灯安睡', artists: ['李幸倪'] },
        { id: 'blocked-live', name: '日出时让街灯安睡 (Live)', artists: ['李幸倪 / 张学友'] }
      ]),
      searchArtists: vi.fn(async () => [{ id: 501, name: '李幸倪' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'fresh-gin-1', name: '双双', artists: ['李幸倪'] },
        { id: 'fresh-gin-2', name: '月球下的人', artists: ['李幸倪'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool, buildCandidateDedupeKey } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({
      bannedTrackKeys: new Set([
        buildCandidateDedupeKey({ name: '日出时让街灯安睡', artist: '李幸倪' })
      ])
    });
    const tools = createMusicAgentTools({
      userId: 'artist-fallback-after-banned-exact',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        discoveryMode: 'explore',
        currentMoment: { localTime: '周五 16:25', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 40
      }
    });

    const observation = await tools.recall_from_ncm_search?.({ queries: ['日出时让街灯安睡 — 李幸倪'], limit: 8 });

    expect(ncmClient.searchArtists).toHaveBeenCalledWith('李幸倪', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('501');
    expect(candidatePool.list().map((candidate) => candidate.id)).toEqual(['fresh-gin-1', 'fresh-gin-2']);
    expect(observation?.summary).toContain('artist fallback added 2 candidates');
    expect(observation?.problems).toContain('candidate admission: rejectedByPool=2 (banned_dedupe=2)');
  });

  it('counts multi-artist fallback names as one fallback attempt', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => query.includes('Blocked One')
        ? [{ id: 'blocked-one', name: 'Blocked One', artists: ['Alpha / Guest'] }]
        : [{ id: 'blocked-two', name: 'Blocked Two', artists: ['Beta'] }]),
      searchArtists: vi.fn(async (query: string) => query === 'Alpha / Guest'
        ? [{ id: 'alpha', name: 'Alpha / Guest' }]
        : [{ id: 'beta', name: 'Beta' }]),
      getArtistTopSongs: vi.fn(async (artistId: string) => artistId === 'alpha'
        ? [{ id: 'alpha-fresh', name: 'Alpha Fresh', artists: ['Alpha / Guest'] }]
        : [{ id: 'beta-fresh', name: 'Beta Fresh', artists: ['Beta'] }]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({
      bannedIds: ['blocked-one', 'blocked-two']
    });
    const tools = createMusicAgentTools({
      userId: 'artist-fallback-budget-collaborators',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        discoveryMode: 'explore',
        currentMoment: { localTime: '周五 16:25', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 6,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 40
      }
    });

    const observation = await tools.recall_from_ncm_search?.({
      queries: ['Blocked One — Alpha / Guest', 'Blocked Two — Beta'],
      limit: 8
    });

    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Alpha / Guest', 3);
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Beta', 3);
    expect(candidatePool.list().map((candidate) => candidate.id)).toEqual(['alpha-fresh', 'beta-fresh']);
    expect(observation?.summary).toContain('artist fallback added 2 candidates from Alpha / Guest、Beta');
  });

  it('accepts lowercase exact track and artist queries for NCM song search', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 251, name: 'Get Lucky', artists: ['Daft Punk'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'lowercase-exact-query',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_ncm_search?.({ queries: ['get lucky daft punk'], limit: 5 });

    expect(ncmClient.searchSongs).toHaveBeenCalledWith('get lucky daft punk', 5);
    expect(observation?.candidateCount).toBe(1);
    expect(candidatePool.get('251')).toMatchObject({
      id: '251',
      name: 'Get Lucky',
      artist: 'Daft Punk',
      sources: ['search']
    });
  });

  it('verifies track entities through exact NCM search before adding candidates', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 301, name: 'Candy', artists: ['具島直子'] },
        { id: 302, name: 'Candy', artists: ['Wrong Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-track-verify',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop 女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [{ type: 'track', title: 'Candy', artist: '具島直子' }]
    });

    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Candy 具島直子', 5);
    expect(observation?.summary).toContain('entity recall attempted 1 entities, produced 1 productive entities, and added 1 candidates');
    expect(candidatePool.get('301')).toMatchObject({
      id: '301',
      name: 'Candy',
      artist: '具島直子',
      sources: ['search']
    });
    expect(candidatePool.get('302')).toBeUndefined();
  });

  it('accepts query-plan shaped exact track queries in recall_from_entities', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 302, name: 'Candy', artists: ['Wrong Artist'] },
        { id: 301, name: 'Candy', artists: ['具島直子'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-track-query-plan-compat',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop 女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      exactTrackQueries: ['Candy 具島直子']
    });

    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Candy 具島直子', 5);
    expect(observation?.summary).toContain('entity recall attempted 1 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.problems ?? []).not.toContain('no music entities provided');
    expect(candidatePool.get('302')).toBeUndefined();
    expect(candidatePool.get('301')).toMatchObject({
      id: '301',
      name: 'Candy',
      artist: '具島直子',
      sources: ['search']
    });
  });

  it('recalls playlist query inputs through recall_from_playlists without requiring ids', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchPlaylists: vi.fn(async () => [
        { id: 'playlist-1', name: 'City Pop Selection', trackCount: 20, coverImgUrl: null }
      ]),
      getPlaylistDetail: vi.fn(async () => ({
        id: 'playlist-1',
        name: 'City Pop Selection',
        tracks: [
          { id: 'playlist-track-1', name: 'Friday Night', artists: ['J-City Artist'] },
          { id: 'playlist-track-2', name: 'Night Flight', artists: ['J-City Artist'] }
        ]
      }))
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'playlist-query-tool',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 1,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_playlists?.({
      playlistQueries: ['city pop'],
      limit: 3
    });

    expect(ncmClient.searchPlaylists).toHaveBeenCalledWith('city pop', 3);
    expect(ncmClient.getPlaylistDetail).toHaveBeenCalledWith('playlist-1');
    expect(observation?.summary).toContain('playlist recall searched 1 queries and added 2 candidates');
    expect(candidatePool.list().map((candidate) => candidate.id)).toEqual(['playlist-track-1', 'playlist-track-2']);
  });

  it('filters repeated artists before entity count and backfills rejected artist entities', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async (query: string) => query === 'Good Artist'
        ? [{ id: 'good-artist', name: 'Good Artist' }]
        : []),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'good-track', name: 'Good Track', artists: ['Good Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-rejected-backfill',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: '',
        recentArtistPenalties: [{ artist: 'Repeated Artist', penalty: 0.24 }]
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 20,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      artistAnchors: [
        'Repeated Artist',
        'Missing Artist 1',
        'Missing Artist 2',
        'Missing Artist 3',
        'Missing Artist 4',
        'Missing Artist 5',
        'Missing Artist 6',
        'Missing Artist 7',
        'Missing Artist 8',
        'Good Artist'
      ],
      limit: 3
    });

    expect(ncmClient.searchArtists).not.toHaveBeenCalledWith('Repeated Artist', expect.any(Number));
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Good Artist', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('good-artist');
    expect(observation?.summary).toContain('entity recall attempted 9 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.data).toMatchObject({
      attemptedEntityCount: 9,
      productiveEntityCount: 1,
      scannedEntityCount: 9,
      prefilteredEntityCount: 1
    });
    expect(observation?.problems).toContain('skipped 1 entity queries for recently repeated artists');
    expect(candidatePool.get('good-track')).toBeDefined();
  });

  it('skips candidate-banned track entities before the count and backfills post-search bans', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => {
        throw new Error('known banned provider ids should be skipped before detail fetch');
      }),
      searchSongs: vi.fn(async (query: string) => {
        const playedMatch = query.match(/^Played Song (\d+)$/);
        if (playedMatch) {
          const index = playedMatch[1];
          return [{ id: `played-${index}`, name: `Played Song ${index}`, artists: ['Played Artist'] }];
        }
        if (query === 'Fresh Song Fresh Artist') {
          return [{ id: 'fresh-track', name: 'Fresh Song Fresh Artist', artists: ['Fresh Artist'] }];
        }
        return [];
      }),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({
      bannedIds: ['known-blocked', ...Array.from({ length: 8 }, (_, index) => `played-${index + 1}`)]
    });
    const tools = createMusicAgentTools({
      userId: 'entity-banned-backfill',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 20,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [
        { type: 'track', providerId: 'known-blocked', title: 'Known Blocked', artist: 'Known Artist' }
      ],
      exactTrackQueries: [
        'Played Song 1',
        'Played Song 2',
        'Played Song 3',
        'Played Song 4',
        'Played Song 5',
        'Played Song 6',
        'Played Song 7',
        'Played Song 8',
        'Fresh Song Fresh Artist'
      ],
      limit: 3
    });

    expect(ncmClient.getSongDetails).not.toHaveBeenCalled();
    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Fresh Song Fresh Artist', 3);
    expect(observation?.summary).toContain('entity recall attempted 9 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.data).toMatchObject({
      attemptedEntityCount: 9,
      productiveEntityCount: 1,
      scannedEntityCount: 9,
      prefilteredEntityCount: 1
    });
    expect(observation?.problems).toContain(
      'skipped 1 entity queries already blocked by candidate bans (banned_id=1)'
    );
    expect(observation?.problems).toContain('candidate admission: rejectedByPool=1 (banned_id=1)');
    expect(candidatePool.get('fresh-track')).toBeDefined();
  });

  it('does not let playlist fetch budget failures consume the productive entity limit', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchPlaylists: vi.fn(async (query: string) => [
        { id: `playlist-${query}`, name: query, trackCount: 20, coverImgUrl: null }
      ]),
      getPlaylistDetail: vi.fn(async () => {
        throw new Error('playlist fetch budget should stop detail calls');
      }),
      searchArtists: vi.fn(async (query: string) => query === 'Good Artist'
        ? [{ id: 'good-artist', name: 'Good Artist' }]
        : []),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'good-track', name: 'Good Track', artists: ['Good Artist'] }
      ])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-playlist-budget-backfill',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 20,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [
        ...Array.from({ length: 8 }, (_, index) => ({ type: 'playlist' as const, name: `Playlist ${index + 1}` })),
        { type: 'artist', name: 'Good Artist' }
      ],
      limit: 3
    });

    expect(ncmClient.searchPlaylists).toHaveBeenCalledTimes(8);
    expect(ncmClient.getPlaylistDetail).not.toHaveBeenCalled();
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Good Artist', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('good-artist');
    expect(observation?.summary).toContain('entity recall attempted 9 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.data).toMatchObject({
      attemptedEntityCount: 9,
      productiveEntityCount: 1,
      scannedEntityCount: 9
    });
    expect(observation?.problems).toContain('playlist fetch budget exhausted');
    expect(candidatePool.get('good-track')).toBeDefined();
  });

  it('does not let admission skips consume the productive entity limit', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => {
        const cappedMatch = query.match(/^Capped Song (\d+) Capped Artist$/);
        if (cappedMatch) {
          const index = cappedMatch[1];
          return [{ id: `capped-${index}`, name: `Capped Song ${index}`, artists: ['Capped Artist'] }];
        }
        if (query === 'Fresh Song Fresh Artist') {
          return [{ id: 'fresh-track', name: 'Fresh Song', artists: ['Fresh Artist'] }];
        }
        return [];
      }),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const baseScores = {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      contextFit: 0.5,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.5
    };
    candidatePool.upsert({
      id: 'existing-capped-1',
      name: 'North Anchor',
      artist: 'Capped Artist',
      sources: ['search'],
      evidence: ['existing'],
      scores: baseScores
    });
    candidatePool.upsert({
      id: 'existing-capped-2',
      name: 'South Signal',
      artist: 'Capped Artist',
      sources: ['search'],
      evidence: ['existing'],
      scores: baseScores
    });
    const tools = createMusicAgentTools({
      userId: 'entity-admission-skip-backfill',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 20,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [
        ...Array.from({ length: 8 }, (_, index) => ({
          type: 'track' as const,
          title: `Capped Song ${index + 1}`,
          artist: 'Capped Artist'
        })),
        { type: 'track', title: 'Fresh Song', artist: 'Fresh Artist' }
      ],
      limit: 3
    });

    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Fresh Song Fresh Artist', 3);
    expect(observation?.summary).toContain('entity recall attempted 9 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.data).toMatchObject({
      attemptedEntityCount: 9,
      productiveEntityCount: 1,
      scannedEntityCount: 9
    });
    expect(observation?.problems).toContain('skipped 1 tracks after per-artist recall cap');
    expect(candidatePool.get('fresh-track')).toBeDefined();
  });

  it('does not report missing entities when all entity inputs are prefiltered', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-prefiltered-only',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: '',
        recentArtistPenalties: [{ artist: 'Repeated Artist', penalty: 0.24 }]
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 2,
        maxNcmSearches: 20,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      artistAnchors: ['Repeated Artist'],
      limit: 3
    });

    expect(ncmClient.searchArtists).not.toHaveBeenCalled();
    expect(observation?.summary).toContain('entity recall skipped: all entities were filtered before recall');
    expect(observation?.problems ?? []).not.toContain('no music entities provided');
    expect(observation?.problems).toContain('skipped 1 entity queries for recently repeated artists');
    expect(observation?.data).toMatchObject({ prefilteredEntityCount: 1 });
  });

  it('requires the expected primary artist when verifying multi-artist track entities', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'wrong-feature-only', name: 'Payphone', artists: ['Wiz Khalifa'] },
        { id: 'correct-collab', name: 'Payphone', artists: ['Maroon 5', 'Wiz Khalifa'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-track-primary-collaborator-verify',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [{ type: 'track', title: 'Payphone', artist: 'Maroon 5 / Wiz Khalifa' }]
    });

    expect(observation?.summary).toContain('entity recall attempted 1 entities, produced 1 productive entities, and added 1 candidates');
    expect(candidatePool.get('correct-collab')).toMatchObject({
      id: 'correct-collab',
      name: 'Payphone',
      artist: 'Maroon 5 / Wiz Khalifa'
    });
    expect(candidatePool.get('wrong-feature-only')).toBeUndefined();
  });

  it('returns sourced web discovery hints and keeps them out of the candidate pool', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [
        {
          kind: 'track',
          name: 'Only Love',
          artist: 'Ben Howard',
          styles: ['folk'],
          sourceUrl: 'https://example.com/ben-howard',
          sourceTitle: 'Ben Howard songs',
          snippet: 'The source names Only Love by Ben Howard.',
          confidence: 0.88,
          freshness: 'durable',
          observedAt: '2026-06-15T08:00:00.000Z'
        },
        {
          kind: 'track',
          name: 'Loose Untitled Hint',
          sourceUrl: 'https://example.com/loose',
          snippet: 'This hint lacks an artist and must not become a playable candidate.',
          confidence: 0.9,
          freshness: 'fresh',
          observedAt: '2026-06-15T08:00:00.000Z'
        },
        {
          kind: 'track',
          name: 'Wrong Song',
          artist: 'Ben Howard',
          sourceUrl: 'https://example.com/wrong',
          snippet: 'This hint will fail exact NCM title and artist verification.',
          confidence: 0.86,
          freshness: 'fresh',
          observedAt: '2026-06-15T08:00:00.000Z'
        }
      ])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-track-verify',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '探索几首类似 Ben Howard 的民谣新歌',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const observation = await tools.web_music_discovery?.({
      intent: '探索几首类似 Ben Howard 的民谣新歌',
      focus: 'similar_tracks',
      anchors: [{ type: 'artist', name: 'Ben Howard' }],
      freshness: 'recent',
      maxHints: 3
    });

    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: '探索几首类似 Ben Howard 的民谣新歌',
        focus: 'similar_tracks',
        maxHints: 3
      }),
      expect.any(Object)
    );
    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
    expect(candidatePool.list()).toHaveLength(0);
    expect(observation?.candidateCount).toBe(0);
    expect(observation?.summary).toContain('web discovery returned 3 hints');
    expect(observation?.data?.hints).toEqual([
      expect.objectContaining({
        kind: 'track',
        name: 'Only Love',
        artist: 'Ben Howard',
        sourceUrl: 'https://example.com/ben-howard'
      }),
      expect.objectContaining({ name: 'Loose Untitled Hint' }),
      expect.objectContaining({ name: 'Wrong Song' })
    ]);
  });

  it('treats seven search candidates for a five-pick auto-fill run as sparse for web discovery', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [])
    };
    const baseScores = {
      intentMatch: 0.6,
      tasteMatch: 0.6,
      timeFit: 0.6,
      contextFit: 0.6,
      novelty: 0.6,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.6
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    for (let index = 1; index <= 7; index += 1) {
      candidatePool.upsert({
        id: `search-only-${index}`,
        name: `Search Only ${index}`,
        artist: `Search Artist ${index}`,
        sources: ['search'],
        evidence: ['网易云搜索'],
        scores: baseScores
      });
    }
    const tools = createMusicAgentTools({
      userId: 'web-discovery-seven-search-candidates',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '傍晚放松一点',
        currentMoment: { localTime: '周一 17:10', daypart: '傍晚', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const observation = await tools.web_music_discovery?.({
      intent: '傍晚放松一点',
      focus: 'scene_overview',
      maxHints: 4
    });

    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledTimes(1);
    expect(observation?.summary).toContain('web discovery returned 0 hints');
    expect(observation?.problems ?? []).not.toContain('web discovery denied: exploration gap is not strong enough');
  });

  it('verifies web discovery hints through recall_from_entities before adding candidates', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => {
        if (query === 'Only Love Ben Howard') {
          return [
            { id: 9301, name: 'Only Love', artists: ['Ben Howard'] },
            { id: 9302, name: 'Only Love', artists: ['Wrong Artist'] }
          ];
        }
        return [{ id: 9303, name: 'Wrong Song', artists: ['Wrong Artist'] }];
      }),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-hint-verify',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '探索几首类似 Ben Howard 的民谣新歌',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const observation = await tools.recall_from_entities?.({
      hints: [
        {
          kind: 'track',
          name: 'Only Love',
          artist: 'Ben Howard',
          sourceUrl: 'https://example.com/ben-howard',
          snippet: 'The source names Only Love by Ben Howard.',
          confidence: 0.88,
          freshness: 'durable',
          observedAt: '2026-06-15T08:00:00.000Z'
        },
        {
          kind: 'track',
          name: 'Loose Untitled Hint',
          sourceUrl: 'https://example.com/loose',
          snippet: 'This hint lacks an artist and must not become a playable candidate.',
          confidence: 0.9,
          freshness: 'fresh',
          observedAt: '2026-06-15T08:00:00.000Z'
        },
        {
          kind: 'track',
          name: 'Wrong Song',
          artist: 'Ben Howard',
          sourceUrl: 'https://example.com/wrong',
          snippet: 'This hint will fail exact NCM title and artist verification.',
          confidence: 0.86,
          freshness: 'fresh',
          observedAt: '2026-06-15T08:00:00.000Z'
        }
      ]
    });

    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Only Love Ben Howard', 5);
    expect(candidatePool.list()).toHaveLength(1);
    expect(candidatePool.get('9301')).toMatchObject({
      id: '9301',
      name: 'Only Love',
      artist: 'Ben Howard',
      sources: ['search']
    });
    expect(candidatePool.get('9302')).toBeUndefined();
    expect(candidatePool.get('9303')).toBeUndefined();
    expect(observation?.summary).toContain('entity recall attempted 2 entities, produced 1 productive entities, and added 1 candidates');
    expect(observation?.problems).toContain('web track hint skipped: missing artist for Loose Untitled Hint');
    expect(observation?.problems).toContain('track entity rejected: Wrong Song - Ben Howard');
  });

  it('denies web discovery in comfort mode without calling the provider', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-comfort-deny',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'comfort',
        currentUserText: '放几首熟悉的',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const observation = await tools.web_music_discovery?.({
      intent: '放几首熟悉的',
      focus: 'similar_tracks'
    });

    expect(webMusicDiscoveryProvider.discover).not.toHaveBeenCalled();
    expect(observation?.candidateCount).toBe(0);
    expect(observation?.problems).toContain('web discovery denied: discovery mode is comfort');
  });

  it('allows only one web discovery call per tool registry run', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-once',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '探索一些新的 indie folk',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const first = await tools.web_music_discovery?.({
      intent: '探索一些新的 indie folk',
      focus: 'scene_overview',
      maxHints: 2
    });
    const second = await tools.web_music_discovery?.({
      intent: '探索一些新的 indie folk',
      focus: 'scene_overview',
      maxHints: 2
    });

    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledTimes(1);
    expect(first?.summary).toContain('web discovery returned 0 hints');
    expect(second?.problems).toContain('web discovery denied: already called in this run');
  });

  it('allows web discovery again for the same intent in a new tool registry run', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const context = {
      request: 'auto-fill' as const,
      discoveryMode: 'explore' as const,
      currentUserText: '探索一些新的 indie folk',
      currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
      activeDirective: '',
      tasteSummary: '',
      recentPreferenceSummary: '',
      recentPlaySignals: '',
      queueStateSummary: '',
      bannedSummary: ''
    };
    const budget = {
      maxMs: 10_000,
      maxSteps: 3,
      maxLlmCalls: 2,
      maxToolCalls: 3,
      maxNcmSearches: 4,
      maxPlaylistFetches: 0,
      maxTrendFetchMs: 0,
      maxCandidates: 20
    };

    const firstTools = createMusicAgentTools({
      userId: 'web-discovery-cross-run',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context,
      candidatePool: new CandidatePool(),
      budget,
      targetPickCount: 5
    });
    const secondTools = createMusicAgentTools({
      userId: 'web-discovery-cross-run',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context,
      candidatePool: new CandidatePool(),
      budget,
      targetPickCount: 5
    });

    const first = await firstTools.web_music_discovery?.({
      intent: '探索一些新的 indie folk',
      focus: 'scene_overview',
      maxHints: 2
    });
    const second = await secondTools.web_music_discovery?.({
      intent: '探索一些新的 indie folk',
      focus: 'scene_overview',
      maxHints: 2
    });

    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledTimes(2);
    expect(first?.summary).toContain('web discovery returned 0 hints');
    expect(second?.summary).toContain('web discovery returned 0 hints');
  });

  it('auto-fill mix sends a tight web discovery request and recalls one track per web artist hint', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async (query: string) => query === 'Web Artist'
        ? [{ id: 'web-artist', name: 'Web Artist' }]
        : []),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'web-auto-1', name: 'Quiet Harbor', artists: ['Web Artist'] },
        { id: 'web-auto-2', name: 'Loud Harbor', artists: ['Web Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [
        {
          kind: 'artist',
          name: 'Web Artist',
          styles: ['cantopop'],
          sourceUrl: 'https://example.com/quiet-harbor',
          snippet: 'The source names Web Artist in a cantopop scene note.',
          confidence: 0.86,
          freshness: 'durable',
          observedAt: '2026-06-15T08:00:00.000Z'
        }
      ])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-auto-fill-mix',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '探索一些适合现在的粤语/港乐',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '长期画像很长：最近很多 Slipknot、metal、indie folk、近年的新歌都听过，也喜欢英文歌。',
        recentPreferenceSummary: '近期偏好 近年的新歌、独立民谣、Slipknot、高能量 metal。',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 3,
        maxNcmSearches: 6,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    const observation = await tools.recall_auto_fill_mix?.({});

    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledTimes(1);
    const providerInput = webMusicDiscoveryProvider.discover.mock.calls[0]?.[0];
    expect(providerInput).toMatchObject({
      focus: 'style_artists',
      anchors: [{ type: 'style', name: 'cantopop' }],
      freshness: 'durable',
      maxHints: 8
    });
    expect(providerInput.intent).toContain('粤语');
    expect(providerInput.intent).not.toContain('Slipknot');
    expect(providerInput.intent).not.toContain('近年的新歌');
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Web Artist', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('web-artist');
    expect(candidatePool.get('web-auto-1')).toMatchObject({
      id: 'web-auto-1',
      name: 'Quiet Harbor',
      artist: 'Web Artist',
      sources: ['search']
    });
    expect(candidatePool.get('web-auto-2')).toBeUndefined();
    expect(observation?.summary).toContain('web discovery returned 1 hints');
    expect(observation?.summary).toContain('web hint entity recall added 1 candidates');
  });

  it('auto-fill mix routes broad exploration anchors through entity recall instead of song search', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => query === 'Exact Song Artist'
        ? [{ id: 'exact-1', name: 'Exact Song', artists: ['Artist'] }]
        : []),
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Fresh Artist' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'artist-track-1', name: 'Fresh One', artists: ['Fresh Artist'] },
        { id: 'artist-track-2', name: 'Fresh Two', artists: ['Fresh Artist'] },
        { id: 'artist-track-cover', name: 'Fresh Song Cover', artists: ['Fresh Artist'] }
      ]),
      searchPlaylists: vi.fn(async () => [
        { id: 'wrong-language', name: '【日语】干净温暖的男声', trackCount: 100, coverImgUrl: null },
        { id: 'playlist-1', name: '粤语男声精选，唱尽难眠心事', trackCount: 44, coverImgUrl: null }
      ]),
      getPlaylistDetail: vi.fn(async () => ({
        id: 'playlist-1',
        name: '粤语男声精选，唱尽难眠心事',
        tracks: [
          { id: 'playlist-track-1', name: 'Playlist One', artists: ['Singer A'] },
          { id: 'playlist-track-2', name: 'Playlist Two', artists: ['Singer B'] }
        ]
      }))
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'auto-fill-entity-plan',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '下午想听港乐男声，不要太吵',
        currentMoment: { localTime: '周一 16:00', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '长期偏好粤语、叙事感、低人声。',
        recentPreferenceSummary: '近期偏好港乐男声和温暖旋律。',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 2,
        maxToolCalls: 3,
        maxNcmSearches: 8,
        maxPlaylistFetches: 3,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });
    await tools.expand_queries?.({
      exactTrackQueries: ['Exact Song Artist'],
      artistAnchors: ['Fresh Artist'],
      playlistQueries: ['港乐 男声'],
      intentQueries: ['港乐 男声 温暖'],
      tasteAnchorQueries: ['下午 专注'],
      explorationQueries: ['粤语 叙事 不吵'],
      styleHints: ['cantopop'],
      listeningConstraints: ['下午', '男声', '不吵']
    });

    const observation = await tools.recall_auto_fill_mix?.({});

    expect(ncmClient.searchSongs.mock.calls.map((call) => call[0])).toEqual(['Exact Song Artist']);
    expect(ncmClient.searchSongs).not.toHaveBeenCalledWith('港乐 男声 温暖', expect.any(Number));
    expect(ncmClient.searchSongs).not.toHaveBeenCalledWith('下午 专注', expect.any(Number));
    expect(ncmClient.searchSongs).not.toHaveBeenCalledWith('粤语 叙事 不吵', expect.any(Number));
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Fresh Artist', 3);
    expect(ncmClient.searchPlaylists.mock.calls[0]?.[0]).toBe('港乐 男声');
    expect(candidatePool.get('exact-1')).toBeDefined();
    expect(candidatePool.get('artist-track-1')).toBeDefined();
    expect(candidatePool.get('playlist-track-1')).toBeDefined();
    expect(JSON.stringify(observation?.data)).toContain('entity_recall');
    expect(tools.getQueryPlan?.()?.listeningConstraints).toEqual(['下午', '男声', '不吵']);
  });

  it('auto-fill mix prefers cantopop web discovery when exact anchors include Cantonese artists', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async () => []),
      getArtistTopSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const webMusicDiscoveryProvider = {
      discover: vi.fn(async () => [])
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'web-discovery-cantopop-from-exact-anchors',
      ncmClient: ncmClient as any,
      webMusicDiscoveryProvider,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '午后专注，来几首有新鲜感的',
        currentMoment: { localTime: '周二 16:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 18,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    await tools.expand_queries?.({
      exactTrackQueries: ['红色高跟鞋 — 蔡健雅', 'My Cookie Can — 卫兰'],
      styleHints: ['流行摇滚', '电子舞曲', 'K-pop', 'J-pop', '独立流行', '明亮节奏', '提神'],
      listeningConstraints: ['下午', '专注']
    });
    const observation = await tools.recall_auto_fill_mix?.({});

    expect(observation?.data?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'web_discovery',
        summary: expect.stringContaining('web discovery returned 0 hints')
      })
    ]));
    expect(webMusicDiscoveryProvider.discover).toHaveBeenCalledTimes(1);
    const providerInput = webMusicDiscoveryProvider.discover.mock.calls[0]?.[0];
    expect(providerInput).toMatchObject({
      focus: 'style_artists',
      anchors: [{ type: 'style', name: 'cantopop' }]
    });
    expect(providerInput.intent).toContain('卫兰');
    expect(providerInput.intent).not.toContain('Slipknot');
  });

  it('recalls providerId-backed track and playlist entities without search re-resolution', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => [
        { id: 901, name: 'Stored Candy', artists: ['Stored Artist'], durationMs: 220_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      searchPlaylists: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => ({
        id: 801,
        name: 'Stored Playlist',
        coverImgUrl: null,
        trackCount: 1,
        tracks: [{ id: 902, name: 'Stored Friday', artists: ['Playlist Artist'], durationMs: 210_000 }]
      }))
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'provider-id-entity',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxPlaylistFetches: 1,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [
        { type: 'track', providerId: '901' },
        { type: 'playlist', providerId: '801' }
      ],
      limit: 3
    });

    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
    expect(ncmClient.searchPlaylists).not.toHaveBeenCalled();
    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(['901']);
    expect(ncmClient.getPlaylistDetail).toHaveBeenCalledWith('801');
    expect(observation?.summary).toContain('entity recall attempted 2 entities, produced 2 productive entities, and added 2 candidates');
    expect(candidatePool.list().map((candidate) => candidate.id).sort()).toEqual(['901', '902']);
  });

  it('rejects unverified track entities before CandidatePool admission', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 401, name: 'Candy', artists: ['Wrong Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const { getUserQueryStats } = await import('../../src/server/store/music-query-stats.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-track-reject',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop 女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [{ type: 'track', title: 'Candy', artist: '具島直子' }]
    });

    expect(observation?.candidateCount).toBe(0);
    expect(observation?.problems).toContain('track entity rejected: Candy - 具島直子');
    expect(getUserQueryStats('entity-track-reject')).toEqual([]);
  });

  it('expands artist album and playlist entities only after NCM verification', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async () => [{ id: 501, name: '具島直子' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 601, name: 'Candy', artists: ['具島直子'] }
      ]),
      searchAlbums: vi.fn(async () => [{ id: 701, name: 'miss.G', artist: '具島直子' }]),
      getAlbumDetail: vi.fn(async () => ({
        id: 701,
        name: 'miss.G',
        artist: '具島直子',
        tracks: [{ id: 702, name: 'no no no', artists: ['具島直子'], durationMs: 240_000 }]
      })),
      searchPlaylists: vi.fn(async () => [{ id: 801, name: 'City Pop Selection', trackCount: 20, coverImgUrl: null }]),
      getPlaylistDetail: vi.fn(async () => ({
        id: 801,
        name: 'City Pop Selection',
        coverImgUrl: null,
        trackCount: 1,
        tracks: [{ id: 802, name: 'Friday Night', artists: ['J-City Artist'], durationMs: 210_000 }]
      }))
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'entity-expansion',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '下午 city pop 女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 8,
        maxPlaylistFetches: 2,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_entities?.({
      entities: [
        { type: 'artist', name: '具島直子' },
        { type: 'album', title: 'miss.G', artist: '具島直子' },
        { type: 'playlist', name: 'city pop' }
      ],
      limit: 3
    });

    expect(ncmClient.searchArtists).toHaveBeenCalledWith('具島直子', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('501');
    expect(ncmClient.searchAlbums).toHaveBeenCalledWith('miss.G 具島直子', 3);
    expect(ncmClient.getAlbumDetail).toHaveBeenCalledWith('701');
    expect(ncmClient.searchPlaylists).toHaveBeenCalledWith('city pop', 3);
    expect(ncmClient.getPlaylistDetail).toHaveBeenCalledWith('801');
    expect(observation?.summary).toContain('entity recall attempted 3 entities, produced 3 productive entities, and added 3 candidates');
    expect(candidatePool.list().map((candidate) => candidate.id).sort()).toEqual(['601', '702', '802']);
    expect(candidatePool.get('802')?.sources).toEqual(['playlist']);
  });

  it('preserves exact search queries, records a run query funnel, and persists selected query stats', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async (query: string) => query.includes('Sky')
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

    await tools.recall_from_ncm_search?.({ queries: ['Sky One Sky Singer', 'Ocean One Ocean Singer'], limit: 5 });
    tools.recordFinalPicks?.([{ id: 'ocean-1', reason: '更贴合', source: 'search' }]);

    expect(ncmClient.searchSongs.mock.calls.map((call) => call[0])).toEqual(['Sky One Sky Singer', 'Ocean One Ocean Singer']);
    expect(tools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: 'Sky One Sky Singer',
        resultCount: 2,
        addedCount: 2,
        selectedCount: 0
      }),
      expect.objectContaining({
        query: 'Ocean One Ocean Singer',
        resultCount: 1,
        addedCount: 1,
        selectedCount: 1
      })
    ]);
    expect(getUserQueryStats('user-query-funnel').map((item) => item.normalized_query)).toContain('ocean one ocean singer');
  });

  it('skips repeated search queries within the same agent run', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'repeat-once-1', name: 'Repeat Once', artists: ['Repeat Singer'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'same-run-query-dedupe',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '想听不重复的搜索结果',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 3,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const first = await tools.recall_from_ncm_search?.({ queries: ['Repeat Once Repeat Singer'], limit: 8 });
    const second = await tools.recall_from_ncm_search?.({ queries: ['Repeat Once Repeat Singer'], limit: 8 });

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(first?.summary).toContain('searched 1 queries');
    expect(second?.summary).toContain('searched 0 queries');
    expect(second?.problems).toContain('skipped 1 repeated search query in this run');
    expect(tools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: 'Repeat Once Repeat Singer',
        searchedCount: 1,
        resultCount: 1,
        uniqueResultCount: 1,
        addedCount: 1
      })
    ]);
  });

  it('skips repeated search queries across recall sources when an earlier search covered the requested limit', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'repeat-cross-source-1', name: 'Repeat Cross Source', artists: ['Repeat Singer'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'same-run-query-dedupe-cross-source',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '想听不重复的搜索结果',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 3,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const first = await tools.recall_from_ncm_search?.({ queries: ['Repeat Cross Source Repeat Singer'], limit: 8 });
    const second = await tools.recall_from_trending?.({ queries: ['Repeat Cross Source Repeat Singer'], limit: 5 });

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(ncmClient.searchSongs).toHaveBeenCalledWith('Repeat Cross Source Repeat Singer', 8);
    expect(first?.summary).toContain('searched 1 queries');
    expect(second?.summary).toContain('searched 0 queries');
    expect(second?.problems).toContain('skipped 1 repeated search query in this run');
    expect(tools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: 'Repeat Cross Source Repeat Singer',
        source: 'search',
        searchedCount: 1,
        resultCount: 1,
        uniqueResultCount: 1,
        addedCount: 1
      })
    ]);
  });

  it('limits explore auto-fill exact track anchors so reference songs do not dominate search', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async () => []),
      getArtistTopSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'explore-exact-anchor-limit',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '下午专注，粤语女声，有故事感',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxToolCalls: 3,
        maxNcmSearches: 8,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 5
    });

    await tools.expand_queries?.({
      exactTrackQueries: ['给自己的信 — 钟舒漫', '生涯规划 — 卫兰', '喜欢 — 张悬', '我发誓以后 — 苏永康'],
      styleHints: ['cantopop', '粤语流行', '女声', '轻快节奏', '有故事感'],
      listeningConstraints: ['下午', '专注', '平静']
    });
    await tools.recall_auto_fill_mix?.({});

    expect(ncmClient.searchSongs.mock.calls.map((call) => call[0])).toEqual([
      '给自己的信 — 钟舒漫',
      '生涯规划 — 卫兰'
    ]);
  });

  it('records fallback search history without adding selection credit', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'fallback-1', name: 'Fallback One', artists: ['Fallback Singer'] },
        { id: 'fallback-2', name: 'Fallback Two', artists: ['Another Singer'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { runMusicAgentLoop } = await import('../../src/server/music-agent/loop.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const {
      getUserQueryStats
    } = await import('../../src/server/store/music-query-stats.js');
    const {
      prepareSearchQueriesForRecall
    } = await import('../../src/server/music-agent/query-stats.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'fallback-query-history',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '想听轻快女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxLlmCalls: 0,
        maxToolCalls: 2,
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    await tools.recall_from_ncm_search?.({ queries: ['Fallback One Fallback Singer'], limit: 5 });
    await runMusicAgentLoop({
      llmClient: { complete: vi.fn(async () => ({ content: '{}', model: 'unused' })) },
      context: {
        request: 'auto-fill',
        currentUserText: '想听轻快女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '偏好轻松女声',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        bannedSummary: ''
      },
      candidatePool,
      tools,
      budget: {
        maxMs: 10_000,
        maxSteps: 3,
        maxLlmCalls: 0,
        maxToolCalls: 2,
        maxNcmSearches: 2,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      },
      targetPickCount: 2
    });

    expect(getUserQueryStats('fallback-query-history')).toEqual([
      expect.objectContaining({
        normalized_query: 'fallback one fallback singer',
        searched_count: 1,
        result_count: 2,
        added_count: 2,
        selected_count: 0
      })
    ]);
    expect(prepareSearchQueriesForRecall({
      userId: 'fallback-query-history',
      queries: ['Fallback One Fallback Singer', 'Fresh One Fresh Singer'],
      source: 'search',
      maxQueries: 2
    }).queries).toEqual(['Fresh One Fresh Singer', 'Fallback One Fallback Singer']);
  });

  it('keeps style seed queries out of NCM song search before semantic discovery resolves entities', async () => {
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
      userId: 'style-seed-priority',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '想听摇滚 乐队 guitar',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 8,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const observation = await tools.recall_from_style_expansion?.({ limit: 5 });

    const queries = ncmClient.searchSongs.mock.calls.map((call) => call[0]);
    expect(queries).toEqual([]);
    expect(observation?.problems).toContain('skipped semantic-only queries; use semantic discovery before NCM song search');
    expect(queries).not.toContain('city pop');
    expect(queries).not.toContain('neo-city pop');
  });

  it('uses embedded music entities when semantic style queries are not exact song searches', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => [
        { id: 9901, name: 'City Semantic', artists: ['Semantic Artist'], durationMs: 230_000 }
      ]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };
    const embeddingClient = {
      embed: vi.fn(async () => ({
        vectors: [Float32Array.from([1, 0])],
        model: 'text-embedding-v4',
        dimensions: 2
      }))
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const {
      upsertMusicEntity,
      upsertMusicEntityEmbedding
    } = await import('../../src/server/store/music-entities.js');
    upsertMusicEntity({
      userId: 'semantic-entity-recall',
      id: 'track:city-semantic',
      type: 'track',
      provider: 'ncm',
      providerId: '9901',
      title: 'City Semantic',
      artist: 'Semantic Artist',
      description: 'city pop relaxed afternoon female vocal',
      styleHints: ['city pop'],
      constraints: ['下午', '女声'],
      sourceSignals: ['seed_catalog']
    });
    upsertMusicEntityEmbedding({
      userId: 'semantic-entity-recall',
      entityId: 'track:city-semantic',
      model: 'text-embedding-v4',
      vector: Float32Array.from([1, 0])
    });

    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'semantic-entity-recall',
      ncmClient: ncmClient as any,
      embeddingClient,
      embeddingModel: 'text-embedding-v4',
      context: {
        request: 'chat-recommend',
        currentUserText: '下午 city pop 女声',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_style_expansion?.({ queries: ['city pop 女声 下午'], limit: 5 });

    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
    expect(embeddingClient.embed).toHaveBeenCalledWith(
      expect.stringContaining('city pop 女声 下午'),
      expect.any(Object)
    );
    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(['9901']);
    expect(observation?.summary).toContain('semantic entity recall added 1 candidates');
    expect(candidatePool.get('9901')).toMatchObject({
      id: '9901',
      name: 'City Semantic',
      artist: 'Semantic Artist',
      sources: ['search']
    });
  });

  it('falls back to action-derived exact queries when expand_queries receives an empty object', async () => {
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
      userId: 'empty-query-plan-defaults',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        actionQueries: [
          'Spain — Chick Corea',
          "Armando's Rhumba — Chick Corea",
          'Daylight — Taylor Swift'
        ],
        discoveryMode: 'explore',
        currentMoment: { localTime: '周五 16:25', daypart: '下午', weather: '9°C，Mist' },
        activeDirective: '',
        tasteSummary: '偏好电子、抒情摇滚、华语/英语/日语/韩语、高强度专注、提神。',
        recentPreferenceSummary: '近期偏好 J-Pop、英文歌，上班时间要提神、有节奏感、明亮不催眠，有人声/独立/有棱角。',
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
        maxNcmSearches: 12,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 40
      },
      targetPickCount: 5
    });

    const plan = await tools.expand_queries?.({});
    await tools.recall_auto_fill_mix?.({});

    const queries = ncmClient.searchSongs.mock.calls.map((call) => call[0]);
    expect(plan?.problems).toContain('empty query plan input; using context-derived defaults');
    expect(plan?.summary).not.toBe('query plan is empty.');
    expect(queries).toEqual([
      'Spain — Chick Corea',
      "Armando's Rhumba — Chick Corea",
      'Daylight — Taylor Swift'
    ]);
    expect(queries).not.toContain('女声 轻松');
    expect(queries).not.toContain('city pop 柔和');
    expect(queries).not.toContain('清爽 女声');
    expect(queries).not.toContain('indie pop 明亮');
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('keeps semantic style constraints out of no-input NCM song search', async () => {
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
      userId: 'style-expansion-current-input-only',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        discoveryMode: 'explore',
        currentMoment: { localTime: '周五 16:25', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '长期偏好包含电子、抒情摇滚、华语、提神、工作专注、低人声。',
        recentPreferenceSummary: '近期偏好包含 J-Pop、英文歌、乐队、synth、律动、不要太吵。',
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
        maxNcmSearches: 8,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 40
      }
    });

    const observation = await tools.recall_from_style_expansion?.({ limit: 5 });

    const queries = ncmClient.searchSongs.mock.calls.map((call) => call[0]);
    expect(queries).toEqual([]);
    expect(observation?.problems).toContain('skipped semantic-only queries; use semantic discovery before NCM song search');
    expect(queries).not.toEqual(expect.arrayContaining([
      'indie pop 中低能量',
      'dream pop 中低能量',
      'city pop 中低能量',
      'electropop 乐队',
      'electropop synth',
      'indie pop 低人声',
      'indie pop 律动'
    ]));
  });

  it('does not stop auto-fill mix after only eight non-liked candidates', async () => {
    const titles = [
      'Amber Lantern',
      'Blue Harbor',
      'Copper Window',
      'Distant Signal',
      'Evening Circuit',
      'Forest Radio',
      'Glass Skyline',
      'Hidden Avenue',
      'Ivory Pulse',
      'Jade Station',
      'Kinetic Letter',
      'Lunar Street'
    ];
    let trackIndex = 0;
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => {
        const title = titles[trackIndex] ?? `Extra Song ${trackIndex}`;
        trackIndex += 1;
        return [
          { id: `candidate-${trackIndex}-a`, name: title, artists: [`Artist ${trackIndex}`] },
          { id: `candidate-${trackIndex}-b`, name: `${title} Alt`, artists: [`Artist ${trackIndex} Alt`] }
        ];
      }),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool({ maxCandidates: 40 });
    const tools = createMusicAgentTools({
      userId: 'auto-fill-mix-more-than-eight',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        discoveryMode: 'comfort',
        currentUserText: '',
        currentMoment: { localTime: '周五 16:25', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 12,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 40
      },
      targetPickCount: 5
    });
    await tools.expand_queries?.({
      exactTrackQueries: [
        'Amber Lantern Artist 1',
        'Blue Harbor Artist 2',
        'Copper Window Artist 3',
        'Distant Signal Artist 4',
        'Evening Circuit Artist 5',
        'Forest Radio Artist 6',
        'Glass Skyline Artist 7',
        'Hidden Avenue Artist 8'
      ]
    });

    const observation = await tools.recall_auto_fill_mix?.({});

    expect(observation?.summary).toContain('网易云搜索 recall searched 8 queries');
    expect(candidatePool.count()).toBeGreaterThan(8);
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

    await tools.recall_from_ncm_search?.({ queries: ['City Light Fresh Artist'], limit: 10 });
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
      contextFit: 0.5,
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
          ? { ...baseScores, intentMatch: 1, tasteMatch: 1, timeFit: 1, contextFit: 1, novelty: 1, sourceConfidence: 1 }
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
        contextFit: 1,
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

    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(likedIds.slice(0, 30));
    expect(observation?.candidateCount).toBe(10);
    expect(candidatePool.count()).toBe(10);
  });

  it('samples auto-fill liked recall from the full liked id list', async () => {
    const likedIds = Array.from({ length: 100 }, (_, index) => `liked-${index + 1}`);
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
      userId: 'full-liked-random-sample',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '',
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
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await tools.recall_from_liked?.({ limit: 10 });
    } finally {
      randomSpy.mockRestore();
    }

    const fetchedIds = ncmClient.getSongDetails.mock.calls[0]?.[0] ?? [];
    expect(fetchedIds).toHaveLength(30);
    expect(fetchedIds.some((id) => Number(id.replace('liked-', '')) > 30)).toBe(true);
  });

  it('scans deeper liked ids when the first auto-fill liked window is banned', async () => {
    const likedIds = Array.from({ length: 30 }, (_, index) => `liked-${index + 1}`);
    const bannedIds = new Set(likedIds.slice(0, 10));
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
    const candidatePool = new CandidatePool({ bannedIds });
    const tools = createMusicAgentTools({
      userId: 'deeper-liked-window',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '',
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

    const observation = await tools.recall_from_liked?.({ limit: 10 });

    expect(ncmClient.getSongDetails).toHaveBeenCalledWith(likedIds.slice(0, 30));
    expect(observation?.summary).toContain('liked recall added 10 candidates from 30 ids');
    expect(candidatePool.count()).toBe(10);
    expect(candidatePool.list().map((candidate) => candidate.id)).toEqual(likedIds.slice(10, 20));
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
    await tools.expand_queries?.({ trendQueries: ['Trend Song Trend Artist'] });
    await tools.recall_from_trending?.({ limit: 1 });
    const afterFirstTrendCalls = ncmClient.searchSongs.mock.calls.length;
    await tools.recall_from_trending?.({ limit: 1 });
    const afterSecondTrendCalls = ncmClient.searchSongs.mock.calls.length;

    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(1);
    expect(afterLikedCalls).toBe(0);
    expect(afterFirstStyleCalls).toBe(afterLikedCalls);
    expect(afterSecondStyleCalls).toBe(afterFirstStyleCalls);
    expect(afterFirstTrendCalls).toBeGreaterThan(afterSecondStyleCalls);
    expect(afterSecondTrendCalls).toBe(afterFirstTrendCalls);
  });

  it('reuses search recall cache across tool registries before consuming NCM search budget', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => [
        { id: 'cached-search-1', name: 'Cached Search', artists: ['Cache Artist'] }
      ]),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const createTools = (candidatePool: InstanceType<typeof CandidatePool>, maxNcmSearches: number) => createMusicAgentTools({
      userId: 'user-search-cache',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        currentMoment: { localTime: '周一 13:30', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '',
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
        maxNcmSearches,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    const firstPool = new CandidatePool();
    const firstTools = createTools(firstPool, 1);
    const first = await firstTools.recall_from_ncm_search?.({ queries: ['Cached Search Cache Artist'], limit: 8 });
    const secondPool = new CandidatePool();
    const secondTools = createTools(secondPool, 0);
    const second = await secondTools.recall_from_ncm_search?.({ queries: ['Cached Search Cache Artist'], limit: 8 });

    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(first?.summary).toContain('searched 1 queries');
    expect(second?.summary).toContain('searched 1 queries');
    expect(secondPool.count()).toBe(1);
    expect(secondTools.getQueryFunnel?.()).toEqual([
      expect.objectContaining({
        query: 'Cached Search Cache Artist',
        resultCount: 1,
        addedCount: 1
      })
    ]);
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
    const recall = await tools.recall_from_ncm_search?.({
      queries: ['Love Story Taylor Swift', '午后流行女声', 'Fresh City Fresh Artist'],
      limit: 10
    });
    const rank = await tools.rank_candidates?.({ limit: 5 });

    expect(plan?.summary).toContain('avoidArtists=taylor swift、卫兰');
    expect(ncmClient.searchSongs).toHaveBeenCalledTimes(1);
    expect(ncmClient.searchSongs.mock.calls[0][0]).toBe('Fresh City Fresh Artist');
    expect(recall?.problems).toContain('skipped 1 search queries for recently repeated artists');
    expect(recall?.problems).toContain('skipped semantic-only queries; use semantic discovery before NCM song search');
    expect(recall?.problems).toContain('skipped 3 tracks from recently repeated artists');
    expect(recall?.problems).toContain('skipped 1 tracks after per-artist recall cap');
    expect(candidatePool.list().map((item) => item.id)).toEqual(['fresh-1', 'fresh-2', 'other-1']);
    expect(rank?.summary).toContain('adjusted=');
  });

  it('applies repeated artist avoidance to liked recall backfill', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['tanya-liked', 'fresh-liked']),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => (
        id === 'tanya-liked'
          ? { id, name: 'Letting Go', artists: ['蔡健雅'] }
          : { id, name: 'Fresh Light', artists: ['Fresh Artist'] }
      ))),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null)
    };

    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { createMusicAgentTools } = await import('../../src/server/music-agent/tools.js');
    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'liked-recall-avoid-artist',
      ncmClient: ncmClient as any,
      context: {
        request: 'auto-fill',
        currentUserText: '',
        discoveryMode: 'explore',
        currentMoment: { localTime: '周一 16:35', daypart: '下午', weather: null },
        activeDirective: '',
        tasteSummary: '',
        recentPreferenceSummary: '',
        recentPlaySignals: '',
        queueStateSummary: '',
        recentArtistPenalties: [{ artist: '蔡健雅', penalty: 0.19 }],
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

    const liked = await tools.recall_from_liked?.({ limit: 2 });

    expect(liked?.problems).toContain('skipped 1 tracks from recently repeated artists');
    expect(candidatePool.list().map((item) => item.id)).toEqual(['fresh-liked']);
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
      await tools.recall_from_ncm_search?.({ query: 'Fresh Search Search Artist', limit: 1 });
      return candidatePool.topBy((candidate) => candidate.scores.intentMatch * 0.3
        + candidate.scores.tasteMatch * 0.2
        + candidate.scores.timeFit * 0.15
        + candidate.scores.contextFit * 0.1
        + candidate.scores.sourceConfidence * 0.1
        + candidate.scores.novelty * 0.15
        - candidate.scores.recentPenalty
        - candidate.scores.skipPenalty, 2).map((candidate) => candidate.id);
    }

    expect(await rankedIds('explore')).toEqual(['search-1', 'liked-1']);
    expect(await rankedIds('comfort')).toEqual(['liked-1', 'search-1']);
  });

  it('recalls cached trend hot artists through verified artist expansion', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => []),
      getSongDetails: vi.fn(async () => []),
      searchSongs: vi.fn(async () => []),
      searchArtists: vi.fn(async () => [{ id: 'trend-artist', name: 'Cached Artist' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'trend-artist-1', name: 'Trend Artist One', artists: ['Cached Artist'] }
      ]),
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
      sources: ['ncm_artist_toplist'],
      hotArtists: ['Cached Artist'],
      hotStyles: [],
      chartTrackHints: [],
      confidence: 1
    });

    const candidatePool = new CandidatePool();
    const tools = createMusicAgentTools({
      userId: 'trend-hot-artist-recall',
      ncmClient: ncmClient as any,
      context: {
        request: 'chat-recommend',
        currentUserText: '',
        currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
        activeDirective: '',
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
        maxNcmSearches: 4,
        maxPlaylistFetches: 0,
        maxTrendFetchMs: 0,
        maxCandidates: 20
      }
    });

    await tools.get_trend_context?.({});
    const observation = await tools.recall_from_trending?.({ limit: 3 });

    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
    expect(ncmClient.searchArtists).toHaveBeenCalledWith('Cached Artist', 3);
    expect(ncmClient.getArtistTopSongs).toHaveBeenCalledWith('trend-artist');
    expect(candidatePool.get('trend-artist-1')).toMatchObject({
      id: 'trend-artist-1',
      name: 'Trend Artist One',
      artist: 'Cached Artist',
      sources: ['trend'],
      provenance: [{ kind: 'trend_recall', source: 'trend' }]
    });
    expect(observation?.summary).toContain('trend artist entity recall expanded 1 artists');
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
