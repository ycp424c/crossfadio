import { randomUUID } from 'node:crypto';
import {
  buildTrackExclusionAliases,
  buildTrackExclusionKey,
  createExplicitExclusion,
  getActiveExplicitExclusion,
  getExplicitExclusionById,
  normalizeExclusionKey,
  type CreateExplicitExclusionResult,
  type ExclusionSourceRef
} from './explicit-exclusions.js';
import { getDb } from './db.js';

const DEFAULT_RESOLUTION_DEADLINE_MS = 24 * 60 * 60_000;
export const DEFAULT_RESOLUTION_ATTEMPT_LEASE_MS = 5 * 60_000;

export type ExplicitExclusionResolutionStatus =
  | 'pending'
  | 'retryable'
  | 'processing'
  | 'succeeded'
  | 'dead';

export type ExplicitExclusionResolutionRecord = {
  id: string;
  exclusionId: string;
  resolvedExclusionId: string | null;
  userId: string;
  queryTitle: string;
  queryArtist: string | null;
  status: ExplicitExclusionResolutionStatus;
  attemptCount: number;
  nextAttemptAt: string;
  leaseToken: string | null;
  leaseUntil: string | null;
  deadlineAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export function createPendingExplicitTrackExclusion(input: {
  userId: string;
  entityKey: string;
  displayName: string;
  aliases: string[];
  sourceKind: string;
  sourceRef: ExclusionSourceRef;
  queryTitle: string;
  queryArtist?: string | null;
  createdAt?: string;
  deadlineAt?: string;
}): CreateExplicitExclusionResult {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const deadlineAt = input.deadlineAt
    ?? new Date(Date.parse(createdAt) + DEFAULT_RESOLUTION_DEADLINE_MS).toISOString();
  return getDb().transaction(() => {
    const result = createExplicitExclusion({
      userId: input.userId,
      entityType: 'track',
      entityKey: input.entityKey,
      provider: null,
      providerId: null,
      displayName: input.displayName,
      aliases: input.aliases,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      createdAt
    });
    enqueueExplicitExclusionResolution({
      exclusionId: result.exclusion.id,
      userId: input.userId,
      queryTitle: input.queryTitle,
      queryArtist: input.queryArtist,
      createdAt,
      deadlineAt
    });
    return result;
  })();
}

export function enqueueExplicitExclusionResolution(input: {
  exclusionId: string;
  userId: string;
  queryTitle: string;
  queryArtist?: string | null;
  createdAt: string;
  deadlineAt: string;
}): ExplicitExclusionResolutionRecord {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO explicit_exclusion_resolution_jobs (
      id, exclusion_id, resolved_exclusion_id, user_id, query_title, query_artist,
      status, attempt_count, next_attempt_at, lease_token, lease_until,
      deadline_at, last_error_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, NULL, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, ?, ?, NULL)
    ON CONFLICT(exclusion_id) DO UPDATE SET
      query_title = excluded.query_title,
      query_artist = excluded.query_artist,
      status = 'pending',
      attempt_count = 0,
      next_attempt_at = excluded.next_attempt_at,
      lease_token = NULL,
      lease_until = NULL,
      deadline_at = excluded.deadline_at,
      last_error_code = NULL,
      updated_at = excluded.updated_at,
      completed_at = NULL,
      resolved_exclusion_id = NULL
  `).run(
    id,
    input.exclusionId,
    input.userId,
    input.queryTitle.trim(),
    input.queryArtist?.trim() || null,
    input.createdAt,
    input.deadlineAt,
    input.createdAt,
    input.createdAt
  );
  const record = getExplicitExclusionResolutionByExclusionId(input.exclusionId);
  if (!record) throw new Error('Explicit Exclusion resolution was not persisted');
  return record;
}

export function getExplicitExclusionResolutionByExclusionId(
  exclusionId: string
): ExplicitExclusionResolutionRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM explicit_exclusion_resolution_jobs WHERE exclusion_id = ?
  `).get(exclusionId) as ExplicitExclusionResolutionRow | undefined;
  return row ? mapResolutionRow(row) : null;
}

export function listDueExplicitExclusionResolutions(input: {
  now: Date;
  limit?: number;
}): ExplicitExclusionResolutionRecord[] {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 10), 100));
  return (getDb().prepare(`
    SELECT * FROM explicit_exclusion_resolution_jobs
    WHERE (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_until <= ?)
      )
      AND deadline_at > ?
    ORDER BY next_attempt_at ASC, created_at ASC, id ASC
    LIMIT ?
  `).all(
    input.now.toISOString(),
    input.now.toISOString(),
    input.now.toISOString(),
    limit
  ) as ExplicitExclusionResolutionRow[])
    .map(mapResolutionRow);
}

