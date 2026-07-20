import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

export type PreferenceExtractionStatus =
  | 'pending'
  | 'retryable'
  | 'processing'
  | 'succeeded'
  | 'no_evidence'
  | 'dead';

export type PreferenceExtractionBatch = {
  id: string;
  userId: string;
  sourceKey: string;
  messageIds: number[];
  extractorVersion: string;
  status: PreferenceExtractionStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type PreferenceExtractionSourceClass = 'current' | 'legacy';

const createBatchSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  sourceKey: z.string().trim().min(1).max(300),
  messageIds: z.array(z.number().int().positive()).min(1).max(100),
  extractorVersion: z.string().trim().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }).optional()
}).strict();

export function createPreferenceExtractionBatch(
  input: z.input<typeof createBatchSchema>
): { created: boolean; batch: PreferenceExtractionBatch } {
  const parsed = createBatchSchema.parse(input);
  const id = randomUUID();
  const timestamp = parsed.createdAt ?? new Date().toISOString();
  const messageIds = [...new Set(parsed.messageIds)].sort((a, b) => a - b);
  const result = getDb().prepare(
    `INSERT INTO preference_extraction_batches (
      id, user_id, source_key, message_ids_json, extractor_version, status,
      attempt_count, next_attempt_at, lease_token, lease_until, error_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?, NULL)
    ON CONFLICT(user_id, source_key, extractor_version) DO NOTHING`
  ).run(
    id,
    parsed.userId,
    parsed.sourceKey,
    JSON.stringify(messageIds),
    parsed.extractorVersion,
    timestamp,
    timestamp
  );
  const batch = getPreferenceExtractionBatchBySource(
    parsed.userId,
    parsed.sourceKey,
    parsed.extractorVersion
  );
  if (!batch) throw new Error('Preference extraction batch was not persisted');
  return { created: result.changes === 1, batch };
}

export function getPreferenceExtractionBatch(
  userId: string,
  id: string
): PreferenceExtractionBatch | null {
  const row = getDb().prepare<[string, string], PreferenceExtractionBatchRow>(
    `SELECT * FROM preference_extraction_batches WHERE user_id = ? AND id = ?`
  ).get(userId, id);
  return row ? mapBatchRow(row) : null;
}

export function getPreferenceExtractionBatchBySource(
  userId: string,
  sourceKey: string,
  extractorVersion: string
): PreferenceExtractionBatch | null {
  const row = getDb().prepare<[string, string, string], PreferenceExtractionBatchRow>(
    `SELECT * FROM preference_extraction_batches
     WHERE user_id = ? AND source_key = ? AND extractor_version = ?`
  ).get(userId, sourceKey.trim(), extractorVersion.trim());
  return row ? mapBatchRow(row) : null;
}

export function listDuePreferenceExtractionBatches(input: {
  now?: Date;
  limit?: number;
} = {}): PreferenceExtractionBatch[] {
  const now = (input.now ?? new Date()).toISOString();
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 20), 100));
  const rows = getDb().prepare<[string, string, number], PreferenceExtractionBatchRow>(
    `SELECT * FROM preference_extraction_batches
     WHERE status = 'pending'
        OR (status = 'retryable' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
     ORDER BY
       CASE WHEN source_key LIKE 'legacy-chat-preference:%' THEN 1 ELSE 0 END ASC,
       CASE
         WHEN status = 'retryable' THEN next_attempt_at
         WHEN status = 'processing' THEN lease_until
         ELSE created_at
       END ASC,
       id ASC
     LIMIT ?`
  ).all(now, now, limit);
  return rows.map(mapBatchRow);
}

export function listFairDuePreferenceExtractionBatches(input: {
  sourceClass: PreferenceExtractionSourceClass;
  afterUserId?: string | null;
  now?: Date;
  limit?: number;
}): PreferenceExtractionBatch[] {
  const now = (input.now ?? new Date()).toISOString();
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 20), 100));
  const afterUserId = input.afterUserId?.trim() ?? '';
  const rows = getDb().prepare<[
    string,
    string,
    PreferenceExtractionSourceClass,
    string,
    number
  ], PreferenceExtractionBatchRow>(
    `WITH due AS (
       SELECT *,
         CASE
           WHEN status = 'retryable' THEN next_attempt_at
           WHEN status = 'processing' THEN lease_until
           ELSE created_at
         END AS due_at
       FROM preference_extraction_batches
       WHERE (status = 'pending'
          OR (status = 'retryable' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
          OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))
         AND CASE
           WHEN source_key LIKE 'legacy-chat-preference:%' THEN 'legacy'
           ELSE 'current'
         END = ?
     ), per_user AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY user_id ORDER BY due_at ASC, id ASC
       ) AS user_rank
       FROM due
     )
     SELECT * FROM per_user
     WHERE user_rank = 1
     ORDER BY
       CASE WHEN user_id > ? THEN 0 ELSE 1 END ASC,
       user_id ASC
     LIMIT ?`
  ).all(now, now, input.sourceClass, afterUserId, limit);
  return rows.map(mapBatchRow);
}

