import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(context.bannedSummary).toContain('通勤轻快');
    expect(context.bannedSummary).toContain('减少伤感');
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
});
