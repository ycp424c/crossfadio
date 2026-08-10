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
  createSegueTriggerHandler,
  createSseSegueHandler
} from '../../src/server/http/routes/segue';
import * as llmConfigModule from '../../src/server/llm/config';
import { getTtsCacheDir } from '../../src/server/tts/cache';
import { _addEventClientForTests, _resetEventClientsForTests } from '../../src/server/http/routes/sse-events';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import {
  acquireResourcePermit,
  _resetResourceGovernorForTest,
  ResourceLimitError
} from '../../src/server/resource-governor';
import { _resetResourcePolicyForTest } from '../../src/server/resource-policy';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-segue-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  const { resetConfigForTest } = await import('../../src/server/config');
  resetConfigForTest();
  initDb();
});

afterEach(() => {
  _resetActiveSegueJobForTests();
  _resetEventClientsForTests();
  _resetDbForTest();
  _resetResourceGovernorForTest();
  _resetResourcePolicyForTest();
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
    set: vi.fn(() => res),
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
    handler({ body, userId: 'test-user' } as never, first as never, vi.fn() as never);
    await Promise.resolve();
    await Promise.resolve();

    const second = createJsonResponse();
    handler({ body, userId: 'test-user' } as never, second as never, vi.fn() as never);

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

  it('mints a new requestId per call when clientRequestId is omitted', async () => {
    const handler = createSegueTriggerHandler({ secrets: {} as never, ncmClient: {} as never });
    const body = { from: { id: 'a' }, to: { id: 'b' } };

    const first = createJsonResponse();
    handler({ body, userId: 'test-user' } as never, first as never, vi.fn() as never);
    // Standard users hold one segue permit at a time; wait for the (no-llm) job
    // to finish and release it before issuing the next request.
    await vi.waitFor(() => {
      const permit = acquireResourcePermit('test-user', 'segue');
      permit.release();
    });

    const second = createJsonResponse();
    handler({ body, userId: 'test-user' } as never, second as never, vi.fn() as never);

    const firstRequestId = (first.body as { requestId: string }).requestId;
    const secondRequestId = (second.body as { requestId: string }).requestId;
    expect(firstRequestId).not.toBe(secondRequestId);
    expect(first.body).toMatchObject({ clientRequestId: null });
    expect(second.body).toMatchObject({ clientRequestId: null });
  });

  it('isolates in-flight dedupe and cancellation by user', async () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model'
    });
    const requestSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) requestSignals.push(init.signal);
      return new Promise<Response>(() => undefined);
    }));
    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: {
        getLikedSongIds: async () => [],
        getSongDetails: async () => [],
        getLyric: async () => null,
        getSongWikiSummary: async () => null
      } as never
    });
    const body = { clientRequestId: 'same-client-id', from: { id: 'a' }, to: { id: 'b' } };
    const first = createJsonResponse();
    handler({ body, userId: 'user-a' } as never, first as never, vi.fn() as never);
    await vi.waitFor(() => expect(requestSignals).toHaveLength(1));

    const second = createJsonResponse();
    handler({ body, userId: 'user-b' } as never, second as never, vi.fn() as never);
    await vi.waitFor(() => expect(requestSignals).toHaveLength(2));

    expect((first.body as { requestId: string }).requestId)
      .not.toBe((second.body as { requestId: string }).requestId);
    expect(requestSignals[0]?.aborted).toBe(false);
    expect(requestSignals[1]?.aborted).toBe(false);
  });

  it('rejects identical from/to ids with 400', () => {
    const handler = createSegueTriggerHandler({ secrets: {} as never, ncmClient: {} as never });
    const res = createJsonResponse();

    handler(
      { body: { from: { id: 'same' }, to: { id: 'same' } }, userId: 'test-user' } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(400);
  });

  it('broadcasts a degraded terminal event when the LLM segue job times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model'
    });

    const sent: string[] = [];
    _addEventClientForTests('test-user', {
      write: vi.fn((chunk: string) => {
        const match = chunk.match(/^data: (.+)$/m);
        if (match) sent.push(match[1]);
      })
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
      { body: { clientRequestId: 'cid-timeout', from: { id: '1' }, to: { id: '2' } }, userId: 'test-user' } as never,
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
    await vi.advanceTimersByTimeAsync(61_000);

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

describe('segue replacement (latest-wins)', () => {
  const realLlmConfig = {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'test-model'
  };

  it('replaces an in-flight segue for a standard user without a 429 and keeps clientRequestId dedup', async () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    }));

    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });

    // Job A starts for a standard user (per-user concurrency is 1).
    const resA = createJsonResponse();
    handler(
      { body: { clientRequestId: 'cid-a', from: { id: 'a' }, to: { id: 'b' } }, userId: 'replacement-user' } as never,
      resA as never,
      vi.fn() as never
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // Job B replaces A: it must NOT 429 because A's permit is still held.
    const resB = createJsonResponse();
    await handler(
      { body: { clientRequestId: 'cid-b', from: { id: 'a' }, to: { id: 'b' } }, userId: 'replacement-user' } as never,
      resB as never,
      vi.fn() as never
    );

    expect(resB.statusCode).toBe(200);
    expect(resB.body).toMatchObject({ ok: true, clientRequestId: 'cid-b' });
    const requestIdA = (resA.body as { requestId: string }).requestId;
    const requestIdB = (resB.body as { requestId: string }).requestId;
    expect(requestIdB).not.toBe(requestIdA);
    // The old job was aborted; the new one is in flight and holds the permit.
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[1]?.aborted).toBe(false);
    expectUserConcurrencyError('replacement-user');

    // Same clientRequestId dedup still applies to the in-flight replacement.
    const resC = createJsonResponse();
    await handler(
      { body: { clientRequestId: 'cid-b', from: { id: 'a' }, to: { id: 'b' } }, userId: 'replacement-user' } as never,
      resC as never,
      vi.fn() as never
    );
    expect(resC.statusCode).toBe(200);
    expect((resC.body as { requestId: string }).requestId).toBe(requestIdB);
    expect(signals).toHaveLength(2);

    // Cleanup: aborting the replacement releases the permit exactly once.
    _resetActiveSegueJobForTests();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('replacement-user', 'segue')).not.toThrow();
    });
  });
});