export function claimPreferenceExtractionBatch(input: {
  userId: string;
  id: string;
  now?: Date;
  leaseMs: number;
}): PreferenceExtractionBatch | null {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + Math.max(1, input.leaseMs)).toISOString();
  const result = getDb().prepare(`
    UPDATE preference_extraction_batches
    SET status = 'processing', attempt_count = attempt_count + 1,
        lease_token = ?, lease_until = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
      AND (
        status = 'pending'
        OR (status = 'retryable' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
      )
  `).run(
    leaseToken,
    leaseUntil,
    timestamp,
    input.userId,
    input.id,
    timestamp,
    timestamp
  );
  return result.changes === 1 ? getPreferenceExtractionBatch(input.userId, input.id) : null;
}

export function releasePreferenceExtractionBatch(input: {
  userId: string;
  id: string;
  leaseToken: string;
  releasedAt?: string;
}): boolean {
  const timestamp = new Date(input.releasedAt ?? Date.now()).toISOString();
  return getDb().prepare(`
    UPDATE preference_extraction_batches
    SET status = CASE WHEN next_attempt_at IS NULL THEN 'pending' ELSE 'retryable' END,
        attempt_count = MAX(0, attempt_count - 1),
        lease_token = NULL, lease_until = NULL, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'processing' AND lease_token = ?
      AND lease_until IS NOT NULL AND lease_until > ?
  `).run(timestamp, input.userId, input.id, input.leaseToken, timestamp).changes === 1;
}

export function completePreferenceExtractionBatch(input: {
  userId: string;
  id: string;
  leaseToken: string;
  outcome: 'succeeded' | 'no_evidence';
  completedAt?: string;
}): PreferenceExtractionBatch | null {
  const timestamp = new Date(input.completedAt ?? Date.now()).toISOString();
  const result = getDb().prepare(
    `UPDATE preference_extraction_batches
     SET status = ?, next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
         error_code = NULL, updated_at = ?, completed_at = ?
     WHERE user_id = ? AND id = ? AND status = 'processing' AND lease_token = ?
       AND lease_until IS NOT NULL AND lease_until > ?`
  ).run(
    input.outcome,
    timestamp,
    timestamp,
    input.userId,
    input.id,
    input.leaseToken,
    timestamp
  );
  return result.changes === 1 ? getPreferenceExtractionBatch(input.userId, input.id) : null;
}

export function markPreferenceExtractionBatchRetryable(input: {
  userId: string;
  id: string;
  leaseToken: string;
  errorCode: string;
  attemptedAt?: string;
  nextAttemptAt: string;
}): PreferenceExtractionBatch | null {
  const timestamp = new Date(input.attemptedAt ?? Date.now()).toISOString();
  const result = getDb().prepare(
    `UPDATE preference_extraction_batches
     SET status = 'retryable', next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
         error_code = ?, updated_at = ?, completed_at = NULL
     WHERE user_id = ? AND id = ? AND status = 'processing' AND lease_token = ?
       AND lease_until IS NOT NULL AND lease_until > ?`
  ).run(
    input.nextAttemptAt,
    input.errorCode,
    timestamp,
    input.userId,
    input.id,
    input.leaseToken,
    timestamp
  );
  return result.changes === 1 ? getPreferenceExtractionBatch(input.userId, input.id) : null;
}

export function deadLetterPreferenceExtractionBatch(input: {
  userId: string;
  id: string;
  leaseToken: string;
  errorCode: string;
  attemptedAt?: string;
}): PreferenceExtractionBatch | null {
  const timestamp = new Date(input.attemptedAt ?? Date.now()).toISOString();
  const result = getDb().prepare(
    `UPDATE preference_extraction_batches
     SET status = 'dead', next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
         error_code = ?, updated_at = ?, completed_at = ?
     WHERE user_id = ? AND id = ? AND status = 'processing' AND lease_token = ?
       AND lease_until IS NOT NULL AND lease_until > ?`
  ).run(
    input.errorCode,
    timestamp,
    timestamp,
    input.userId,
    input.id,
    input.leaseToken,
    timestamp
  );
  return result.changes === 1 ? getPreferenceExtractionBatch(input.userId, input.id) : null;
}

type PreferenceExtractionBatchRow = {
  id: string;
  user_id: string;
  source_key: string;
  message_ids_json: string;
  extractor_version: string;
  status: PreferenceExtractionStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_token: string | null;
  lease_until: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function mapBatchRow(row: PreferenceExtractionBatchRow): PreferenceExtractionBatch {
  return {
    id: row.id,
    userId: row.user_id,
    sourceKey: row.source_key,
    messageIds: parseMessageIds(row.message_ids_json),
    extractorVersion: row.extractor_version,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function parseMessageIds(value: string): number[] {
  try {
    const parsed = z.array(z.number().int().positive()).safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
