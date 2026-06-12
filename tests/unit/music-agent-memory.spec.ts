import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FakeLlmClient } from '../support/fake-llm';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

vi.mock('../../src/server/weather.js', () => ({
  fetchWeather: vi.fn(async () => ({ location: 'Shanghai', tempC: 22, desc: '晴' }))
}));

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-music-agent-'));
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

async function saveMessages(userId: string, contents: string[]) {
  const { saveMessage } = await import('../../src/server/store/messages.js');
  return contents.map((content) => saveMessage(userId, 'user', content));
}

describe('music agent chat preference memory', () => {
  it('skips extraction when fewer than 4 messages are pending', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['最近听点啥', '想放轻松', '不要太吵']);
    const llm = new FakeLlmClient();

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);

    expect(result).toEqual({ extracted: false, messageIds: [], summary: '' });
    expect(llm.completeCalls).toHaveLength(0);
  });

  it('saves music preference summaries and marks the batch extracted', async () => {
    const userId = 'user-1';
    await saveMessages(userId, [
      '今天想听女声',
      '偏温柔一点',
      '不要太炸',
      '最好有一点 city pop'
    ]);
    const llm = new FakeLlmClient().queueResponse(
      JSON.stringify({ musicRelated: true, summary: '近期偏好：女声、温柔、city pop，避免太炸。' })
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');
    const { getUnextractedMessages } = await import('../../src/server/store/messages.js');

    expect(result.extracted).toBe(true);
    expect(result.summary).toContain('女声');
    expect(getPreferenceContext(userId, 1)).toContain('女声');
    expect(getUnextractedMessages(userId)).toEqual([]);
  });

  it('marks non-music batches extracted without saving preference', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['我住上海', '今天开会', '项目有点忙', '晚点再说']);
    const llm = new FakeLlmClient().queueResponse(JSON.stringify({ musicRelated: false, summary: '' }));

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');
    const { getUnextractedMessages } = await import('../../src/server/store/messages.js');

    expect(result).toMatchObject({ extracted: true, summary: '' });
    expect(getPreferenceContext(userId, 1)).toBe('');
    expect(getUnextractedMessages(userId)).toEqual([]);
  });

  it('parses fenced or prose-wrapped JSON responses', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['要日系女声', '轻快一点', '适合通勤', '别太伤感']);
    const llm = new FakeLlmClient().queueResponse(
      '可以，抽取如下：\n```json\n{"musicRelated":true,"summary":"近期偏好：日系女声、轻快通勤，少伤感。"}\n```'
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');

    expect(result.extracted).toBe(true);
    expect(getPreferenceContext(userId, 1)).toContain('日系女声');
  });

  it('marks malformed LLM responses extracted without saving preference', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['想听爵士', '要松弛', '低人声', '适合夜里写代码']);
    const llm = new FakeLlmClient().queueResponse('not json at all');

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');
    const { getUnextractedMessages } = await import('../../src/server/store/messages.js');

    expect(result).toMatchObject({ extracted: true, summary: '' });
    expect(getPreferenceContext(userId, 1)).toBe('');
    expect(getUnextractedMessages(userId)).toEqual([]);
  });

  it('dedupes concurrent extraction for the same user', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['今天听女声', '要轻快一点', '别太吵', '适合通勤']);
    const llm = new FakeLlmClient().queueResponse(
      JSON.stringify({ musicRelated: true, summary: '近期偏好：女声、轻快通勤，避免太吵。' })
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const [first, second] = await Promise.all([
      extractChatPreferencesIfDue(userId, llm),
      extractChatPreferencesIfDue(userId, llm)
    ]);
    const { getLatestPreferences } = await import('../../src/server/store/chat-preferences.js');

    expect(llm.completeCalls).toHaveLength(1);
    expect(getLatestPreferences(userId, 10)).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first.extracted).toBe(true);
  });

  it('does not save musicRelated summaries that contain strong personal facts', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['我想听歌', '女声也行', '轻快一点', '别太吵']);
    const llm = new FakeLlmClient().queueResponse(
      JSON.stringify({ musicRelated: true, summary: '住址在上海某小区，公司项目会议很多。' })
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');

    expect(result.summary).toBe('');
    expect(getPreferenceContext(userId, 1)).toBe('');
  });

  it('truncates long music summaries before saving', async () => {
    const userId = 'user-1';
    await saveMessages(userId, ['喜欢 city pop', '女声', '通勤听', '节奏轻快']);
    const longSummary = `city pop 女声 通勤 节奏轻快 ${'旋律舒服'.repeat(80)}`;
    const llm = new FakeLlmClient().queueResponse(
      JSON.stringify({ musicRelated: true, summary: longSummary })
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');
    const saved = getPreferenceContext(userId, 1);

    expect(result.summary).toContain('近期偏好：');
    expect(result.summary.length).toBeLessThanOrEqual(160);
    expect(saved).toBe(result.summary);
  });

  it('limits backlog batches and prompt size', async () => {
    const userId = 'user-1';
    const longContent = '喜欢轻快女声和 city pop，'.repeat(80);
    await saveMessages(userId, Array.from({ length: 30 }, (_, index) => `${index}: ${longContent}`));
    const llm = new FakeLlmClient().queueResponse(
      JSON.stringify({ musicRelated: true, summary: '近期偏好：轻快女声、city pop。' })
    );

    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory.js');
    const result = await extractChatPreferencesIfDue(userId, llm);
    const { getUnextractedMessages } = await import('../../src/server/store/messages.js');

    expect(result.messageIds).toHaveLength(20);
    expect(getUnextractedMessages(userId)).toHaveLength(10);
    expect(llm.completeCalls[0].messages[1].content.length).toBeLessThan(8000);
  });

  it('triggers chat preference extraction from the production chat path', async () => {
    const userId = 'user-1';
    const { saveMessage } = await import('../../src/server/store/messages.js');
    saveMessage(userId, 'user', '最近喜欢 city pop');
    saveMessage(userId, 'user', '想要女声');
    saveMessage(userId, 'user', '不要太炸');

    const memoryCompleteCalls: unknown[] = [];
    vi.doMock('../../src/server/llm/config.js', () => ({
      resolveLlmConfig: () => ({ provider: 'fake', model: 'fake-model', apiKey: 'fake-key' })
    }));
    vi.doMock('../../src/server/llm/client.js', () => ({
      LlmClient: class {
        async complete(messages: unknown[]) {
          memoryCompleteCalls.push(messages);
          return {
            content: JSON.stringify({
              musicRelated: true,
              summary: '近期偏好：city pop 女声，避免太炸。'
            }),
            model: 'fake-memory-model'
          };
        }
      }
    }));
    vi.doMock('../../src/server/agent/compute.js', () => ({
      computeStream: async function* () {
        yield {
          type: 'done',
          output: {
            mode: 'chat',
            say: '记住了，后面会偏 city pop 女声。',
            intent: 'chitchat',
            actions: []
          }
        };
      }
    }));
    vi.doMock('../../src/server/logger.js', () => ({
      getLogger: () => ({
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      })
    }));

    const { handleChatMessage } = await import('../../src/server/http/chat-sse-worker.js');
    await handleChatMessage(
      userId,
      { getLikedSongIds: vi.fn(async () => []), getSongDetails: vi.fn(async () => []) } as never,
      '继续来点轻快 city pop 女声',
      vi.fn()
    );

    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences.js');
    await vi.waitFor(() => {
      expect(getPreferenceContext(userId, 1)).toContain('city pop 女声');
    });
    expect(JSON.stringify(memoryCompleteCalls[0])).toContain('继续来点轻快 city pop 女声');

    vi.doUnmock('../../src/server/llm/config.js');
    vi.doUnmock('../../src/server/llm/client.js');
    vi.doUnmock('../../src/server/agent/compute.js');
    vi.doUnmock('../../src/server/logger.js');
  });
});

