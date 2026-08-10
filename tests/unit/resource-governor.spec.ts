import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { getDailyCreditsUsage } from '../../src/server/store/resource-usage';
import { loadAllowlist } from '../../src/server/allowlist';
import {
  acquireResourcePermit,
  _resetResourceGovernorForTest,
  ResourceLimitError
} from '../../src/server/resource-governor';
import { _resetResourcePolicyForTest } from '../../src/server/resource-policy';
import { sendResourceLimitResponse } from '../../src/server/http/resource-limit-response';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-resource-governor-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  _resetResourcePolicyForTest();
  _resetResourceGovernorForTest();
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  _resetResourceGovernorForTest();
  _resetResourcePolicyForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  process.env = { ...originalEnv };
});

function makePriority(...ids: string[]): void {
  fs.writeFileSync(path.join(dataDir, 'allowlist.json'), JSON.stringify(ids));
  loadAllowlist();
}

function expectLimitError(
  code: 'daily_quota_exceeded' | 'user_concurrency_exceeded' | 'standard_capacity_exceeded' | 'global_capacity_exceeded',
  operation: string,
  fn: () => unknown
): ResourceLimitError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ResourceLimitError);
  const limitError = thrown as ResourceLimitError;
  expect(limitError.code).toBe(code);
  expect(limitError.operation).toBe(operation);
  expect(limitError.retryAfterSeconds).toBeGreaterThan(0);
  return limitError;
}

describe('acquireResourcePermit concurrency', () => {
  it('limits each standard user to one concurrent permit', () => {
    const first = acquireResourcePermit('std-user', 'chat');

    expect(first.tier).toBe('standard');
    expectLimitError('user_concurrency_exceeded', 'chat', () => {
      acquireResourcePermit('std-user', 'chat');
    });

    first.release();
    expect(acquireResourcePermit('std-user', 'chat').tier).toBe('standard');
  });

  it('allows a priority user to hold two concurrent permits', () => {
    makePriority('pri-user');

    const first = acquireResourcePermit('pri-user', 'chat');
    const second = acquireResourcePermit('pri-user', 'chat');

    expect(first.tier).toBe('priority');
    expect(second.tier).toBe('priority');
    expectLimitError('user_concurrency_exceeded', 'chat', () => {
      acquireResourcePermit('pri-user', 'chat');
    });
  });

  it('caps total standard occupancy at the standard global limit', () => {
    acquireResourcePermit('std-a', 'chat');
    acquireResourcePermit('std-b', 'chat');

    expectLimitError('standard_capacity_exceeded', 'chat', () => {
      acquireResourcePermit('std-c', 'chat');
    });
  });

  it('lets priority users take the remaining slots while standard capacity is saturated', () => {
    makePriority('pri-a', 'pri-b');
    acquireResourcePermit('std-a', 'chat');
    acquireResourcePermit('std-b', 'chat');

    const priorityFirst = acquireResourcePermit('pri-a', 'chat');
    const prioritySecond = acquireResourcePermit('pri-a', 'chat');

    expect(priorityFirst.tier).toBe('priority');
    expect(prioritySecond.tier).toBe('priority');
    expectLimitError('global_capacity_exceeded', 'chat', () => {
      acquireResourcePermit('pri-b', 'chat');
    });
  });

  it('rejects every tier once all four slots are occupied', () => {
    makePriority('pri-a', 'pri-b', 'pri-c');
    acquireResourcePermit('std-a', 'chat');
    acquireResourcePermit('pri-a', 'chat');
    acquireResourcePermit('pri-a', 'chat');
    acquireResourcePermit('pri-b', 'chat');

    expectLimitError('global_capacity_exceeded', 'chat', () => {
      acquireResourcePermit('std-b', 'chat');
    });
    expectLimitError('global_capacity_exceeded', 'chat', () => {
      acquireResourcePermit('pri-c', 'chat');
    });
  });

  it('releases idempotently', () => {
    const permit = acquireResourcePermit('std-user', 'chat');
    permit.release();
    permit.release();
    permit.release();

    const next = acquireResourcePermit('std-user', 'chat');
    expect(next.creditsRemaining).toBeGreaterThanOrEqual(0);
  });
});