export function beginExplicitExclusionResolutionAttempt(input: {
  id: string;
  now: Date;
  leaseMs?: number;
}): ExplicitExclusionResolutionRecord | null {
  const timestamp = input.now.toISOString();
  const leaseMs = Math.max(2, Math.trunc(input.leaseMs ?? DEFAULT_RESOLUTION_ATTEMPT_LEASE_MS));
  const leaseUntil = new Date(input.now.getTime() + leaseMs).toISOString();
  const leaseToken = randomUUID();
  const result = getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'processing', attempt_count = attempt_count + 1,
        lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ?
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_until <= ?)
      )
      AND deadline_at > ?
  `).run(
    leaseToken,
    leaseUntil,
    timestamp,
    input.id,
    timestamp,
    timestamp,
    timestamp
  );
  return result.changes === 1 ? getExplicitExclusionResolution(input.id) : null;
}

export function completeExplicitExclusionResolution(input: {
  id: string;
  leaseToken: string;
  track: { ncmId: string; name: string; artists: string[] };
  now: Date;
}): ExplicitExclusionResolutionRecord | null {
  const db = getDb();
  const timestamp = input.now.toISOString();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM explicit_exclusion_resolution_jobs
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_until IS NOT NULL AND lease_until > ?
    `).get(input.id, input.leaseToken, timestamp) as ExplicitExclusionResolutionRow | undefined;
    if (!row) return null;
    const job = mapResolutionRow(row);
    if (Date.parse(job.deadlineAt) <= input.now.getTime()) {
      return markExplicitExclusionResolutionDeadForLease({
        id: job.id,
        leaseToken: input.leaseToken,
        errorCode: 'resolution_deadline_exceeded',
        now: input.now
      });
    }
    const pending = getExplicitExclusionById(job.userId, job.exclusionId);
    if (!pending || pending.revokedAt) {
      return markExplicitExclusionResolutionDeadForLease({
        id: job.id,
        leaseToken: input.leaseToken,
        errorCode: 'exclusion_inactive',
        now: input.now
      });
    }

    const primaryArtist = input.track.artists[0] ?? '';
    const entityKey = buildTrackExclusionKey({
      provider: 'ncm',
      providerId: input.track.ncmId,
      title: input.track.name,
      primaryArtist
    });
    const aliases = [...new Set([
      ...pending.aliases,
      normalizeExclusionKey(job.queryTitle),
      ...buildTrackExclusionAliases({
        provider: 'ncm',
        providerId: input.track.ncmId,
        title: input.track.name,
        primaryArtist
      })
    ].filter(Boolean))];
    const existing = getActiveExplicitExclusion(job.userId, 'track', entityKey);
    const resolvedExclusionId = existing && existing.id !== pending.id ? existing.id : pending.id;

    if (existing && existing.id !== pending.id) {
      const mergedAliases = [...new Set([...existing.aliases, ...aliases])];
      getDb().prepare(`
        UPDATE explicit_exclusions SET aliases_json = ? WHERE id = ? AND user_id = ?
      `).run(JSON.stringify(mergedAliases), existing.id, job.userId);
      getDb().prepare(`
        UPDATE explicit_exclusions
        SET revoked_at = ?, revocation_source_ref_json = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(
        input.now.toISOString(),
        JSON.stringify({ sourceId: `resolution_merge:${job.id}` }),
        pending.id,
        job.userId
      );
    } else {
      getDb().prepare(`
        UPDATE explicit_exclusions
        SET entity_key = ?, provider = 'ncm', provider_id = ?, display_name = ?, aliases_json = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(
        entityKey,
        input.track.ncmId,
        input.track.name,
        JSON.stringify(aliases),
        pending.id,
        job.userId
      );
    }

    const completed = getDb().prepare(`
      UPDATE explicit_exclusion_resolution_jobs
      SET status = 'succeeded', resolved_exclusion_id = ?, last_error_code = NULL,
          lease_token = NULL, lease_until = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_until IS NOT NULL AND lease_until > ?
    `).run(
      resolvedExclusionId,
      timestamp,
      timestamp,
      job.id,
      input.leaseToken,
      timestamp
    );
    if (completed.changes !== 1) {
      throw new Error('Explicit Exclusion resolution lease changed');
    }
    return getExplicitExclusionResolution(job.id);
  }).immediate();
}

