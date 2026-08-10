import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrackDedupeKey,
  createDjPickNextHandler,
  createSseDjPickNextHandler,
  searchCandidates,
  serializeDjPickNextErrorForLog
} from '../../src/server/http/routes/djNext';
import { parseDiscoveryMode } from '../../src/shared/dj';
import { initDb, _resetDbForTest, getDb } from '../../src/server/store/db';
import { runDjPickNext, getAutoFillBatchSize } from '../../src/server/dj/pickNextRun';
import { setPref } from '../../src/server/store/prefs';
import {
  acquireResourcePermit,
  _resetResourceGovernorForTest,
  ResourceLimitError
} from '../../src/server/resource-governor';
import { _resetResourcePolicyForTest } from '../../src/server/resource-policy';
import { createDjPickNextRunner } from '../../src/server/dj/pickNextRunner';
import {
  _addEventClientForTests,
  _resetEventClientsForTests
} from '../../src/server/http/routes/sse-events';

vi.mock('../../src/server/dj/pickNextRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/dj/pickNextRun')>();
  return { ...actual, runDjPickNext: vi.fn() };
});

const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-next-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  _resetResourcePolicyForTest();
  _resetResourceGovernorForTest();
  initDb();
  vi.mocked(runDjPickNext).mockReset();
});

afterEach(() => {
  _resetDbForTest();
  _resetResourceGovernorForTest();
  _resetResourcePolicyForTest();
  _resetEventClientsForTests();
  process.env = { ...originalEnv };
});

