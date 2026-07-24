import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { getDb, initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { getQueue, setQueue } from '../../src/server/store/queue';
import {
  createExplicitExclusion,
  listActiveExplicitExclusions
} from '../../src/server/store/explicit-exclusions';
import {
  extractQueueDirectiveFromText,
  handleChatMessage
} from '../../src/server/http/chat-sse-worker';
import type { NcmClient } from '../../src/server/ncm/client';
import type { Fragments } from '../../src/server/agent/schema';
import { createListeningEpisode } from '../../src/server/store/listening-episodes';
import { getUnextractedMessages } from '../../src/server/store/messages';
import { getPreferenceExtractionBatchBySource } from '../../src/server/store/preference-extraction-batches';
import { PREFERENCE_EXTRACTION_VERSION } from '../../src/server/music-agent/preference-extraction';
import {
  getSelectionRotationSnapshot,
  recordSelectionRotationRound
} from '../../src/server/store/selection-rotation';

const mocks = vi.hoisted(() => ({
  computeStream: vi.fn(),
  buildDjMemorySnapshot: vi.fn(),
  fetchWeather: vi.fn(),
  recommendFromChat: vi.fn()
}));

let capturedFragments: Fragments | null = null;

vi.mock('../../src/server/agent/compute', () => ({
  computeStream: mocks.computeStream
}));

vi.mock('../../src/server/dj-memory/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/dj-memory/snapshot')>();
  mocks.buildDjMemorySnapshot.mockImplementation(actual.buildDjMemorySnapshot);
  return { ...actual, buildDjMemorySnapshot: mocks.buildDjMemorySnapshot };
});

vi.mock('../../src/server/weather', () => ({
  fetchWeather: mocks.fetchWeather
}));

vi.mock('../../src/server/music-agent/index', () => ({
  MusicAgent: vi.fn().mockImplementation(() => ({
    recommendFromChat: mocks.recommendFromChat
  }))
}));

const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-chat-dj-events-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  resetConfigForTest();
  initDb();

  vi.clearAllMocks();
  capturedFragments = null;
  mocks.computeStream.mockImplementation(async function* (fragments: Fragments) {
    capturedFragments = fragments;
    yield {
      type: 'done',
      output: {
        mode: 'chat',
        say: '收到',
        intent: 'chitchat',
        actions: []
      }
    };
  });
  mocks.fetchWeather.mockResolvedValue(null);
  mocks.recommendFromChat.mockResolvedValue({
    status: 'empty_pool',
    mode: 'chat_recommend',
    say: '没有合适的推荐',
    picks: [],
    rejected: [],
    queryFunnel: [],
    trace: [],
    candidateScoreTable: []
  });
});

afterEach(() => {
  _resetDbForTest();
  process.env = { ...originalEnv };
  resetConfigForTest();
});

