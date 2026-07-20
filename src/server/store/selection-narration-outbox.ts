import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

const NARRATION_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_OFFSETS_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const;

export type SelectionNarrationStatus = 'pending' | 'processing' | 'completed' | 'dead';

export type SelectionNarrationFailureCode =
  | 'invalid_narration_text'
  | 'invalid_narration_plan'
  | 'narration_attempts_exhausted'
  | 'narration_deadline_exceeded'
  | 'narration_discarded'
  | 'narration_entity_not_whitelisted'
  | 'narration_failed'
  | 'narration_journey_stale'
  | 'narration_provider_client_error'
  | 'narration_provider_error'
  | 'narration_provider_rate_limited'
  | 'narration_provider_server_error'
  | 'narration_reason_not_in_trace'
  | 'narration_result_stale'
  | 'narration_selection_not_in_trace'
  | 'narration_timeout'
  | 'narration_trace_run_mismatch'
  | 'selection_narration_trace_missing';

const SELECTION_NARRATION_FAILURE_CODES = new Set<SelectionNarrationFailureCode>([
  'invalid_narration_text',
  'invalid_narration_plan',
  'narration_attempts_exhausted',
  'narration_deadline_exceeded',
  'narration_discarded',
  'narration_entity_not_whitelisted',
  'narration_failed',
  'narration_journey_stale',
  'narration_provider_client_error',
  'narration_provider_error',
  'narration_provider_rate_limited',
  'narration_provider_server_error',
  'narration_reason_not_in_trace',
  'narration_result_stale',
  'narration_selection_not_in_trace',
  'narration_timeout',
  'narration_trace_run_mismatch',
  'selection_narration_trace_missing'
]);

export type SelectionNarrationRecord = {
  id: string;
  journeyId: string;
  userId: string;
  runId: string;
  journeyVersion: number;
  factsHash: string;
  status: SelectionNarrationStatus;
  attemptCount: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export function enqueueSelectionNarration(input: {
  journeyId: string;
  userId: string;
  runId: string;
  journeyVersion: number;
  factsHash: string;
  now?: Date;
}): SelectionNarrationRecord {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO selection_narration_outbox (
      id, journey_id, user_id, run_id, journey_version, facts_hash,
      status, attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(user_id, run_id, journey_version, facts_hash) DO NOTHING
  `).run(
    id,
    input.journeyId,
    input.userId,
    input.runId,
    input.journeyVersion,
    input.factsHash,
    timestamp,
    timestamp,
    timestamp
  );
  const record = getDb().prepare(`
    SELECT * FROM selection_narration_outbox
    WHERE user_id = ? AND run_id = ? AND journey_version = ? AND facts_hash = ?
  `).get(
    input.userId,
    input.runId,
    input.journeyVersion,
    input.factsHash
  ) as SelectionNarrationRow | undefined;
  if (!record) throw new Error('Selection narration was not persisted');
  return mapRow(record);
}

export function claimNextSelectionNarration(input: {
  now?: Date;
  leaseMs: number;
}): SelectionNarrationRecord | null {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + Math.max(1, input.leaseMs)).toISOString();
  const deadlineCutoff = new Date(now.getTime() - NARRATION_DEADLINE_MS).toISOString();
  const db = getDb();

  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM selection_narration_outbox
      WHERE attempt_count < ?
        AND created_at > ?
        AND (
          (status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'processing' AND lease_until <= ?)
        )
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT 1
    `).get(MAX_ATTEMPTS, deadlineCutoff, nowIso, nowIso) as SelectionNarrationRow | undefined;
    if (!row) return null;

    const result = db.prepare(`
      UPDATE selection_narration_outbox
      SET status = 'processing', attempt_count = attempt_count + 1,
          lease_until = ?, updated_at = ?
      WHERE id = ?
        AND status = ?
        AND attempt_count = ?
        AND COALESCE(lease_until, '') = COALESCE(?, '')
    `).run(leaseUntil, nowIso, row.id, row.status, row.attempt_count, row.lease_until);
    if (result.changes !== 1) return null;
    return getSelectionNarration(row.id);
  })();
}