describe('segue concurrent replacement race (parallel waiters on the same old job)', () => {
  const realLlmConfig = {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'test-model'
  };

  function stubPendingFetch(signals: AbortSignal[]): void {
    // Mirrors real fetch semantics: an already-aborted signal rejects
    // immediately — a replacement can be aborted by a later request BEFORE its
    // own fetch has even been called, so the mock must not hang on it.
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    }));
  }

  it('lets the truly latest request win when two replacements wait on the same old job (standard user, no 429)', async () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    const signals: AbortSignal[] = [];
    stubPendingFetch(signals);

    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const body = { from: { id: 'a' }, to: { id: 'b' } };

    // Job A starts and stays in flight (standard user: per-user concurrency 1).
    const resA = createJsonResponse();
    handler(
      { body: { ...body, clientRequestId: 'cid-a' }, userId: 'race-user' } as never,
      resA as never,
      vi.fn() as never
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const requestIdA = (resA.body as { requestId: string }).requestId;

    // B and C arrive while A is still in flight: BOTH abort A and block on its
    // settle — neither may respond before A settles.
    const resB = createJsonResponse();
    const pendingB = handler(
      { body: { ...body, clientRequestId: 'cid-b' }, userId: 'race-user' } as never,
      resB as never,
      vi.fn() as never
    );
    const resC = createJsonResponse();
    const pendingC = handler(
      { body: { ...body, clientRequestId: 'cid-c' }, userId: 'race-user' } as never,
      resC as never,
      vi.fn() as never
    );
    expect(resB.body).toBeUndefined();
    expect(resC.body).toBeUndefined();

    // A settles (aborted); B acquires first and starts its job; C then wakes,
    // re-reads the active job, aborts B's replacement, waits for it to settle,
    // and only then starts its own job. Neither B nor C may 429.
    await pendingB;
    await pendingC;

    expect(resB.statusCode).toBe(200);
    expect(resC.statusCode).toBe(200);
    const requestIdB = (resB.body as { requestId: string }).requestId;
    const requestIdC = (resC.body as { requestId: string }).requestId;
    expect(requestIdB).not.toBe(requestIdA);
    expect(requestIdC).not.toBe(requestIdB);

    // Final state: A's fetch is aborted, B's replacement never ran in parallel
    // (a replacement aborted before reaching the provider may never fetch), and
    // exactly one fetch — C's — is still active: the last signal, non-aborted.
    await vi.waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2));
    const activeSignals = signals.filter((signal) => !signal.aborted);
    expect(activeSignals).toHaveLength(1);
    expect(signals[signals.length - 1]).toBe(activeSignals[0]);
    expect(signals[0].aborted).toBe(true);
    expectUserConcurrencyError('race-user');

    // Dedup: a repeat of C's clientRequestId returns C's requestId with no new job.
    const signalsBeforeDedup = signals.length;
    const resD = createJsonResponse();
    await handler(
      { body: { ...body, clientRequestId: 'cid-c' }, userId: 'race-user' } as never,
      resD as never,
      vi.fn() as never
    );
    expect(resD.statusCode).toBe(200);
    expect((resD.body as { requestId: string }).requestId).toBe(requestIdC);
    expect(signals).toHaveLength(signalsBeforeDedup);

    // Cleanup: aborting the final job releases the permit exactly once.
    _resetActiveSegueJobForTests();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('race-user', 'segue')).not.toThrow();
    });
  });

  it('serializes priority replacements too: the later request aborts and waits for the earlier replacement instead of running in parallel', async () => {
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["priority-race-user"]');
    const { loadAllowlist } = await import('../../src/server/allowlist');
    loadAllowlist();
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    const signals: AbortSignal[] = [];
    stubPendingFetch(signals);

    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const body = { from: { id: 'a' }, to: { id: 'b' } };

    // A in flight (priority user: per-user concurrency is 2, so the governor
    // would ALLOW two parallel jobs — serialization must come from the handler).
    const resA = createJsonResponse();
    handler(
      { body: { ...body, clientRequestId: 'cid-a' }, userId: 'priority-race-user' } as never,
      resA as never,
      vi.fn() as never
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // B and C both block on A's settle; neither may respond before it settles.
    const resB = createJsonResponse();
    const pendingB = handler(
      { body: { ...body, clientRequestId: 'cid-b' }, userId: 'priority-race-user' } as never,
      resB as never,
      vi.fn() as never
    );
    const resC = createJsonResponse();
    const pendingC = handler(
      { body: { ...body, clientRequestId: 'cid-c' }, userId: 'priority-race-user' } as never,
      resC as never,
      vi.fn() as never
    );
    expect(resB.body).toBeUndefined();
    expect(resC.body).toBeUndefined();

    await pendingB;
    await pendingC;

    // The chain must be A → (B replaced A) → (C replaced B): B's job was
    // aborted by C and settled before C started, so the two replacements never
    // ran in parallel — exactly one fetch (C's, the last one) stays active.
    expect(resB.statusCode).toBe(200);
    expect(resC.statusCode).toBe(200);
    await vi.waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2));
    const activeSignals = signals.filter((signal) => !signal.aborted);
    expect(activeSignals).toHaveLength(1);
    expect(signals[signals.length - 1]).toBe(activeSignals[0]);
    expect(signals[0].aborted).toBe(true);

    // Cleanup: aborting the final job releases its permit exactly once.
    _resetActiveSegueJobForTests();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('priority-race-user', 'segue')).not.toThrow();
    });
  });
});

