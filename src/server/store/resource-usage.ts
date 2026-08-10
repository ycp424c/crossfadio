import { getDb } from './db.js';
import { formatShanghaiDate } from '../timezone.js';

export type DailyCreditsReservation = {
  periodKey: string;
  creditsUsed: number;
  creditsRemaining: number;
};

export type ReserveDailyCreditsInput = {
  userId: string;
  credits: number;
  limit: number;
  now?: Date;
};

export class DailyCreditsQuotaError extends Error {
  readonly periodKey: string;
  readonly limit: number;
  readonly used: number;

  constructor(periodKey: string, limit: number, used: number) {
    super(`daily credit quota exceeded for period ${periodKey}`);
    this.name = 'DailyCreditsQuotaError';
    this.periodKey = periodKey;
    this.limit = limit;
    this.used = used;
  }
}

type UsageBucketRow = {
  user_id: string;
  period_key: string;
  credits_used: number;
};

/**
 * Atomically reserve `credits` against the user's Shanghai-calendar-day bucket.
 * Insert, conditional update and readback happen in one immediate transaction;
 * the UPDATE only matches when the bucket can absorb the full reservation.
 */
export function reserveDailyCredits(input: ReserveDailyCreditsInput): DailyCreditsReservation {
  const { userId, credits, limit } = input;
  const now = input.now ?? new Date();
  const periodKey = formatShanghaiDate(now);

  const db = getDb();
  return db.transaction((): DailyCreditsReservation => {
    db.prepare(
      `INSERT OR IGNORE INTO resource_usage_buckets (user_id, period_key, credits_used)
       VALUES (?, ?, 0)`
    ).run(userId, periodKey);

    const update = db.prepare(
      `UPDATE resource_usage_buckets
       SET credits_used = credits_used + ?, updated_at = datetime('now')
       WHERE user_id = ? AND period_key = ? AND credits_used + ? <= ?`
    );
    const result = update.run(credits, userId, periodKey, credits, limit);
    if (result.changes === 0) {
      const row = db
        .prepare<[string, string], UsageBucketRow>(
          `SELECT user_id, period_key, credits_used FROM resource_usage_buckets
           WHERE user_id = ? AND period_key = ?`
        )
        .get(userId, periodKey);
      throw new DailyCreditsQuotaError(periodKey, limit, row?.credits_used ?? 0);
    }

    const row = db
      .prepare<[string, string], UsageBucketRow>(
        `SELECT user_id, period_key, credits_used FROM resource_usage_buckets
         WHERE user_id = ? AND period_key = ?`
      )
      .get(userId, periodKey);
    const creditsUsed = row?.credits_used ?? credits;
    return {
      periodKey,
      creditsUsed,
      creditsRemaining: Math.max(0, limit - creditsUsed)
    };
  }).immediate();
}

export function getDailyCreditsUsage(userId: string, periodKey: string): number {
  const row = getDb()
    .prepare<[string, string], UsageBucketRow>(
      `SELECT user_id, period_key, credits_used FROM resource_usage_buckets
       WHERE user_id = ? AND period_key = ?`
    )
    .get(userId, periodKey);
  return row?.credits_used ?? 0;
}