describe('DJ v2 route contract', () => {
  it('keeps only explore and comfort discovery modes', () => {
    expect(parseDiscoveryMode('explore')).toBe('explore');
    expect(parseDiscoveryMode('comfort')).toBe('comfort');
    expect(parseDiscoveryMode('legacy')).toBe('explore');
  });

  it('searches candidates without selecting or mutating a queue', async () => {
    const searchSongs = vi.fn(async () => [
      { id: 1, name: 'Song A', artists: ['Artist A'] },
      { id: 2, name: 'Song B', artists: ['Artist B'] }
    ]);
    const candidates = await searchCandidates(
      ['city pop'],
      { searchSongs } as never,
      new Set(['1']),
      10
    );

    expect(candidates).toEqual([{ id: '2', name: 'Song B', artist: 'Artist B' }]);
    expect(searchSongs).toHaveBeenCalledWith('city pop', 10);
  });

  it('uses stable title and primary-artist dedupe keys', () => {
    expect(buildTrackDedupeKey({ name: '  Plastic Love ', artists: ['竹内まりや', 'Guest'] }))
      .toBe(buildTrackDedupeKey({ name: 'plastic love', artist: '竹内まりや' }));
  });

  it('serializes only stable operational fields and drops provider bodies', () => {
    const error = Object.assign(new Error('response body: PRIVATE PROMPT'), {
      status: 502,
      responseBody: '{"echo":"PRIVATE PDC"}',
      requestId: 'req-safe-42'
    });
    expect(serializeDjPickNextErrorForLog(error)).toEqual({
      code: 'provider_server_error',
      status: 502,
      requestId: 'req-safe-42'
    });
    expect(JSON.stringify(serializeDjPickNextErrorForLog(error))).not.toContain('PRIVATE');
  });

  it('rejects a queue-carrying pick-next request without an expected revision', () => {
    const handler = createDjPickNextHandler({
      secrets: {},
      ncmClient: {} as never
    });
    const response = createJsonResponse();

    handler({
      body: { queue: [{ id: 'stale' }], currentIndex: 0 },
      userId: 'revision-user'
    } as never, response as never, vi.fn());

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('rejects an oversized queue snapshot before starting pick-next', () => {
    const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const response = createJsonResponse();

    handler({
      body: {
        queue: Array.from({ length: 101 }, (_, index) => ({ id: `track-${index}` })),
        currentIndex: 0,
        revision: 0
      },
      userId: 'bounded-queue-user'
    } as never, response as never, vi.fn());

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('contains no removed selection route markers in production orchestration', () => {
    const source = fs.readFileSync(
      new URL('../../src/server/dj/pickNextRun.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/legacy_(?:llm_success|random_fallback)|music_agent_legacy_fallback/);
    expect(source).not.toContain("discoveryMode === 'legacy'");
  });
});

function expectUserConcurrencyError(userId: string, operation: string): void {
  let error: unknown;
  try {
    acquireResourcePermit(userId, operation as never);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ResourceLimitError);
  expect((error as ResourceLimitError).code).toBe('user_concurrency_exceeded');
}

describe('pick-next resource permit lifetime', () => {
  it('rejects fire-and-forget pick-next with JSON 429 before the runner starts', () => {
    const holding = acquireResourcePermit('pick-429-user', 'dj_pick_next');
    const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createJsonResponse();

    handler({ body: {}, userId: 'pick-429-user' } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'resource_limited',
      reason: 'user_concurrency_exceeded',
      operation: 'dj_pick_next'
    });
    expect(vi.mocked(runDjPickNext)).not.toHaveBeenCalled();
    holding.release();
  });

  it('holds a fire-and-forget pick-next permit after the HTTP response and releases on job completion', async () => {
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    vi.mocked(runDjPickNext).mockImplementation(async () => {
      await gate;
    });

    const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createJsonResponse();

    handler({ body: {}, userId: 'pick-next-user' } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, running: false });

    // The permit must still be held after the HTTP response returned.
    expectUserConcurrencyError('pick-next-user', 'dj_pick_next');

    finishJob();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('pick-next-user', 'dj_pick_next')).not.toThrow();
    });
  });

  it('rejects SSE pick-next with JSON 429 before SSE init or runner start', () => {
    const holding = acquireResourcePermit('sse-pick-429-user', 'dj_pick_next');
    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();

    handler({ body: {}, userId: 'sse-pick-429-user', on: vi.fn() } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'resource_limited',
      reason: 'user_concurrency_exceeded',
      operation: 'dj_pick_next'
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(vi.mocked(runDjPickNext)).not.toHaveBeenCalled();
    holding.release();
  });

  it('holds an SSE pick-next permit through runner completion', async () => {
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    vi.mocked(runDjPickNext).mockImplementation(async () => {
      await gate;
    });

    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();

    handler({ body: {}, userId: 'sse-pick-next-user', on: vi.fn() } as never, res as never, vi.fn() as never);

    expect(res.writeHead).toHaveBeenCalled();
    expectUserConcurrencyError('sse-pick-next-user', 'dj_pick_next');

    finishJob();
    await vi.waitFor(() => {
      expect(() => acquireResourcePermit('sse-pick-next-user', 'dj_pick_next')).not.toThrow();
    });
  });
});

describe('SSE pick-next validation order', () => {
  it('rejects an invalid SSE pick-next body with plain JSON 400 without charging credits or starting the runner', () => {
    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();

    handler({
      body: { queue: [{ id: 'x' }], currentIndex: 0 },
      userId: 'invalid-sse-user',
      on: vi.fn()
    } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid body' });
    // The rejection must stay an ordinary JSON response — no SSE headers.
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(vi.mocked(runDjPickNext)).not.toHaveBeenCalled();
    // No daily credits may be charged for a malformed request.
    const row = getDb()
      .prepare('SELECT credits_used FROM resource_usage_buckets WHERE user_id = ?')
      .get('invalid-sse-user');
    expect(row).toBeUndefined();
  });

  it('rejects a stale SSE pick-next queue revision with plain JSON 409 without charging credits or starting the runner', () => {
    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();

    handler({
      body: { queue: [{ id: 'x' }], currentIndex: 0, revision: 1 },
      userId: 'stale-sse-user',
      on: vi.fn()
    } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'queue_revision_conflict' });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(vi.mocked(runDjPickNext)).not.toHaveBeenCalled();
    const row = getDb()
      .prepare('SELECT credits_used FROM resource_usage_buckets WHERE user_id = ?')
      .get('stale-sse-user');
    expect(row).toBeUndefined();
  });

  it('broadcasts the authoritative queue-updated payload to persistent SSE clients before returning the JSON 409', () => {
    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();
    const sent: string[] = [];
    _addEventClientForTests('stale-broadcast-user', {
      write: vi.fn((chunk: string) => {
        sent.push(String(chunk));
      })
    } as never);

    handler({
      body: { queue: [{ id: 'x' }], currentIndex: 0, revision: 1 },
      userId: 'stale-broadcast-user',
      on: vi.fn()
    } as never, res as never, vi.fn() as never);

    // The stale-queue rejection stays an ordinary JSON 409…
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'queue_revision_conflict' });
    // …with no SSE response headers, no credits charged, and no provider work.
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(vi.mocked(runDjPickNext)).not.toHaveBeenCalled();
    const row = getDb()
      .prepare('SELECT credits_used FROM resource_usage_buckets WHERE user_id = ?')
      .get('stale-broadcast-user');
    expect(row).toBeUndefined();
    // …while the persistent event client receives the authoritative
    // queue-updated event (server-side snapshot: empty queue, revision 0) so
    // the player can re-sync and retry automatically.
    const events = sent
      .map((chunk) => chunk.match(/^data: (.+)$/m)?.[1])
      .filter(Boolean)
      .map((raw) => JSON.parse(raw!));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'queue-updated', queue: [], currentIndex: 0, revision: 0 });
  });
});