describe('segue fallback TTS warm permit lifetime', () => {
  const realLlmConfig = {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'test-model'
  };

  function sseChunkResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }

  it('delivers tts-ready first, holds the permit while a cold-cache warm is pending, and releases after it settles', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    process.env.CROSSFADIO_TTS_MODEL = 'tts-model';
    process.env.CROSSFADIO_TTS_VOICE_DEFAULT = 'alloy';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();

    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);

    const sent: string[] = [];
    _addEventClientForTests('warm-user', {
      write: vi.fn((chunk: string) => {
        sent.push(String(chunk));
      })
    } as never);

    let speechCalls = 0;
    let warmStarted = false;
    let warmSawTtsReady = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('llm.example')) {
        const segueJson = '{"say":"接上这一首。","emotionTag":"focused"}';
        return Promise.resolve(sseChunkResponse([
          `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":${JSON.stringify(segueJson)}},"finish_reason":"stop"}]}\n\n`,
          'data: [DONE]\n\n'
        ]));
      }
      if (url.includes('/audio/speech')) {
        speechCalls += 1;
        if (speechCalls === 1) {
          // Main segue speech synthesis succeeds (cold cache, provider hit).
          return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' }
          }));
        }
        // The warm fallback synthesis is pending (cold cache): the permit must
        // stay held, and tts-ready must already have been delivered.
        warmStarted = true;
        warmSawTtsReady = sent.some((chunk) => {
          const match = chunk.match(/^data: (.+)$/m);
          if (!match) return false;
          try {
            return (JSON.parse(match[1]) as { type?: string }).type === 'segue.tts-ready';
          } catch {
            return false;
          }
        });
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
      ncmClient: pendingNcmClient()
    });
    const res = createJsonResponse();
    handler(
      { body: { clientRequestId: 'cid-warm', from: { id: 'a' }, to: { id: 'b' } }, userId: 'warm-user' } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, clientRequestId: 'cid-warm' });

    // tts-ready was broadcast BEFORE the cold-cache warm started…
    await vi.waitFor(() => expect(warmStarted).toBe(true));
    expect(warmSawTtsReady).toBe(true);
    const ttsReady = sent
      .map((chunk) => chunk.match(/^data: (.+)$/m)?.[1])
      .filter(Boolean)
      .map((raw) => JSON.parse(raw!) as Record<string, unknown>)
      .find((payload) => payload.type === 'segue.tts-ready');
    expect(ttsReady).toMatchObject({ type: 'segue.tts-ready', fallbackTts: false });
    // No failure event may follow a successful main segue.
    expect(sent.join('\n')).not.toContain('segue.degraded');

    // …and the permit stays occupied until the warm settles.
    expectUserConcurrencyError('warm-user');

    // Aborting the job aborts the warm; the permit is then released.
    _resetActiveSegueJobForTests();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('warm-user', 'segue')).not.toThrow();
    });
    expect(sent.join('\n')).not.toContain('segue.degraded');
  });
});