export function failExplicitExclusionResolution(input: {
  id: string;
  leaseToken: string;
  errorCode: string;
  now: Date;
}): ExplicitExclusionResolutionRecord | null {
  const job = getExplicitExclusionResolution(input.id);
  if (
    !job
    || job.status !== 'processing'
    || job.leaseToken !== input.leaseToken
    || job.leaseUntil === null
    || Date.parse(job.leaseUntil) <= input.now.getTime()
  ) return null;
  const retryAt = new Date(input.now.getTime() + retryDelayMs(job.attemptCount));
  if (retryAt.getTime() >= Date.parse(job.deadlineAt)) {
    return markExplicitExclusionResolutionDeadForLease(input);
  }
  getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'retryable', next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
        last_error_code = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_token = ?
      AND lease_until IS NOT NULL AND lease_until > ?
  `).run(
    retryAt.toISOString(),
    input.errorCode,
    input.now.toISOString(),
    input.id,
    input.leaseToken,
    input.now.toISOString()
  );
  return getExplicitExclusionResolution(input.id);
}

export function releaseExplicitExclusionResolution(input: {
  id: string;
  leaseToken: string;
  now: Date;
}): boolean {
  const timestamp = input.now.toISOString();
  return getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'pending', attempt_count = MAX(0, attempt_count - 1),
        next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
        last_error_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_token = ?
      AND lease_until IS NOT NULL AND lease_until > ?
  `).run(timestamp, timestamp, input.id, input.leaseToken, timestamp).changes === 1;
}

export function expireExplicitExclusionResolutions(
  now: Date
): ExplicitExclusionResolutionRecord[] {
  const timestamp = now.toISOString();
  const rows = getDb().prepare(`
    SELECT * FROM explicit_exclusion_resolution_jobs
    WHERE status IN ('pending', 'retryable', 'processing') AND deadline_at <= ?
  `).all(timestamp) as ExplicitExclusionResolutionRow[];
  if (rows.length === 0) return [];
  getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'dead', last_error_code = 'resolution_deadline_exceeded',
        lease_token = NULL, lease_until = NULL, updated_at = ?, completed_at = ?
    WHERE status IN ('pending', 'retryable', 'processing') AND deadline_at <= ?
  `).run(timestamp, timestamp, timestamp);
  return rows.map((row) => getExplicitExclusionResolution(row.id)).filter(
    (record): record is ExplicitExclusionResolutionRecord => record !== null
  );
}

function getExplicitExclusionResolution(id: string): ExplicitExclusionResolutionRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM explicit_exclusion_resolution_jobs WHERE id = ?
  `).get(id) as ExplicitExclusionResolutionRow | undefined;
  return row ? mapResolutionRow(row) : null;
}

function markExplicitExclusionResolutionDeadForLease(input: {
  id: string;
  leaseToken: string;
  errorCode: string;
  now: Date;
}): ExplicitExclusionResolutionRecord | null {
  const timestamp = input.now.toISOString();
  const result = getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'dead', lease_token = NULL, lease_until = NULL,
        last_error_code = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'processing' AND lease_token = ?
      AND lease_until IS NOT NULL AND lease_until > ?
  `).run(input.errorCode, timestamp, timestamp, input.id, input.leaseToken, timestamp);
  return result.changes === 1 ? getExplicitExclusionResolution(input.id) : null;
}

function retryDelayMs(attemptCount: number): number {
  const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
  return delays[Math.min(Math.max(0, attemptCount - 1), delays.length - 1)]!;
}

type ExplicitExclusionResolutionRow = {
  id: string;
  exclusion_id: string;
  resolved_exclusion_id: string | null;
  user_id: string;
  query_title: string;
  query_artist: string | null;
  status: ExplicitExclusionResolutionStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_until: string | null;
  deadline_at: string;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function mapResolutionRow(row: ExplicitExclusionResolutionRow): ExplicitExclusionResolutionRecord {
  return {
    id: row.id,
    exclusionId: row.exclusion_id,
    resolvedExclusionId: row.resolved_exclusion_id,
    userId: row.user_id,
    queryTitle: row.query_title,
    queryArtist: row.query_artist,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    deadlineAt: row.deadline_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}