describe('pick-next runner timeout semantics', () => {
  it('notifies the client on timeout immediately but keeps the running lock until the underlying job settles', async () => {
    vi.useFakeTimers();
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    // The underlying job ignores the abort signal entirely.
    const runPickNext = vi.fn(async () => {
      await gate;
    });
    const onTimeout = vi.fn();
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 1_000,
      runPickNext,
      onTimeout
    });

    const resultPromise = runner.run({ userId: 'runner-user', ncmClient: {} as never });
    await vi.advanceTimersByTimeAsync(1_000);

    // The client was notified at the timeout instant…
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // …but the lock must NOT be released while the job is still settling.
    expect(runner.isRunning('runner-user')).toBe(true);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // The job eventually settles: now the runner resolves and the lock frees.
    finishJob();
    await vi.advanceTimersByTimeAsync(0);
    await expect(resultPromise).resolves.toEqual({ status: 'timeout' });
    expect(runner.isRunning('runner-user')).toBe(false);
    expect(runPickNext).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ends the SSE response promptly on timeout but keeps the permit until the underlying job settles', async () => {
    vi.useFakeTimers();
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    vi.mocked(runDjPickNext).mockImplementation(async () => {
      await gate;
    });

    const handler = createSseDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createSseResponse();

    handler({ body: {}, userId: 'sse-timeout-user', on: vi.fn() } as never, res as never, vi.fn() as never);

    expect(res.writeHead).toHaveBeenCalled();

    // Let the real job timeout elapse; the mocked job ignores the abort.
    await vi.advanceTimersByTimeAsync(180_000);

    // The SSE response ended promptly (the client is notified right away)…
    expect(res.writableEnded).toBe(true);
    expect(res.written.join('\n')).toContain('"reason":"timeout"');
    // …but the permit is still held until the underlying job settles.
    expectUserConcurrencyError('sse-timeout-user', 'dj_pick_next');

    finishJob();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(() => acquireResourcePermit('sse-timeout-user', 'dj_pick_next')).not.toThrow();
    vi.useRealTimers();
  });

  it('broadcasts the timeout event promptly for fire-and-forget while the permit stays held until the job settles', async () => {
    vi.useFakeTimers();
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    vi.mocked(runDjPickNext).mockImplementation(async () => {
      await gate;
    });
    const sent: string[] = [];
    _addEventClientForTests('ff-timeout-user', {
      write: vi.fn((chunk: string) => {
        sent.push(String(chunk));
      })
    } as never);

    const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const res = createJsonResponse();

    handler({ body: {}, userId: 'ff-timeout-user' } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, running: false });

    await vi.advanceTimersByTimeAsync(180_000);

    // The timeout broadcast reached the user…
    expect(sent.join('\n')).toContain('"reason":"timeout"');
    // …but the permit is still held until the underlying job settles.
    expectUserConcurrencyError('ff-timeout-user', 'dj_pick_next');

    finishJob();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(() => acquireResourcePermit('ff-timeout-user', 'dj_pick_next')).not.toThrow();
    vi.useRealTimers();
  });

  it('releases the permit only after the job settles even when the timeout notification throws', async () => {
    vi.useFakeTimers();
    let finishJob!: () => void;
    vi.mocked(runDjPickNext).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishJob = resolve;
      });
    });

    // The fire-and-forget route's onTimeout notifies via broadcastToUser; make
    // that notification throw so the runner must isolate it as best-effort.
    const broadcastModule = await import('../../src/server/http/broadcast');
    const broadcastSpy = vi.spyOn(broadcastModule, 'broadcastToUser').mockImplementation(() => {
      throw new Error('broadcast failed');
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
      const res = createJsonResponse();
      handler({ body: {}, userId: 'ff-throw-notify-user' } as never, res as never, vi.fn() as never);
      expect(res.statusCode).toBe(200);

      // The timeout fires and the notification throws: the permit must NOT be
      // released early while the underlying job is still settling.
      await vi.advanceTimersByTimeAsync(180_000);
      expectUserConcurrencyError('ff-throw-notify-user', 'dj_pick_next');

      // The job settles: only now is the permit released, and no unhandled
      // rejection may leak from the throwing notification path.
      finishJob();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(() => acquireResourcePermit('ff-throw-notify-user', 'dj_pick_next')).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      broadcastSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('standard-tier auto-fill batch size cap', () => {  it('clamps the effective auto-fill batch size to 2 for standard users', () => {
    setPref('standard-user', 'dj.autoFillBatchSize', 5);

    expect(getAutoFillBatchSize('standard-user')).toBe(2);
  });

  it('keeps the stored auto-fill batch size for priority users', async () => {
    const { loadAllowlist } = await import('../../src/server/allowlist');
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["priority-user"]');
    loadAllowlist();
    setPref('priority-user', 'dj.autoFillBatchSize', 4);

    expect(getAutoFillBatchSize('priority-user')).toBe(4);
  });
});

function createJsonResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    set: vi.fn(() => response),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    })
  };
  return response;
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
