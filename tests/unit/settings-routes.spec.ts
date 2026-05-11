import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { _resetForTest as resetDailyThemeForTest } from '../../src/server/daily-theme';
import { setLocation } from '../../src/server/store/location';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import {
  createGetSettingsHandler,
  createSaveSettingsHandler,
  createGetPlayerContextHandler
} from '../../src/server/http/routes/settings';
import { createAnalyzeTasteHandler } from '../../src/server/http/routes/taste-analysis';

const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-settings-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  process.env.CROSSFADIO_DAILY_THEME_TIMEOUT_MS = '1000';
  process.env.CROSSFADIO_TASTE_ANALYSIS_TIMEOUT_MS = '25';
  resetConfigForTest();
  resetDailyThemeForTest();
  initDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetConfigForTest();
  resetDailyThemeForTest();
  _resetDbForTest();
});

function createJsonResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  };
  return res;
}


describe('settings routes', () => {
  it('GET returns dailyThemeEnabled true by default', () => {
    const handler = createGetSettingsHandler();
    const res = createJsonResponse();

    handler({ userId: 'test-user' } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      dailyThemeEnabled: true
    });
  });

  it('PUT saves dailyThemeEnabled and GET reflects it', () => {
    const saveHandler = createSaveSettingsHandler();
    const saveRes = createJsonResponse();
    saveHandler(
      { userId: 'test-user', body: { dailyThemeEnabled: false } } as never,
      saveRes as never
    );
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body).toEqual({ ok: true });

    const getHandler = createGetSettingsHandler();
    const getRes = createJsonResponse();
    getHandler({ userId: 'test-user' } as never, getRes as never);
    expect(getRes.body).toMatchObject({ dailyThemeEnabled: false });
  });
});

describe('settings player context route', () => {
  it('includes the weather location and current weather in player context', async () => {
    setLocation('test-user', 31.2304, 121.4737);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('wttr.in')) {
        return new Response(JSON.stringify({
          current_condition: [{ temp_C: '18', weatherDesc: [{ value: 'Partly cloudy' }] }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ theme: '雨后城市漫步', keywords: ['city pop'] }) } }],
        model: 'test-model'
      }), { status: 200 });
    }));

    const handler = createGetPlayerContextHandler();
    const res = createJsonResponse();

    await handler({ userId: 'test-user' } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      weather: { location: '31.2304,121.4737', tempC: 18, desc: 'Partly cloudy' }
    });
  });

  it('generates today theme when player context is requested before DJ pick-next warms the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ theme: '雨后城市漫步', keywords: ['city pop', '雨天'] }) } }],
      model: 'test-model'
    }), { status: 200 })));

    const handler = createGetPlayerContextHandler();
    const res = createJsonResponse();

    await handler({ userId: 'test-user' } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      theme: { theme: '雨后城市漫步', keywords: ['city pop', '雨天'] },
      taste: ''
    });
  });

  it('skips daily theme generation when preference is disabled', async () => {
    const { setPref } = await import('../../src/server/store/prefs.js');
    setPref('test-user', 'dailyTheme.enabled', false);

    const handler = createGetPlayerContextHandler();
    const res = createJsonResponse();

    await handler({ userId: 'test-user' } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      theme: null,
      taste: ''
    });
  });
});

describe('settings taste analysis route', () => {
  it('returns a readable timeout message when LLM taste analysis stalls', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('llm.example')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    }));

    const handler = createAnalyzeTasteHandler();
    const res = createJsonResponse();
    const request = {
      userId: 'test-user',
      ncmClient: {
        getLikedSongIds: vi.fn().mockResolvedValue(['101']),
        getSongDetails: vi.fn().mockResolvedValue([
          { id: 101, name: 'Song A', artists: ['Artist A'], durationMs: 180_000 }
        ])
      }
    };

    const pending = handler(request as never, res as never);
    await vi.advanceTimersByTimeAsync(25);
    await pending;

    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({
      ok: false,
      message: '品味分析超时，请稍后重试'
    });
  });
});