describe('chat DJ event integration', () => {
  it('keeps fallback active directives for 24 hours', () => {
    const now = new Date('2026-07-17T10:00:00.000Z');
    expect(extractQueueDirectiveFromText('接下来多放女声', now)?.expiresAt)
      .toBe('2026-07-18T10:00:00.000Z');
  });

  it('records listener requests and fallback queue directive updates', async () => {
    const userId = 'chat-events-user-1';
    setQueue(userId, []);

    await handleChatMessage(userId, mockNcmClient(), '接下来多放女声', vi.fn());

    const events = getRecentDjEvents(userId, 10);
    const listenerEvent = events.find((event) => event.type === 'listener_request_received');
    const directiveEvent = events.find((event) => event.type === 'directive_updated');

    expect(listenerEvent?.payload).toMatchObject({
      messageId: expect.any(Number),
      requestSummary: '接下来多放女声'
    });
    expect(directiveEvent?.payload).toMatchObject({
      source: 'fallback'
    });
    expect(JSON.stringify(directiveEvent?.payload)).toContain('女声');
    expect(mocks.buildDjMemorySnapshot).toHaveBeenCalledTimes(1);
    expect(capturedFragments?.djMemory).toMatchObject({ purpose: 'chat' });
    expect(capturedFragments).not.toHaveProperty('corpus');
    expect(capturedFragments).not.toHaveProperty('env');
    expect(capturedFragments).not.toHaveProperty('memory');
  });

  it('continues the chat when historical rotation data has too many artist identities', async () => {
    const userId = 'chat-legacy-many-artists';
    const send = vi.fn();
    setQueue(userId, []);
    recordSelectionRotationRound({
      userId,
      runId: 'legacy-many-artists-run',
      tracks: [{
        id: 'legacy-many-artists-track',
        name: 'Legacy Many Artists Song',
        artists: ['Legacy Artist']
      }]
    });
    getDb().prepare(`
      UPDATE selection_rotation_picks
      SET artist_keys_json = ?
      WHERE user_id = ? AND run_id = ?
    `).run(
      JSON.stringify(Array.from({ length: 38 }, (_, index) => `legacy artist ${index + 1}`)),
      userId,
      'legacy-many-artists-run'
    );

    await handleChatMessage(userId, mockNcmClient(), '来几首炎明熹的歌吧', send);

    expect(send).toHaveBeenCalledWith('chat.done', {
      say: '收到',
      intent: 'chitchat',
      actions: []
    });
    expect(send).not.toHaveBeenCalledWith('chat.error', expect.anything());
  });

  it('records chat-authored active directive updates from set_pref actions', async () => {
    const userId = 'chat-events-user-2';
    setQueue(userId, []);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '后面按这个方向走',
          intent: 'adjust_queue',
          actions: [
            {
              type: 'set_pref',
              key: 'queue.activeDirective',
              value: { text: '下午 city pop，稳定一点', ttlHours: 2 }
            }
          ]
        }
      };
    });

    await handleChatMessage(userId, mockNcmClient(), '后面来点稳定 city pop', vi.fn());

    const directiveEvent = getRecentDjEvents(userId, 10)
      .find((event) => event.type === 'directive_updated');
    expect(directiveEvent?.payload).toEqual({
      directive: '下午 city pop，稳定一点',
      source: 'chat'
    });
  });

  it('applies structured listener exclusions before building DJ Memory', async () => {
    const userId = 'chat-events-user-exclusion';
    setQueue(userId, []);

    await handleChatMessage(userId, mockNcmClient(), '不要再放某乐队', vi.fn());

    expect(listActiveExplicitExclusions(userId)).toEqual([
      expect.objectContaining({
        entityType: 'artist',
        entityKey: '某乐队',
        sourceKind: 'listener_instruction',
        sourceRef: { messageId: expect.any(Number) }
      })
    ]);
    expect(mocks.buildDjMemorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('enqueues arbitrary chat language for durable preference extraction', async () => {
    const userId = 'chat-events-user-preference-extraction';

    await handleChatMessage(userId, mockNcmClient(), '我最近越来越喜欢 Radiohead', vi.fn());

    const [message] = getUnextractedMessages(userId);
    expect(message?.content).toBe('我最近越来越喜欢 Radiohead');
    expect(getPreferenceExtractionBatchBySource(
      userId,
      `message:${message?.id}`,
      PREFERENCE_EXTRACTION_VERSION
    )).toMatchObject({
      userId,
      messageIds: [message?.id],
      status: 'pending',
      attemptCount: 0
    });
  });

  it('records selection events when chat recommendation adds MusicAgent picks', async () => {
    const userId = 'chat-events-user-3';
    setQueue(userId, [{ ncmId: 'current-track', name: 'Current', artists: ['Current Artist'] }]);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '我给你接一首',
          intent: 'adjust_queue',
          actions: [
            {
              type: 'add_to_queue',
              pick: { query: 'city pop' },
              position: 'end'
            }
          ]
        }
      };
    });
    mocks.recommendFromChat.mockResolvedValue({
      status: 'ok',
      mode: 'chat_recommend',
      say: '适合维持轻快但不打扰的气氛',
      picks: [
        {
          id: 'track-1',
          name: 'Track One',
          artist: 'Artist One',
          reason: 'matches the city pop request',
          source: 'search'
        }
      ],
      rejected: [],
      queryFunnel: [],
      trace: [],
      candidateScoreTable: []
    });

    await handleChatMessage(userId, mockNcmClient(), '帮我加一首 city pop', vi.fn());

    expect(mocks.buildDjMemorySnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.recommendFromChat).toHaveBeenCalledWith(expect.objectContaining({
      selectionAdapter: expect.objectContaining({
        runtimeContext: expect.objectContaining({
          request: 'chat-recommend',
          currentUserText: '帮我加一首 city pop',
          queueStateSummary: expect.stringContaining('current-track')
        })
      })
    }));

    expect(getQueue(userId).map((track) => track.ncmId)).toEqual(['current-track', 'track-1']);
    const events = getRecentDjEvents(userId, 10);
    expect(events.find((event) => event.type === 'selection_started')?.payload).toMatchObject({
      trigger: 'chat_recommend',
      targetCount: 1,
      batchRationale: '帮我加一首 city pop'
    });
    expect(events.find((event) => event.type === 'track_selected')?.payload).toMatchObject({
      trackId: 'track-1',
      trackName: 'Track One',
      artist: 'Artist One',
      selectionRationale: 'matches the city pop request',
      source: 'search',
      pickOrder: 1
    });
    expect(events.find((event) => event.type === 'queue_changed')?.payload).toMatchObject({
      action: 'append',
      trackIds: ['track-1'],
      position: 'end'
    });
    expect(getSelectionRotationSnapshot(userId)).toMatchObject({
      currentRound: 0,
      picks: [
        expect.objectContaining({
          trackId: 'track-1',
          roundNumber: 0
        })
      ]
    });
  });

  it('rolls back the MusicAgent queue mutation and events when rotation persistence fails', async () => {
    const userId = 'chat-events-user-atomic-agent';
    setQueue(userId, [{ ncmId: 'current-track', name: 'Current', artists: ['Current Artist'] }]);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '我给你接一首',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'city pop' },
            position: 'end'
          }]
        }
      };
    });
    mocks.recommendFromChat.mockResolvedValue({
      status: 'ok',
      mode: 'chat_recommend',
      say: '接一首',
      picks: [{
        id: 'track-atomic',
        name: 'Atomic Track',
        artist: 'Atomic Artist',
        reason: 'atomic recommendation',
        source: 'search'
      }],
      rejected: [],
      queryFunnel: [],
      trace: [],
      candidateScoreTable: []
    });
    getDb().exec(`
      CREATE TRIGGER fail_chat_rotation_insert
      BEFORE INSERT ON selection_rotation_picks
      BEGIN
        SELECT RAISE(ABORT, 'forced rotation failure');
      END;
    `);

    await handleChatMessage(userId, mockNcmClient(), '帮我加一首 city pop', vi.fn());

    expect(getQueue(userId).map((track) => track.ncmId)).toEqual(['current-track']);
    const events = getRecentDjEvents(userId, 10);
    expect(events.some((event) => event.type === 'track_selected')).toBe(false);
    expect(events.some((event) => event.type === 'queue_changed')).toBe(false);
    expect(getSelectionRotationSnapshot(userId).picks).toEqual([]);
  });

  it('records a direct explicit chat pick as exposure without advancing the autonomous round', async () => {
    const userId = 'chat-events-user-direct';
    setQueue(userId, []);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '给你加上',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'Plastic Love — 竹内まりや' },
            position: 'end'
          }]
        }
      };
    });
    const ncmClient = mockNcmClient() as NcmClient & {
      getSongDetails: ReturnType<typeof vi.fn>;
    };
    vi.mocked(ncmClient.searchSongs).mockResolvedValue([{
      id: 'direct-track',
      name: 'Plastic Love',
      artists: ['竹内まりや']
    }]);
    ncmClient.getSongDetails = vi.fn().mockResolvedValue([{
      id: 'direct-track',
      name: 'Plastic Love',
      artists: ['竹内まりや']
    }]);

    await handleChatMessage(userId, ncmClient, '直接放 Plastic Love', vi.fn());

    expect(mocks.recommendFromChat).not.toHaveBeenCalled();
    expect(getSelectionRotationSnapshot(userId)).toMatchObject({
      currentRound: 0,
      picks: [
        expect.objectContaining({
          trackId: 'direct-track',
          roundNumber: 0
        })
      ]
    });
  });

  it('rolls back a direct chat queue mutation when rotation persistence fails', async () => {
    const userId = 'chat-events-user-direct-atomic';
    setQueue(userId, []);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '给你加上',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'Plastic Love — 竹内まりや' },
            position: 'end'
          }]
        }
      };
    });
    const ncmClient = mockNcmClient() as NcmClient & {
      getSongDetails: ReturnType<typeof vi.fn>;
    };
    vi.mocked(ncmClient.searchSongs).mockResolvedValue([{
      id: 'direct-track',
      name: 'Plastic Love',
      artists: ['竹内まりや']
    }]);
    ncmClient.getSongDetails = vi.fn().mockResolvedValue([{
      id: 'direct-track',
      name: 'Plastic Love',
      artists: ['竹内まりや']
    }]);
    getDb().exec(`
      CREATE TRIGGER fail_direct_rotation_insert
      BEFORE INSERT ON selection_rotation_picks
      BEGIN
        SELECT RAISE(ABORT, 'forced rotation failure');
      END;
    `);

    await handleChatMessage(userId, ncmClient, '直接放 Plastic Love', vi.fn());

    expect(getQueue(userId)).toEqual([]);
    expect(getSelectionRotationSnapshot(userId).picks).toEqual([]);
  });

  it('reports recommendation failures with a stable code instead of provider text', async () => {
    const send = vi.fn();
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '我来找一首',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'city pop' },
            position: 'end'
          }]
        }
      };
    });
    mocks.recommendFromChat.mockRejectedValue(Object.assign(
      new Error('response body: PRIVATE PDC'),
      { status: 503, responseBody: '{"echo":"PRIVATE PROMPT"}' }
    ));

    await handleChatMessage('chat-safe-error', mockNcmClient(), '来点 city pop', send);

    expect(send).toHaveBeenCalledWith('chat.recommend.progress', expect.objectContaining({
      phase: 'error',
      reason: 'provider_server_error'
    }));
    expect(JSON.stringify(send.mock.calls)).not.toContain('PRIVATE');
  });

  it('returns a friendly generic chat error without leaking upstream details', async () => {
    const send = vi.fn();
    mocks.buildDjMemorySnapshot.mockRejectedValueOnce(Object.assign(
      new Error('PRIVATE provider response'),
      { status: 429, responseBody: 'PRIVATE PROMPT' }
    ));

    await handleChatMessage('chat-safe-outer-error', mockNcmClient(), '你好', send);

    expect(send).toHaveBeenCalledWith('chat.error', {
      error: 'AI DJ 暂时不可用，请稍后重试。',
      code: 'provider_rate_limited'
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('PRIVATE');
  });

  it('keeps a fresh explicit artist exclusion as a hard gate at chat queue apply', async () => {
    const userId = 'chat-events-user-final-gate';
    const send = vi.fn();
    setQueue(userId, [{ ncmId: 'current-track', name: 'Current', artists: ['Current Artist'] }]);
    createExplicitExclusion({
      userId,
      entityType: 'artist',
      entityKey: 'Blocked Artist',
      displayName: 'Blocked Artist',
      sourceKind: 'listener_instruction',
      sourceRef: { sourceId: 'test-exclusion' }
    });
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '我来挑一首',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'something fresh' },
            position: 'end'
          }]
        }
      };
    });
    mocks.recommendFromChat.mockResolvedValue({
      status: 'ok',
      mode: 'chat_recommend',
      say: '找到一首',
      picks: [{
        id: 'blocked-track',
        name: 'Blocked Song',
        artist: 'Blocked Artist',
        reason: 'matches request',
        source: 'search'
      }],
      rejected: [],
      queryFunnel: [],
      trace: [],
      candidateScoreTable: []
    });

    await handleChatMessage(userId, mockNcmClient(), '换点新鲜的', send);

    expect(getQueue(userId).map((track) => track.ncmId)).toEqual(['current-track']);
    expect(mocks.recommendFromChat).toHaveBeenCalledWith(expect.objectContaining({
      selectionAdapter: expect.objectContaining({
        policyContext: expect.objectContaining({
          explicitExclusions: expect.objectContaining({
            artistKeys: new Set(['blocked artist'])
          })
        })
      })
    }));
    expect(send).toHaveBeenCalledWith('chat.recommend.progress', expect.objectContaining({
      phase: 'skipped',
      skipped: [expect.objectContaining({
        id: 'blocked-track',
        reason: 'explicit_artist_exclusion'
      })]
    }));
  });

  it('allows an explicit chat request to replay a track from listening history', async () => {
    const userId = 'chat-events-user-explicit-replay';
    setQueue(userId, [{ ncmId: 'current-track', name: 'Current', artists: ['Current Artist'] }]);
    createListeningEpisode(userId, 'recent-episode', {
      playerInstanceId: 'player-1',
      deckId: 'deck-a',
      track: { id: 'recent-track', name: 'Recent Song', artists: ['Recent Artist'] },
      durationMs: 180_000,
      checkpointSeq: 0
    });
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '再放一次',
          intent: 'adjust_queue',
          actions: [{
            type: 'add_to_queue',
            pick: { query: 'Recent Song' },
            position: 'end'
          }]
        }
      };
    });
    mocks.recommendFromChat.mockResolvedValue({
      status: 'ok',
      mode: 'chat_recommend',
      say: '按你的要求再来一次',
      picks: [{
        id: 'recent-track',
        name: 'Recent Song',
        artist: 'Recent Artist',
        reason: 'explicit replay request',
        source: 'search'
      }],
      rejected: [],
      queryFunnel: [],
      trace: [],
      candidateScoreTable: []
    });

    await handleChatMessage(userId, mockNcmClient(), '再放一遍 Recent Song', vi.fn());

    expect(getQueue(userId).map((track) => track.ncmId)).toEqual(['current-track', 'recent-track']);
  });

  it('limits chat swap_next recommendations to one track so queue order matches DJ events', async () => {
    const userId = 'chat-events-user-4';
    setQueue(userId, [
      { ncmId: 'current-track', name: 'Current', artists: ['Current Artist'] },
      { ncmId: 'old-next', name: 'Old Next', artists: ['Old Artist'] }
    ]);
    mocks.computeStream.mockImplementation(async function* () {
      yield {
        type: 'done',
        output: {
          mode: 'chat',
          say: '我换下一首',
          intent: 'adjust_queue',
          actions: [
            {
              type: 'swap_next',
              pick: { query: 'brighter city pop' },
              position: 'after_current'
            }
          ]
        }
      };
    });
    mocks.recommendFromChat.mockResolvedValue({
      status: 'ok',
      mode: 'chat_recommend',
      say: '下一首更明亮',
      picks: [
        {
          id: 'track-1',
          name: 'Track One',
          artist: 'Artist One',
          reason: 'best next transition',
          source: 'search'
        },
        {
          id: 'track-2',
          name: 'Track Two',
          artist: 'Artist Two',
          reason: 'second option',
          source: 'search'
        }
      ],
      rejected: [],
      queryFunnel: [],
      trace: [],
      candidateScoreTable: []
    });

    await handleChatMessage(userId, mockNcmClient(), '把下一首换得明亮一点', vi.fn());

    expect(getQueue(userId).map((track) => track.ncmId)).toEqual(['current-track', 'track-1', 'old-next']);
    const events = getRecentDjEvents(userId, 10);
    expect(events.find((event) => event.type === 'selection_started')?.payload).toMatchObject({
      trigger: 'chat_recommend',
      targetCount: 1,
      batchRationale: '把下一首换得明亮一点'
    });
    const selectedEvents = events.filter((event) => event.type === 'track_selected');
    expect(selectedEvents).toHaveLength(1);
    expect(selectedEvents[0]?.payload).toMatchObject({
      trackId: 'track-1',
      trackName: 'Track One',
      selectionRationale: 'best next transition',
      pickOrder: 1
    });
    expect(events.find((event) => event.type === 'queue_changed')?.payload).toMatchObject({
      action: 'swap_next',
      trackIds: ['track-1'],
      position: 'after_current'
    });
  });
});

function mockNcmClient(): NcmClient {
  return {
    searchSongs: vi.fn(),
    searchArtists: vi.fn(),
    searchAlbums: vi.fn(),
    searchPlaylists: vi.fn(),
    songUrl: vi.fn(),
    lyric: vi.fn(),
    playlistDetail: vi.fn(),
    likelist: vi.fn(),
    songDetail: vi.fn(),
    artistTopSongs: vi.fn(),
    artistAlbums: vi.fn(),
    album: vi.fn()
  } as unknown as NcmClient;
}