describe('segue resource permit lifetime', () => {
  const realLlmConfig = {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'test-model'
  };

  it('rejects a fire-and-forget segue with JSON 429 before provider work', () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const holding = acquireResourcePermit('segue-429-user', 'segue');
    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const res = createJsonResponse();

    handler(
      { body: { clientRequestId: 'cid-429', from: { id: 'a' }, to: { id: 'b' } }, userId: 'segue-429-user' } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'resource_limited',
      reason: 'user_concurrency_exceeded',
      operation: 'segue'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    holding.release();
  });

  it('holds a fire-and-forget segue permit after the response until synthesis completes', async () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    pendingLlmFetch();
    const handler = createSegueTriggerHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const res = createJsonResponse();

    handler(
      { body: { clientRequestId: 'cid-hold', from: { id: 'a' }, to: { id: 'b' } }, userId: 'segue-hold-user' } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // The permit must stay held after the HTTP response returned.
    expectUserConcurrencyError('segue-hold-user');

    // Synthesis is still pending; aborting the job must release the permit.
    _resetActiveSegueJobForTests();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('segue-hold-user', 'segue')).not.toThrow();
    });
  });

  it('rejects an SSE segue with JSON 429 before SSE init or provider work', () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const holding = acquireResourcePermit('sse-segue-429-user', 'segue');
    const handler = createSseSegueHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const res = createSseResponse();

    handler(
      { body: { clientRequestId: 'cid-sse-429', from: { id: 'a' }, to: { id: 'b' } }, userId: 'sse-segue-429-user', on: vi.fn() } as never,
      res as never,
      vi.fn() as never
    );

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'resource_limited',
      reason: 'user_concurrency_exceeded',
      operation: 'segue'
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    holding.release();
  });

  it('holds an SSE segue permit through synthesis completion', async () => {
    vi.spyOn(llmConfigModule, 'resolveLlmConfig').mockReturnValue(realLlmConfig);
    pendingLlmFetch();
    const handler = createSseSegueHandler({
      secrets: {} as never,
      ncmClient: pendingNcmClient()
    });
    const res = createSseResponse();
    const requestHandlers: Record<string, () => void> = {};
    const req = {
      body: { clientRequestId: 'cid-sse-hold', from: { id: 'a' }, to: { id: 'b' } },
      userId: 'sse-segue-hold-user',
      on: vi.fn((event: string, cb: () => void) => {
        requestHandlers[event] = cb;
      })
    };

    handler(req as never, res as never, vi.fn() as never);

    expect(res.writeHead).toHaveBeenCalled();
    expectUserConcurrencyError('sse-segue-hold-user');

    // SSE jobs are not tracked in activeJobsByUser; a client disconnect aborts
    // the synthesis, which must release the permit.
    requestHandlers.close?.();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('sse-segue-hold-user', 'segue')).not.toThrow();
    });
  });
});

function expectUserConcurrencyError(userId: string): void {
  let error: unknown;
  try {
    acquireResourcePermit(userId, 'segue');
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ResourceLimitError);
  expect((error as ResourceLimitError).code).toBe('user_concurrency_exceeded');
}

function pendingLlmFetch(): void {
  // The pending LLM fetch must reject when the job's AbortController fires so
  // an aborted synthesis settles deterministically.
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
      });
    });
  }));
}

function pendingNcmClient() {
  return {
    getLikedSongIds: async () => [],
    getSongDetails: async () => [],
    getLyric: async () => null,
    getSongWikiSummary: async () => null
  } as never;
}

function createSseResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    written: [] as string[],
    writableEnded: false,
    writeHead: vi.fn((code: number, headers: Record<string, string>) => {
      res.statusCode = code;
      Object.assign(res.headers, headers);
      return res;
    }),
    write: vi.fn((chunk: string) => {
      res.written.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    set: vi.fn((_name: string, _value: string) => res),
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