export function expireSelectionNarrations(now = new Date()): SelectionNarrationRecord[] {
  const nowIso = now.toISOString();
  const deadlineCutoff = new Date(now.getTime() - NARRATION_DEADLINE_MS).toISOString();
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM selection_narration_outbox
      WHERE status IN ('pending', 'processing')
        AND (created_at <= ? OR (status = 'processing' AND attempt_count >= ? AND lease_until <= ?))
      ORDER BY created_at ASC, id ASC
    `).all(deadlineCutoff, MAX_ATTEMPTS, nowIso) as SelectionNarrationRow[];
    const update = db.prepare(`
      UPDATE selection_narration_outbox
      SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `);
    const expired: SelectionNarrationRecord[] = [];
    for (const row of rows) {
      const error = row.created_at <= deadlineCutoff
        ? 'narration_deadline_exceeded'
        : 'narration_attempts_exhausted';
      if (update.run(error, nowIso, row.id).changes !== 1) continue;
      const record = getSelectionNarration(row.id);
      if (record) expired.push(record);
    }
    return expired;
  })();
}

export function listExpiredSelectionNarrations(now = new Date()): SelectionNarrationRecord[] {
  const nowIso = now.toISOString();
  const deadlineCutoff = new Date(now.getTime() - NARRATION_DEADLINE_MS).toISOString();
  return (getDb().prepare(`
    SELECT * FROM selection_narration_outbox
    WHERE status IN ('pending', 'processing')
      AND (created_at <= ? OR (status = 'processing' AND attempt_count >= ? AND lease_until <= ?))
    ORDER BY created_at ASC, id ASC
  `).all(deadlineCutoff, MAX_ATTEMPTS, nowIso) as SelectionNarrationRow[]).map(mapRow);
}

export function selectionNarrationExpirationCode(
  record: SelectionNarrationRecord,
  now = new Date()
): SelectionNarrationFailureCode | null {
  if (now.getTime() - Date.parse(record.createdAt) >= NARRATION_DEADLINE_MS) {
    return 'narration_deadline_exceeded';
  }
  if (
    record.status === 'processing'
    && record.attemptCount >= MAX_ATTEMPTS
    && record.leaseUntil !== null
    && Date.parse(record.leaseUntil) <= now.getTime()
  ) {
    return 'narration_attempts_exhausted';
  }
  return null;
}

export function selectionNarrationFailureIsTerminal(record: SelectionNarrationRecord): boolean {
  const deadlineAt = Date.parse(record.createdAt) + NARRATION_DEADLINE_MS;
  const nextAttemptOffset = ATTEMPT_OFFSETS_MS[record.attemptCount];
  if (nextAttemptOffset === undefined) return true;
  return record.attemptCount >= MAX_ATTEMPTS
    || Date.parse(record.createdAt) + nextAttemptOffset >= deadlineAt;
}

export function completeSelectionNarration(input: {
  id: string;
  leaseUntil: string;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  const record = getSelectionNarration(input.id);
  if (!record || record.status !== 'processing' || record.leaseUntil !== input.leaseUntil) {
    return false;
  }
  if (now.getTime() - Date.parse(record.createdAt) >= NARRATION_DEADLINE_MS) {
    markDeadForLease(input.id, input.leaseUntil, now, 'narration_deadline_exceeded');
    return false;
  }
  const timestamp = now.toISOString();
  return getDb().prepare(`
    UPDATE selection_narration_outbox
    SET status = 'completed', lease_until = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?
  `).run(timestamp, timestamp, input.id, input.leaseUntil).changes === 1;
}

export function failSelectionNarration(input: {
  id: string;
  leaseUntil: string;
  errorCode: SelectionNarrationFailureCode;
  now?: Date;
}): SelectionNarrationRecord | null {
  const now = input.now ?? new Date();
  const record = getSelectionNarration(input.id);
  if (!record || record.status !== 'processing' || record.leaseUntil !== input.leaseUntil) {
    return record;
  }
  const deadlineAt = Date.parse(record.createdAt) + NARRATION_DEADLINE_MS;
  const nextAttemptOffset = ATTEMPT_OFFSETS_MS[record.attemptCount];
  const nextAttemptAt = nextAttemptOffset === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(record.createdAt) + nextAttemptOffset;
  const shouldDie = record.attemptCount >= MAX_ATTEMPTS
    || nextAttemptOffset === undefined
    || nextAttemptAt >= deadlineAt;
  const timestamp = now.toISOString();
  const errorCode = stableFailureCode(input.errorCode);

  if (shouldDie) {
    markDeadForLease(input.id, input.leaseUntil, now, errorCode);
  } else {
    getDb().prepare(`
      UPDATE selection_narration_outbox
      SET status = 'pending', next_attempt_at = ?, lease_until = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_until = ?
    `).run(
      new Date(nextAttemptAt).toISOString(),
      errorCode,
      timestamp,
      input.id,
      input.leaseUntil
    );
  }
  return getSelectionNarration(input.id);
}

export function releaseSelectionNarration(input: {
  id: string;
  leaseUntil: string;
  now?: Date;
}): boolean {
  const timestamp = (input.now ?? new Date()).toISOString();
  return getDb().prepare(`
    UPDATE selection_narration_outbox
    SET status = 'pending', attempt_count = MAX(0, attempt_count - 1),
        next_attempt_at = ?, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?
  `).run(timestamp, timestamp, input.id, input.leaseUntil).changes === 1;
}

export function discardSelectionNarration(input: {
  id: string;
  leaseUntil: string;
  reason: SelectionNarrationFailureCode;
  now?: Date;
}): boolean {
  return markDeadForLease(
    input.id,
    input.leaseUntil,
    input.now ?? new Date(),
    stableFailureCode(input.reason)
  );
}

export function discardExpiredSelectionNarration(input: {
  record: SelectionNarrationRecord;
  reason: SelectionNarrationFailureCode;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const deadlineCutoff = new Date(now.getTime() - NARRATION_DEADLINE_MS).toISOString();
  return getDb().prepare(`
    UPDATE selection_narration_outbox
    SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status = ? AND attempt_count = ?
      AND COALESCE(lease_until, '') = COALESCE(?, '')
      AND (created_at <= ? OR (
        status = 'processing' AND attempt_count >= ?
        AND lease_until IS NOT NULL AND lease_until <= ?
      ))
  `).run(
    stableFailureCode(input.reason),
    nowIso,
    input.record.id,
    input.record.status,
    input.record.attemptCount,
    input.record.leaseUntil,
    deadlineCutoff,
    MAX_ATTEMPTS,
    nowIso
  ).changes === 1;
}

export function getSelectionNarration(id: string): SelectionNarrationRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM selection_narration_outbox WHERE id = ?
  `).get(id) as SelectionNarrationRow | undefined;
  return row ? mapRow(row) : null;
}

export function cleanupSelectionNarrationOutbox(now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  return getDb().prepare(`
    DELETE FROM selection_narration_outbox
    WHERE status IN ('completed', 'dead') AND updated_at <= ?
  `).run(cutoff).changes;
}

function markDeadForLease(
  id: string,
  leaseUntil: string,
  now: Date,
  errorCode: SelectionNarrationFailureCode
): boolean {
  return getDb().prepare(`
    UPDATE selection_narration_outbox
    SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?
  `).run(stableFailureCode(errorCode), now.toISOString(), id, leaseUntil).changes === 1;
}

function stableFailureCode(value: SelectionNarrationFailureCode): SelectionNarrationFailureCode {
  return SELECTION_NARRATION_FAILURE_CODES.has(value) ? value : 'narration_failed';
}

type SelectionNarrationRow = {
  id: string;
  journey_id: string;
  user_id: string;
  run_id: string;
  journey_version: number;
  facts_hash: string;
  status: SelectionNarrationStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function mapRow(row: SelectionNarrationRow): SelectionNarrationRecord {
  return {
    id: row.id,
    journeyId: row.journey_id,
    userId: row.user_id,
    runId: row.run_id,
    journeyVersion: row.journey_version,
    factsHash: row.facts_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}
