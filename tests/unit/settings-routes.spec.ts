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
  createPreviewTtsHandler,
  createSaveSettingsHandler,
  createGetPlayerContextHandler
} from '../../src/server/http/routes/settings';
import { createAnalyzeTasteHandler, runTasteAnalysis } from '../../src/server/http/routes/taste-analysis';
import { NCM_ERROR_CODE } from '../../src/shared/schema';
import { DEFAULT_TTS_MODEL } from '../../src/shared/tts';

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
      tts: { model: DEFAULT_TTS_MODEL, voice: 'Cherry' },
      dailyThemeEnabled: true,
      discoveryMode: 'explore',
      autoFillBatchSize: 2
    });
  });

  it('PUT saves dailyThemeEnabled, discoveryMode and autoFillBatchSize and GET reflects them', () => {
    const saveHandler = createSaveSettingsHandler();
    const saveRes = createJsonResponse();
    saveHandler(
      { userId: 'test-user', body: { dailyThemeEnabled: false, discoveryMode: 'comfort', autoFillBatchSize: 5 } } as never,
      saveRes as never
    );
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body).toEqual({ ok: true });

    const getHandler = createGetSettingsHandler();
    const getRes = createJsonResponse();
    getHandler({ userId: 'test-user' } as never, getRes as never);
    expect(getRes.body).toMatchObject({ dailyThemeEnabled: false, discoveryMode: 'comfort', autoFillBatchSize: 5 });
  });

  it('PUT saves legacy discoveryMode and GET reflects it', () => {
    const saveHandler = createSaveSettingsHandler();
    const saveRes = createJsonResponse();
    saveHandler(
      { userId: 'test-user', body: { discoveryMode: 'legacy' } } as never,
      saveRes as never
    );
    expect(saveRes.statusCode).toBe(200);

    const getHandler = createGetSettingsHandler();
    const getRes = createJsonResponse();
    getHandler({ userId: 'test-user' } as never, getRes as never);
    expect(getRes.body).toMatchObject({ discoveryMode: 'legacy' });
  });

  it('rejects autoFillBatchSize outside the supported range', () => {
    const saveHandler = createSaveSettingsHandler();
    const saveRes = createJsonResponse();

    saveHandler(
      { userId: 'test-user', body: { autoFillBatchSize: 6 } } as never,
      saveRes as never
    );

    expect(saveRes.statusCode).toBe(400);
    expect(saveRes.body).toMatchObject({ ok: false, error: 'invalid body' });
  });

  it('POST tts-preview synthesizes a short preview with the requested voice', async () => {
    process.env.CROSSFADIO_TTS_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    resetConfigForTest();
    const audio = Buffer.from('preview-audio');
    const requestedUrls: string[] = [];
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/services/aigc/multimodal-generation/generation')) {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Response.json({ output: { audio: { url: 'https://audio.example/preview.wav' } } });
      }
      return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }));

    const handler = createPreviewTtsHandler();
    const res = createJsonResponse();

    await handler({ userId: 'test-user', body: { voice: 'Ethan' } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      voice: 'Ethan',
      model: DEFAULT_TTS_MODEL,
      audioUrl: expect.stringMatching(/^\/api\/segue\/audio\/.+\.wav$/)
    });
    expect(capturedBody).toEqual({
      model: DEFAULT_TTS_MODEL,
      input: {
        text: '你好，我是 Crossfadio 的 DJ。让音乐继续流动。',
        voice: 'Ethan',
        language_type: 'Auto'
      }
    });
    expect(requestedUrls).toEqual([
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'https://audio.example/preview.wav'
    ]);
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
      taste: '',
      discoveryMode: 'explore'
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
  it('analyzes every liked song instead of only the first 200', async () => {
    const requestBodies: Array<{
      messages?: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('llm.example')) {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> });
        return new Response(JSON.stringify({
          choices: [{ message: { content: '# 我的音乐口味\n- 喜欢：覆盖全量红心。' } }],
          model: 'test-model'
        }), { status: 200 });
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    }));
    const ids = Array.from({ length: 450 }, (_, index) => String(index + 1));
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(ids),
      getSongDetails: vi.fn(async (batchIds: string[]) =>
        batchIds.map((id) => ({
          id: Number(id),
          name: `Song ${id}`,
          artists: [`Artist ${id}`],
          durationMs: 180_000
        }))
      )
    };

    const taste = await runTasteAnalysis('test-user', ncmClient as never);

    expect(taste).toContain('覆盖全量红心');
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(3);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(1, ids.slice(0, 200));
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(2, ids.slice(200, 400));
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(3, ids.slice(400, 450));
    expect(requestBodies.some((body) =>
      body.messages?.some((message) => message.content.includes('Song 450 - Artist 450'))
    )).toBe(true);
  });

  it('asks the LLM for a richer DJ-oriented taste profile', async () => {
    const requestBodies: Array<{
      max_tokens?: number;
      messages?: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('llm.example')) {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as {
          max_tokens?: number;
          messages?: Array<{ role: string; content: string }>;
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: '# 我的音乐口味\n## 核心画像\n喜欢层次更丰富的歌曲。' } }],
          model: 'test-model'
        }), { status: 200 });
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    }));
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['101', '102']),
      getSongDetails: vi.fn().mockResolvedValue([
        { id: 101, name: 'Song A', artists: ['Artist A'], durationMs: 180_000 },
        { id: 102, name: 'Song B', artists: ['Artist B'], durationMs: 180_000 }
      ])
    };

    await runTasteAnalysis('test-user', ncmClient as never);

    const systemPrompt = requestBodies.at(-1)?.messages?.find((message) => message.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('600-900字');
    expect(systemPrompt).toContain('## 核心画像');
    expect(systemPrompt).toContain('## DJ 选歌提示');
    expect(systemPrompt).toContain('少放');
    expect(systemPrompt).not.toContain('200字以内');
    expect(requestBodies.at(-1)?.max_tokens).toBeGreaterThanOrEqual(1400);
  });

  it('skips liked songs whose details fail when a batch contains malformed NCM data', async () => {
    const requestBodies: Array<{
      messages?: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('llm.example')) {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> });
        return new Response(JSON.stringify({
          choices: [{ message: { content: '# 我的音乐口味\n- 喜欢：跳过坏详情。' } }],
          model: 'test-model'
        }), { status: 200 });
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    }));
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['101', '102', '103']),
      getSongDetails: vi.fn(async (ids: string[]) => {
        if (ids.length > 1) {
          throw Object.assign(new Error('NCM song/detail returned malformed payload'), {
            code: NCM_ERROR_CODE.BAD_RESPONSE
          });
        }
        if (ids[0] === '102') {
          throw Object.assign(new Error('malformed song detail'), {
            code: NCM_ERROR_CODE.BAD_RESPONSE
          });
        }
        return [{
          id: Number(ids[0]),
          name: `Song ${ids[0]}`,
          artists: [`Artist ${ids[0]}`],
          durationMs: 180_000
        }];
      })
    };

    const taste = await runTasteAnalysis('test-user', ncmClient as never);

    expect(taste).toContain('跳过坏详情');
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(1, ['101', '102', '103']);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(2, ['101']);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(3, ['102']);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(4, ['103']);
    const finalPrompt = requestBodies.at(-1)?.messages?.find((message) => message.role === 'user')?.content ?? '';
    expect(finalPrompt).toContain('Song 101 - Artist 101');
    expect(finalPrompt).not.toContain('Song 102');
    expect(finalPrompt).toContain('Song 103 - Artist 103');
  });

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