describe('music agent context builder', () => {
  it('builds a compact schema-valid context from weather, corpus, prefs, plays and queue', async () => {
    const userId = 'user-1';
    const now = new Date('2026-06-04T07:30:00+08:00');
    const { resolveUserDir } = await import('../../src/server/app-paths.js');
    const userDir = resolveUserDir(userId);
    fs.writeFileSync(path.join(userDir, 'taste.md'), '偏好女声、City Pop、日系独立；不喜欢过重低音。');
    fs.writeFileSync(path.join(userDir, 'routines.md'), '早晨通勤需要轻快但不吵。');
    fs.writeFileSync(path.join(userDir, 'mood-rules.md'), '压力大时避免伤感歌。');

    const { saveChatPreference } = await import('../../src/server/store/chat-preferences.js');
    saveChatPreference(userId, '近期偏好：女声、轻快通勤。', [1, 2, 3, 4]);

    const { startPlay, endPlay } = await import('../../src/server/store/plays.js');
    const playId = startPlay(userId, { songId: '100', songName: '晨光', artistName: '阿雅' });
    endPlay(userId, playId, 'completed');

    const { setQueue } = await import('../../src/server/store/queue.js');
    setQueue(userId, [
      { ncmId: '200', name: '海边公路', artists: ['林风'], query: 'city pop' },
      { ncmId: '201', name: '慢慢亮起来', artists: ['Mika'], query: 'morning pop' }
    ]);

    const { setPref } = await import('../../src/server/store/prefs.js');
    setPref(userId, 'queue.activeDirective', {
      text: '接下来保持轻快女声',
      expiresAt: '2026-06-04T08:30:00+08:00'
    });
    setPref(userId, 'queue.moodOverride', { mood: '通勤轻快' });
    setPref(userId, 'plan.replanHint', { mood: '减少伤感' });

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const { musicAgentContextSummarySchema } = await import('../../src/server/music-agent/schema.js');
    const context = await buildMusicAgentContext({
      userId,
      ncmClient: {} as never,
      request: 'chat-recommend',
      userText: '给我接着推荐',
      now
    });

    expect(() => musicAgentContextSummarySchema.parse(context)).not.toThrow();
    expect(context.request).toBe('chat-recommend');
    expect(context.currentUserText).toBe('给我接着推荐');
    expect(context.currentMoment.localTime).toMatch(/周四 07:30/);
    expect(context.currentMoment.daypart).toBe('早晨');
    expect(context.currentMoment.weather).toBe('22°C，晴');
    expect(context.activeDirective).toBe('接下来保持轻快女声');
    expect(context.tasteSummary).toContain('City Pop');
    expect(context.recentPreferenceSummary).toContain('女声');
    expect(context.recentPlaySignals).toContain('晨光');
    expect(context.recentPlaySignals).toContain('completed');
    expect(context.queueStateSummary).toContain('海边公路');
    expect(context.queueStateSummary).toContain('200');
    expect(context.recentArtistPenalties).toEqual([
      { artist: '林风', penalty: 0.36 },
      { artist: 'mika', penalty: 0.28 },
      { artist: '阿雅', penalty: 0.3 }
    ]);
    expect(context.bannedSummary).toContain('通勤轻快');
    expect(context.bannedSummary).toContain('减少伤感');
  });

  it('builds long-lived track penalties from repeated play history with slow decay', async () => {
    const userId = 'track-repeat-user';
    const { getDb } = await import('../../src/server/store/db.js');
    const db = getDb();
    const insertPlay = db.prepare(
      `INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertPlay.run(userId, '659423', 'プラスティック・ラヴ', '竹内まりや', '2026-06-11 02:00:00');
    insertPlay.run(userId, '659423', 'プラスティック・ラヴ', '竹内まりや', '2026-06-05 02:00:00');
    insertPlay.run(userId, '659423', 'プラスティック・ラヴ', '竹内まりや', '2026-05-22 02:00:00');
    insertPlay.run(userId, '26127770', 'Plastic Love (New-Remix)', '竹内まりや', '2026-04-01 02:00:00');
    insertPlay.run(userId, '22707008', '真夜中のドア〜stay with me', '松原みき', '2026-05-08 02:00:00');
    insertPlay.run(userId, 'old-only', 'Old Theme Song', 'Old Artist', '2026-03-01 02:00:00');

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const context = await buildMusicAgentContext({
      userId,
      request: 'auto-fill',
      now: new Date('2026-06-12T02:00:00.000Z')
    });

    const penalties = context.recentTrackPenalties ?? [];
    const plasticLove = penalties.find((item) => item.trackKey === 'プラスティックラヴ::竹内まりや');
    const stayWithMe = penalties.find((item) => item.trackKey === '真夜中のドアstaywithme::松原みき');

    expect(plasticLove).toMatchObject({
      title: 'プラスティック・ラヴ',
      artist: '竹内まりや'
    });
    expect(stayWithMe).toMatchObject({
      title: '真夜中のドア〜stay with me',
      artist: '松原みき'
    });
    expect(plasticLove?.penalty).toBeGreaterThan(stayWithMe?.penalty ?? 0);
    expect(plasticLove?.penalty).toBeLessThan(0.28);
    expect(stayWithMe?.penalty).toBeGreaterThan(0);
    expect(penalties.some((item) => item.title === 'Old Theme Song')).toBe(false);
  });

  it('uses Shanghai daypart even when the server process timezone is UTC', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
      const context = await buildMusicAgentContext({
        userId: 'user-timezone',
        request: 'auto-fill',
        now: new Date('2026-06-09T04:30:00.000Z')
      });

      expect(context.currentMoment.localTime).toBe('周二 12:30');
      expect(context.currentMoment.daypart).toBe('中午');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('omits expired active directives', async () => {
    const userId = 'user-1';
    const { setPref } = await import('../../src/server/store/prefs.js');
    setPref(userId, 'queue.activeDirective', {
      text: '已经过期的指令',
      expiresAt: '2026-06-04T06:59:00+08:00'
    });

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const context = await buildMusicAgentContext({
      userId,
      request: 'auto-fill',
      now: new Date('2026-06-04T07:30:00+08:00')
    });

    expect(context.activeDirective).toBe('');
  });

  it('includes active temporary queue bans in the context banned summary', async () => {
    const userId = 'user-temp-ban-context';
    const { recordTemporaryQueueBans } = await import('../../src/server/store/temporary-bans.js');
    recordTemporaryQueueBans(userId, [
      { id: 'blocked-context-id', name: 'Blocked Context Song', artists: ['Blocked Context Artist'] }
    ], new Date('2026-06-04T07:30:00+08:00'));

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const context = await buildMusicAgentContext({
      userId,
      request: 'auto-fill',
      now: new Date('2026-06-04T08:00:00+08:00')
    });

    expect(context.bannedSummary).toContain('temporaryQueueBans');
    expect(context.bannedSummary).toContain('Blocked Context Song');
    expect(context.bannedSummary).toContain('blocked-context-id');
  });

  it('omits daily theme when the caller disables theme context', async () => {
    vi.doMock('../../src/server/daily-theme.js', () => ({
      getDailyTheme: () => ({
        date: '2026-06-04',
        theme: '今日主题应该被跳过',
        keywords: ['skip-me'],
        generatedAt: Date.now()
      })
    }));

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const context = await buildMusicAgentContext({
      userId: 'user-1',
      request: 'auto-fill',
      now: new Date('2026-06-04T07:30:00+08:00'),
      includeDailyTheme: false
    } as never);

    expect(context.currentMoment.dailyTheme).toBeUndefined();

    vi.doUnmock('../../src/server/daily-theme.js');
  });

  it('degrades to null weather when weather fetch rejects', async () => {
    const { fetchWeather } = await import('../../src/server/weather.js');
    (fetchWeather as Mock).mockRejectedValueOnce(new Error('weather failed'));

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const context = await buildMusicAgentContext({
      userId: 'user-1',
      request: 'auto-fill',
      now: new Date('2026-06-04T07:30:00+08:00')
    });

    expect(context.currentMoment.weather).toBeNull();
  });

  it('does not block when weather fetch hangs', async () => {
    vi.useFakeTimers();
    const { fetchWeather } = await import('../../src/server/weather.js');
    (fetchWeather as Mock).mockImplementationOnce(() => new Promise(() => {}));

    const { buildMusicAgentContext } = await import('../../src/server/music-agent/context.js');
    const promise = buildMusicAgentContext({
      userId: 'user-1',
      request: 'auto-fill',
      now: new Date('2026-06-04T07:30:00+08:00')
    });

    await vi.advanceTimersByTimeAsync(1600);
    const context = await promise;

    expect(context.currentMoment.weather).toBeNull();
  });
});
