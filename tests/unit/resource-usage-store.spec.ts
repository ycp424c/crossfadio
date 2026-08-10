import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, _resetDbForTest, getDb } from '../../src/server/store/db';
import {
  reserveDailyCredits,
  DailyCreditsQuotaError,
  getDailyCreditsUsage
} from '../../src/server/store/resource-usage';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-resource-usage-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('reserveDailyCredits', () => {
  const now = new Date('2026-08-10T08:00:00.000Z'); // 2026-08-10 16:00 Shanghai

  it('accumulates same-day usage across reservations', () => {
    const first = reserveDailyCredits({ userId: 'user-1', credits: 4, limit: 200, now });
    const second = reserveDailyCredits({ userId: 'user-1', credits: 8, limit: 200, now });

    expect(first).toEqual({ periodKey: '2026-08-10', creditsUsed: 4, creditsRemaining: 196 });
    expect(second).toEqual({ periodKey: '2026-08-10', creditsUsed: 12, creditsRemaining: 188 });
  });

  it('isolates usage between users', () => {
    reserveDailyCredits({ userId: 'user-1', credits: 10, limit: 200, now });

    const other = reserveDailyCredits({ userId: 'user-2', credits: 5, limit: 200, now });
    expect(other).toEqual({ periodKey: '2026-08-10', creditsUsed: 5, creditsRemaining: 195 });
    expect(getDailyCreditsUsage('user-1', '2026-08-10')).toBe(10);
  });

  it('rolls over to a fresh bucket on a new Shanghai calendar day', () => {
    reserveDailyCredits({ userId: 'user-1', credits: 199, limit: 200, now });

    // 16:00:00 UTC = 00:00:00 next day in Shanghai (UTC+8)
    const nextDay = new Date('2026-08-10T16:00:00.000Z');
    const result = reserveDailyCredits({ userId: 'user-1', credits: 50, limit: 200, now: nextDay });

    expect(result).toEqual({ periodKey: '2026-08-11', creditsUsed: 50, creditsRemaining: 150 });
    expect(getDailyCreditsUsage('user-1', '2026-08-10')).toBe(199);
    expect(getDailyCreditsUsage('user-1', '2026-08-11')).toBe(50);
  });

  it('succeeds when usage lands exactly on the limit', () => {
    const result = reserveDailyCredits({ userId: 'user-1', credits: 200, limit: 200, now });
    expect(result).toEqual({ periodKey: '2026-08-10', creditsUsed: 200, creditsRemaining: 0 });
  });

  it('rejects reservations that overflow the limit with a typed quota error', () => {
    reserveDailyCredits({ userId: 'user-1', credits: 195, limit: 200, now });

    try {
      reserveDailyCredits({ userId: 'user-1', credits: 10, limit: 200, now });
      expect.unreachable('expected a quota error');
    } catch (err) {
      expect(err).toBeInstanceOf(DailyCreditsQuotaError);
      const quotaError = err as DailyCreditsQuotaError;
      expect(quotaError.periodKey).toBe('2026-08-10');
      expect(quotaError.limit).toBe(200);
      expect(quotaError.used).toBe(195);
    }
    // The rejected reservation must not have changed the bucket
    expect(getDailyCreditsUsage('user-1', '2026-08-10')).toBe(195);
  });

  it('persists usage across a DB close and reopen', () => {
    reserveDailyCredits({ userId: 'user-1', credits: 12, limit: 200, now });

    _resetDbForTest();
    initDb();

    expect(getDailyCreditsUsage('user-1', '2026-08-10')).toBe(12);
    const result = reserveDailyCredits({ userId: 'user-1', credits: 8, limit: 200, now });
    expect(result).toEqual({ periodKey: '2026-08-10', creditsUsed: 20, creditsRemaining: 180 });
  });

  it('stores exactly one row per user and Shanghai day', () => {
    reserveDailyCredits({ userId: 'user-1', credits: 4, limit: 200, now });
    reserveDailyCredits({ userId: 'user-1', credits: 4, limit: 200, now });

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS count FROM resource_usage_buckets WHERE user_id = ?')
      .get('user-1') as { count: number };
    expect(rows.count).toBe(1);
  });
});
