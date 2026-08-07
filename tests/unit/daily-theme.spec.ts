import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfigForTest } from '../../src/server/config';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import {
  _resetForTest,
  getDailyTheme,
  getOrGenerateDailyTheme,
  getOrGenerateDailyThemeWithin
} from '../../src/server/daily-theme';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  process.env.CROSSFADIO_DAILY_THEME_TIMEOUT_MS = '25';
  resetConfigForTest();
  _resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetConfigForTest();
  _resetForTest();
  _resetDbForTest();
});

describe('daily theme generation', () => {
  it('lets callers stop waiting for a slow theme without cancelling the shared generation', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        });
      })
    ));

    const sharedGeneration = getOrGenerateDailyTheme();
    const shortWait = getOrGenerateDailyThemeWithin(10);

    await vi.advanceTimersByTimeAsync(10);
    await expect(shortWait).resolves.toBeNull();
    expect(getDailyTheme()).toBeNull();

    await vi.advanceTimersByTimeAsync(15);
    await expect(sharedGeneration).resolves.toMatchObject({
      theme: expect.stringContaining('特辑')
    });
    expect(getDailyTheme()).not.toBeNull();
  });

  it('rejects generated themes that pin an all-day theme to night', async () => {
    vi.setSystemTime(new Date('2026-05-15T06:30:00.000Z'));
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              theme: '春末微风，周五夜晚的惬意时光',
              keywords: ['周五夜晚', 'city pop']
            })
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    ));

    const theme = await getOrGenerateDailyTheme();

    expect(theme?.theme).not.toContain('夜晚');
    expect(theme?.theme).not.toContain('周五晚');
    expect(theme?.keywords).not.toContain('周五夜晚');
  });

  it('injects searched hot topics into the theme prompt', async () => {
    process.env.CROSSFADIO_SEARCH_API_KEY = 'test-search-key';
    resetConfigForTest();

    let llmRequestBody: { messages?: Array<{ role: string; content: string }> } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('feedcoopapi.com')) {
        return new Response(JSON.stringify({
          ResponseMetadata: {},
          Result: {
            WebResults: [
              { Title: '某乐队宣布重组巡演', SiteName: '娱乐周刊', Content: '时隔十年再度同台' }
            ]
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      llmRequestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ theme: '重组与重逢之声', keywords: ['comeback', '华语乐队'] }) }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const theme = await getOrGenerateDailyTheme();

    expect(theme?.theme).toBe('重组与重逢之声');
    const userMessage = llmRequestBody?.messages?.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('今日实时热点');
    expect(userMessage?.content).toContain('某乐队宣布重组巡演');
  });

  it('still generates a theme when hot topic search fails', async () => {
    process.env.CROSSFADIO_SEARCH_API_KEY = 'test-search-key';
    resetConfigForTest();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('feedcoopapi.com')) {
        return Promise.reject(new Error('search unavailable'));
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ theme: '夏日慢生活', keywords: ['city pop'] }) }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const theme = await getOrGenerateDailyTheme();

    expect(theme?.theme).toBe('夏日慢生活');
  });

  it('reuses the persisted theme after an in-memory cache reset', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-daily-theme-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    initDb();
    vi.setSystemTime(new Date('2026-08-07T02:00:00.000Z'));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ theme: '持久化主题', keywords: ['lofi'] }) }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    ));

    const generated = await getOrGenerateDailyTheme();
    expect(generated?.theme).toBe('持久化主题');

    // 模拟服务重启：清空内存缓存，同一天应直接回源 SQLite，不再调用 LLM
    _resetForTest();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(getDailyTheme()?.theme).toBe('持久化主题');
    await expect(getOrGenerateDailyTheme()).resolves.toMatchObject({ theme: '持久化主题' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
