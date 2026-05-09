import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { _resetForTest as resetDailyThemeForTest } from '../../src/server/daily-theme';
import { createGetPlayerContextHandler } from '../../src/server/http/routes/settings';
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetConfigForTest();
  resetDailyThemeForTest();
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

describe('settings player context route', () => {
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