describe('acquireResourcePermit credits', () => {
  const now = new Date('2026-08-10T08:00:00.000Z'); // 2026-08-10 16:00 Shanghai

  it('rolls back concurrency counters when the daily quota rejects the reservation', () => {
    process.env.CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS = '40';
    _resetResourcePolicyForTest();

    const first = acquireResourcePermit('std-a', 'taste_analysis', now);
    expect(first).toMatchObject({ tier: 'standard', creditsUsed: 40, creditsRemaining: 0 });
    first.release();

    expectLimitError('daily_quota_exceeded', 'taste_analysis', () => {
      acquireResourcePermit('std-a', 'taste_analysis', now);
    });

    // The rejected reservation charged nothing…
    expect(getDailyCreditsUsage('std-a', '2026-08-10')).toBe(40);
    // …and rolled back the standard-global and total counters: another
    // standard user can still take a slot.
    const stdB = acquireResourcePermit('std-b', 'chat', now);
    expect(stdB.operation).toBe('chat');
    // The failed user's permit count rolled back too: a fresh Shanghai-day
    // bucket is acquirable without a concurrency error.
    const dayTwo = new Date('2026-08-10T16:00:00.000Z');
    const stdA = acquireResourcePermit('std-a', 'chat', dayTwo);
    expect(stdA.operation).toBe('chat');
  });

  it('does not charge credits when concurrency is rejected', () => {
    const first = acquireResourcePermit('std-user', 'chat', now);
    expect(first.creditsUsed).toBe(4);

    expectLimitError('user_concurrency_exceeded', 'chat', () => {
      acquireResourcePermit('std-user', 'chat', now);
    });

    expect(getDailyCreditsUsage('std-user', '2026-08-10')).toBe(4);
  });

  it('charges against a fresh bucket on a different Shanghai calendar day', () => {
    const dayOne = new Date('2026-08-10T08:00:00.000Z'); // 2026-08-10 in Shanghai
    const dayTwo = new Date('2026-08-10T16:00:00.000Z'); // 2026-08-11 in Shanghai

    const first = acquireResourcePermit('std-user', 'taste_analysis', dayOne);
    expect(first).toMatchObject({ creditsUsed: 40, creditsRemaining: 160 });
    first.release();

    const second = acquireResourcePermit('std-user', 'taste_analysis', dayTwo);
    expect(second).toMatchObject({ creditsUsed: 40, creditsRemaining: 160 });
    expect(getDailyCreditsUsage('std-user', '2026-08-10')).toBe(40);
    expect(getDailyCreditsUsage('std-user', '2026-08-11')).toBe(40);
  });

  it('returns tier, operation and remaining credits on the permit', () => {
    const permit = acquireResourcePermit('std-user', 'dj_pick_next', now);
    expect(permit).toMatchObject({
      tier: 'standard',
      operation: 'dj_pick_next',
      creditsUsed: 8,
      creditsRemaining: 192
    });
  });
});

describe('resource limited 429 response', () => {
  function createResponse() {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      set: vi.fn((name: string, value: string) => {
        headers[name] = value;
        return res;
      }),
      status: vi.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: vi.fn((body: unknown) => {
        res.body = body;
        return res;
      }),
      headers
    };
    return res;
  }

  it('serializes every limit code as a typed 429 with Retry-After', () => {
    const cases: Array<{
      code: 'daily_quota_exceeded' | 'user_concurrency_exceeded' | 'standard_capacity_exceeded' | 'global_capacity_exceeded';
      operation: string;
    }> = [
      { code: 'daily_quota_exceeded', operation: 'chat' },
      { code: 'user_concurrency_exceeded', operation: 'dj_pick_next' },
      { code: 'standard_capacity_exceeded', operation: 'segue' },
      { code: 'global_capacity_exceeded', operation: 'tts_preview' }
    ];

    for (const testCase of cases) {
      const res = createResponse();
      const error = new ResourceLimitError(testCase.code, testCase.operation as never, 5);

      sendResourceLimitResponse(res as never, error);

      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('5');
      expect(res.body).toEqual({
        ok: false,
        error: 'resource_limited',
        reason: testCase.code,
        operation: testCase.operation,
        message: expect.any(String)
      });
    }
  });

  it('keeps Chinese messages and never exposes usage counters or other users', () => {
    const res = createResponse();
    const error = new ResourceLimitError('daily_quota_exceeded', 'chat', 5);

    sendResourceLimitResponse(res as never, error);

    const body = res.body as Record<string, unknown>;
    expect(typeof body.message).toBe('string');
    expect(body.message).not.toMatch(/\d/);
    expect(JSON.stringify(body)).not.toContain('creditsUsed');
    expect(JSON.stringify(body)).not.toContain('creditsRemaining');
  });
});
