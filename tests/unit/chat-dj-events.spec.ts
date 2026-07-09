import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { getQueue, setQueue } from '../../src/server/store/queue';
import { handleChatMessage } from '../../src/server/http/chat-sse-worker';
import type { NcmClient } from '../../src/server/ncm/client';

const mocks = vi.hoisted(() => ({
  computeStream: vi.fn(),
  loadUserCorpus: vi.fn(),
  loadLikedTracksForAgentContext: vi.fn(),
  fetchWeather: vi.fn(),
  extractChatPreferencesIfDue: vi.fn(),
  recommendFromChat: vi.fn()
}));

vi.mock('../../src/server/agent/compute', () => ({
  computeStream: mocks.computeStream
}));

vi.mock('../../src/server/user-corpus/loader', () => ({
  loadUserCorpus: mocks.loadUserCorpus
}));

vi.mock('../../src/server/user-corpus/ncm-liked', () => ({
  loadLikedTracksForAgentContext: mocks.loadLikedTracksForAgentContext
}));

vi.mock('../../src/server/weather', () => ({
  fetchWeather: mocks.fetchWeather
}));

vi.mock('../../src/server/music-agent/memory', () => ({
  extractChatPreferencesIfDue: mocks.extractChatPreferencesIfDue
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
  mocks.computeStream.mockImplementation(async function* () {
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
  mocks.loadUserCorpus.mockReturnValue({
    djPersona: 'You are a DJ.',
    taste: '',
    routines: '',
    moodRules: '',
    playlists: []
  });
  mocks.loadLikedTracksForAgentContext.mockResolvedValue([]);
  mocks.fetchWeather.mockResolvedValue(null);
  mocks.extractChatPreferencesIfDue.mockResolvedValue({ extracted: false, messageIds: [], summary: '' });
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
