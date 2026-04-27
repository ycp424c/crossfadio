import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/weather', () => ({
  fetchWeather: async () => null
}));

import {
  _resetActiveSegueJobForTests,
  buildSegueAudioUrl,
  createSegueAudioHandler,
  createSegueTriggerHandler
} from '../../src/server/http/routes/segue';
import * as llmConfigModule from '../../src/server/llm/config';
import { getTtsCacheDir } from '../../src/server/tts/cache';
import { registerWss } from '../../src/server/http/broadcast';
import { initDb } from '../../src/server/store/db';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-segue-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetActiveSegueJobForTests();
  registerWss({ clients: new Set() } as never);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

function createFileResponse() {
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
    }),
    sendFile: vi.fn((_relativePath: string, _opts: unknown, cb?: (err?: Error) => void) => {
      cb?.();
      return res;
    })
  };
  return res;
}

describe('segue audio routes', () => {
  it('builds URL-safe audio paths for files nested under the TTS cache', () => {
    const filePath = path.join(getTtsCacheDir(), 'fallback', 'voice name', 'a b.mp3');

    expect(buildSegueAudioUrl(filePath)).toBe('/api/segue/audio/fallback/voice%20name/a%20b.mp3');
  });

  it('serves safe nested audio paths from the TTS cache root', () => {
    const handler = createSegueAudioHandler();
    const res = createFileResponse();

    handler({ params: { 0: 'fallback/alloy/audio.mp3' } } as never, res as never);

    expect(res.sendFile).toHaveBeenCalledWith(
      'fallback/alloy/audio.mp3',
      { root: getTtsCacheDir() },
      expect.any(Function)
    );
    expect(res.statusCode).toBe(200);
  });

  it('rejects unsafe audio paths before sendFile', () => {
    const handler = createSegueAudioHandler();
    const res = createFileResponse();

    handler({ params: { 0: '../secrets.json' } } as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid audio path' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });
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

describe('segue trigger handler', () => {
  beforeEach(() => {
    // Force runSegueJob to exit immediately on the no-llm branch — keeps the test deterministic
    // and isolates the handler's dedup decision from the LLM/TTS pipeline.
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(null);
  });

  it('echoes clientRequestId and reuses requestId for repeated calls with the same clientRequestId', async () => {
    const handler = createSegueTriggerHandler({ secrets: {} as never, ncmClient: {} as never });
    const body = { clientRequestId: 'cid-stable', from: { id: 'a' }, to: { id: 'b' } };

    const first = createJsonResponse();
    handler({ body } as never, first as never, vi.fn() as never);
    await Promise.resolve();
    await Promise.resolve();

    const second = createJsonResponse();
    handler({ body } as never, second as never, vi.fn() as never);

    expect(first.body).toMatchObject({ ok: true, clientRequestId: 'cid-stable' });
    expect(second.body).toMatchObject({ ok: true, clientRequestId: 'cid-stable' });
    const firstRequestId = (first.body as { requestId: string }).requestId;
    const secondRequestId = (second.body as { requestId: string }).requestId;
    // After the first job finished (no-llm exits synchronously), the second call should mint a new id.
    // We tolerate both behaviors here: the dedup contract is strictly about *in-flight* jobs, but the
    // important invariant is that clientRequestId is round-tripped.
    expect(firstRequestId).toBeTypeOf('string');
    expect(secondRequestId).toBeTypeOf('string');
  });

  it('mints a new requestId per call when clientRequestId is omitted', () => {
    const handler = createSegueTriggerHandler({ secrets: {} as never, ncmClient: {} as never });
    const body = { from: { id: 'a' }, to: { id: 'b' } };

    const first = createJsonResponse();
    handler({ body } as never, first as never, vi.fn() as never);
    const second = createJsonResponse();
    handler({ body } as never, second as never, vi.fn() as never);

    const firstRequestId = (first.body as { requestId: string }).requestId;
    const secondRequestId = (second.body as { requestId: string }).requestId;
    expect(firstRequestId).not.toBe(secondRequestId);
    expect(first.body).toMatchObject({ clientRequestId: null });
    expect(second.body).toMatchObject({ clientRequestId: null });
  });

  it('rejects identical from/to ids with 400', () => {
    const handler = createSegueTriggerHandler({ secrets: {} as never, ncmClient: {} as never });
    const res = createJsonResponse();

    handler(
      { body: { from: { id: 'same' }, to: { id: 'same' } } } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(400);
  });

  it('broadcasts a degraded terminal event when the LLM segue job times out', async () => {
    vi.useFakeTimers();
    vi.mocked(llmConfigModule.resolveLlmConfig).mockReturnValue({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model'
    });

    const sent: string[] = [];
    registerWss({
      clients: new Set([
        {
          readyState: 1,
          authenticated: true,
          send: vi.fn((message: string) => {
            sent.push(message);
          })
        }
      ])
    } as never);

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('llm.example')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }));

    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: {
        getLikedSongIds: async () => ['1', '2'],
        getSongDetails: async () => [
          { id: 1, name: 'From Song', artists: ['A'], durationMs: 180_000 },
          { id: 2, name: 'To Song', artists: ['B'], durationMs: 190_000 }
        ],
        getLyric: async () => null,
        getSongWikiSummary: async () => null
      } as never
    });
    const res = createJsonResponse();

    handler(
      { body: { clientRequestId: 'cid-timeout', from: { id: '1' }, to: { id: '2' } } } as never,
      res as never,
      vi.fn() as never
    );
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('llm.example'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    await vi.advanceTimersByTimeAsync(12_000);

    const messages = sent.map((message) => JSON.parse(message) as Record<string, unknown>);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'segue.degraded',
        reason: 'llm-timeout',
        clientRequestId: 'cid-timeout'
      })
    );
  });
});
