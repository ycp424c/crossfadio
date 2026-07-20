import { randomUUID } from 'node:crypto';
import {
  selectionJourneySnapshotSchema,
  type SelectionJourneySnapshot
} from '../../shared/selection.js';
import { getDb } from './db.js';

const JOURNEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_HISTORY_MS = 24 * 60 * 60 * 1_000;
const NARRATION_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const NARRATION_MAX_ATTEMPTS = 5;

export type SelectionJourneyRecord = {
  id: string;
  userId: string;
  factsHash: string;
  snapshot: SelectionJourneySnapshot;
  expiresAt: string;
};

export function saveSelectionJourney(input: {
  userId: string;
  factsHash: string;
  snapshot: SelectionJourneySnapshot;
}): SelectionJourneyRecord {
  const snapshot = selectionJourneySnapshotSchema.parse(input.snapshot);
  const snapshotJson = JSON.stringify(snapshot);
  const db = getDb();
  const existing = getSelectionJourney(input.userId, snapshot.runId, snapshot.journeyVersion);

  if (existing) {
    if (snapshot.revision < existing.snapshot.revision) return existing;
    if (snapshot.revision === existing.snapshot.revision) {
      if (existing.factsHash === input.factsHash && JSON.stringify(existing.snapshot) === snapshotJson) {
        return existing;
      }
      throw new Error('Conflicting journey revision');
    }

    const expiresAt = new Date(
      Date.parse(snapshot.updatedAt) + JOURNEY_RETENTION_MS
    ).toISOString();
    db.prepare(`
      UPDATE selection_journeys
      SET revision = ?, facts_hash = ?, status = ?, snapshot_json = ?,
          updated_at = ?, completed_at = ?, expires_at = ?
      WHERE id = ?
    `).run(
      snapshot.revision,
      input.factsHash,
      snapshot.status,
      snapshotJson,
      snapshot.updatedAt,
      snapshot.completedAt ?? null,
      expiresAt,
      existing.id
    );
    return getSelectionJourney(input.userId, snapshot.runId, snapshot.journeyVersion)!;
  }

  const id = randomUUID();
  const expiresAt = new Date(Date.parse(snapshot.updatedAt) + JOURNEY_RETENTION_MS).toISOString();
  db.prepare(`
    INSERT INTO selection_journeys (
      id, user_id, run_id, journey_version, revision, facts_hash, status,
      snapshot_json, started_at, updated_at, completed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    snapshot.runId,
    snapshot.journeyVersion,
    snapshot.revision,
    input.factsHash,
    snapshot.status,
    snapshotJson,
    snapshot.startedAt,
    snapshot.updatedAt,
    snapshot.completedAt ?? null,
    expiresAt
  );
  return getSelectionJourney(input.userId, snapshot.runId, snapshot.journeyVersion)!;
}

export function completeSelectionJourneyNarration(input: {
  outboxId: string;
  journeyId: string;
  userId: string;
  runId: string;
  journeyVersion: number;
  factsHash: string;
  leaseUntil: string;
  expectedRevision: number;
  snapshot: SelectionJourneySnapshot;
  completedAt: Date;
}): SelectionJourneyRecord | null {
  const snapshot = selectionJourneySnapshotSchema.parse(input.snapshot);
  if (
    snapshot.runId !== input.runId
    || snapshot.journeyVersion !== input.journeyVersion
    || snapshot.revision !== input.expectedRevision + 1
  ) {
    throw new Error('Invalid narrated Journey revision');
  }
  const snapshotJson = JSON.stringify(snapshot);
  const completedAt = input.completedAt.toISOString();
  const deadlineCutoff = new Date(
    input.completedAt.getTime() - NARRATION_DEADLINE_MS
  ).toISOString();
  const expiresAt = new Date(
    Date.parse(snapshot.updatedAt) + JOURNEY_RETENTION_MS
  ).toISOString();
  const db = getDb();
  const transaction = db.transaction((): SelectionJourneyRecord | null => {
    const current = db.prepare(`
      SELECT id FROM selection_journeys
      WHERE id = ? AND user_id = ? AND run_id = ? AND journey_version = ?
        AND facts_hash = ? AND revision = ?
    `).get(
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedRevision
    );
    if (!current) return null;

    const completed = db.prepare(`
      UPDATE selection_narration_outbox
      SET status = 'completed', lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND journey_id = ? AND user_id = ? AND run_id = ?
        AND journey_version = ? AND facts_hash = ?
        AND status = 'processing' AND lease_until = ? AND lease_until > ?
        AND created_at > ?
    `).run(
      completedAt,
      completedAt,
      input.outboxId,
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.leaseUntil,
      completedAt,
      deadlineCutoff
    );
    if (completed.changes !== 1) return null;

    const updated = db.prepare(`
      UPDATE selection_journeys
      SET revision = ?, status = ?, snapshot_json = ?, updated_at = ?,
          completed_at = ?, expires_at = ?
      WHERE id = ? AND user_id = ? AND run_id = ? AND journey_version = ?
        AND facts_hash = ? AND revision = ?
    `).run(
      snapshot.revision,
      snapshot.status,
      snapshotJson,
      snapshot.updatedAt,
      snapshot.completedAt ?? null,
      expiresAt,
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedRevision
    );
    if (updated.changes !== 1) throw new Error('Narrated Journey revision changed');
    const replay = db.prepare(`
      UPDATE selection_replay_runs
      SET narration_status = 'succeeded',
          narration_deadline_at = COALESCE(narration_deadline_at, datetime(started_at, '+1 day'))
      WHERE user_id = ? AND run_id = ?
        AND narration_status IN ('not_applicable', 'pending')
    `).run(input.userId, input.runId);
    if (replay.changes !== 1) throw new Error('Narrated replay status changed');
    return getSelectionJourney(input.userId, input.runId, input.journeyVersion);
  });
  return transaction.immediate();
}

export function completePersistedSelectionJourneyNarration(input: {
  outboxId: string;
  journeyId: string;
  userId: string;
  runId: string;
  journeyVersion: number;
  factsHash: string;
  leaseUntil: string;
  expectedRevision: number;
  completedAt: Date;
}): SelectionJourneyRecord | null {
  const completedAt = input.completedAt.toISOString();
  const deadlineCutoff = new Date(
    input.completedAt.getTime() - NARRATION_DEADLINE_MS
  ).toISOString();
  const db = getDb();
  const transaction = db.transaction((): SelectionJourneyRecord | null => {
    const row = db.prepare(`
      SELECT * FROM selection_journeys
      WHERE id = ? AND user_id = ? AND run_id = ? AND journey_version = ?
        AND facts_hash = ? AND revision = ?
    `).get(
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedRevision
    ) as SelectionJourneyRow | undefined;
    if (!row) return null;
    const journey = mapRow(row);
    if (journey.snapshot.narration.status !== 'polished') return null;

    const completed = db.prepare(`
      UPDATE selection_narration_outbox
      SET status = 'completed', lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND journey_id = ? AND user_id = ? AND run_id = ?
        AND journey_version = ? AND facts_hash = ?
        AND status = 'processing' AND lease_until = ? AND lease_until > ?
        AND created_at > ?
    `).run(
      completedAt,
      completedAt,
      input.outboxId,
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.leaseUntil,
      completedAt,
      deadlineCutoff
    );
    if (completed.changes !== 1) return null;

    const replay = db.prepare(`
      UPDATE selection_replay_runs
      SET narration_status = 'succeeded',
          narration_deadline_at = COALESCE(narration_deadline_at, datetime(started_at, '+1 day'))
      WHERE user_id = ? AND run_id = ?
        AND narration_status IN ('not_applicable', 'pending')
    `).run(input.userId, input.runId);
    if (replay.changes !== 1) throw new Error('Narrated replay status changed');
    return journey;
  });
  return transaction.immediate();
}

export function failSelectionJourneyNarrationTerminal(input: {
  outboxId: string;
  journeyId: string;
  userId: string;
  runId: string;
  journeyVersion: number;
  factsHash: string;
  expectedOutboxStatus: 'pending' | 'processing';
  expectedAttemptCount: number;
  expectedLeaseUntil: string | null;
  expectedRevision: number;
  snapshot: SelectionJourneySnapshot;
  errorCode: string;
  terminalCause: 'failure' | 'expiration';
  failedAt: Date;
}): SelectionJourneyRecord | null {
  const snapshot = selectionJourneySnapshotSchema.parse(input.snapshot);
  if (
    snapshot.runId !== input.runId
    || snapshot.journeyVersion !== input.journeyVersion
    || snapshot.revision !== input.expectedRevision + 1
    || snapshot.narration.status !== 'failed'
  ) {
    throw new Error('Invalid failed Journey revision');
  }
  const failedAt = input.failedAt.toISOString();
  const deadlineCutoff = new Date(
    input.failedAt.getTime() - NARRATION_DEADLINE_MS
  ).toISOString();
  const expiresAt = new Date(
    Date.parse(snapshot.updatedAt) + JOURNEY_RETENTION_MS
  ).toISOString();
  const db = getDb();
  const transaction = db.transaction((): SelectionJourneyRecord | null => {
    const current = db.prepare(`
      SELECT id FROM selection_journeys
      WHERE id = ? AND user_id = ? AND run_id = ? AND journey_version = ?
        AND facts_hash = ? AND revision = ?
        AND json_extract(snapshot_json, '$.narration.status') = 'pending'
    `).get(
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedRevision
    );
    if (!current) return null;

    const terminalEligibility = input.terminalCause === 'failure'
      ? `status = 'processing' AND lease_until IS NOT NULL AND lease_until > ?
          AND attempt_count >= ${NARRATION_MAX_ATTEMPTS}`
      : `(created_at <= ? OR (
          status = 'processing' AND attempt_count >= ${NARRATION_MAX_ATTEMPTS}
          AND lease_until IS NOT NULL AND lease_until <= ?
        ))`;
    const terminalArgs = input.terminalCause === 'failure'
      ? [failedAt]
      : [deadlineCutoff, failedAt];
    const outbox = db.prepare(`
      UPDATE selection_narration_outbox
      SET status = 'dead', lease_until = NULL, last_error = ?,
          updated_at = ?, completed_at = ?
      WHERE id = ? AND journey_id = ? AND user_id = ? AND run_id = ?
        AND journey_version = ? AND facts_hash = ?
        AND status = ? AND attempt_count = ?
        AND COALESCE(lease_until, '') = COALESCE(?, '')
        AND ${terminalEligibility}
    `).run(
      input.errorCode,
      failedAt,
      failedAt,
      input.outboxId,
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedOutboxStatus,
      input.expectedAttemptCount,
      input.expectedLeaseUntil,
      ...terminalArgs
    );
    if (outbox.changes !== 1) return null;

    const updated = db.prepare(`
      UPDATE selection_journeys
      SET revision = ?, status = ?, snapshot_json = ?, updated_at = ?,
          completed_at = ?, expires_at = ?
      WHERE id = ? AND user_id = ? AND run_id = ? AND journey_version = ?
        AND facts_hash = ? AND revision = ?
        AND json_extract(snapshot_json, '$.narration.status') = 'pending'
    `).run(
      snapshot.revision,
      snapshot.status,
      JSON.stringify(snapshot),
      snapshot.updatedAt,
      snapshot.completedAt ?? null,
      expiresAt,
      input.journeyId,
      input.userId,
      input.runId,
      input.journeyVersion,
      input.factsHash,
      input.expectedRevision
    );
    if (updated.changes !== 1) throw new Error('Failed Journey revision changed');

    const replay = db.prepare(`
      UPDATE selection_replay_runs
      SET narration_status = 'failed',
          narration_deadline_at = COALESCE(narration_deadline_at, ?)
      WHERE user_id = ? AND run_id = ?
        AND narration_status IN ('not_applicable', 'pending')
    `).run(failedAt, input.userId, input.runId);
    if (replay.changes !== 1) throw new Error('Failed replay status changed');
    return getSelectionJourney(input.userId, input.runId, input.journeyVersion);
  });
  return transaction.immediate();
}

export function getSelectionJourney(
  userId: string,
  runId: string,
  journeyVersion = 1
): SelectionJourneyRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM selection_journeys
    WHERE user_id = ? AND run_id = ? AND journey_version = ?
  `).get(userId, runId, journeyVersion) as SelectionJourneyRow | undefined;
  return row ? mapRow(row) : null;
}

export function getLatestSelectionJourney(
  userId: string,
  runId: string
): SelectionJourneyRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM selection_journeys
    WHERE user_id = ? AND run_id = ?
    ORDER BY journey_version DESC
    LIMIT 1
  `).get(userId, runId) as SelectionJourneyRow | undefined;
  return row ? mapRow(row) : null;
}

export function listRecentSelectionJourneys(
  userId: string,
  options: { now?: string; windowMs?: number; limit?: number } = {}
): SelectionJourneyRecord[] {
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - (options.windowMs ?? DEFAULT_HISTORY_MS)).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const rows = getDb().prepare(`
    SELECT journey.* FROM selection_journeys AS journey
    WHERE journey.user_id = ?
      AND julianday(journey.started_at) >= julianday(?)
      AND julianday(journey.started_at) <= julianday(?)
      AND journey.journey_version = (
        SELECT MAX(candidate.journey_version)
        FROM selection_journeys AS candidate
        WHERE candidate.user_id = journey.user_id
          AND candidate.run_id = journey.run_id
      )
    ORDER BY julianday(journey.started_at) DESC, journey.run_id DESC
    LIMIT ?
  `).all(userId, cutoff, now, limit) as SelectionJourneyRow[];
  return rows.map(mapRow);
}

export function cleanupSelectionJourneys(now = new Date().toISOString()): number {
  return getDb().prepare(
    `DELETE FROM selection_journeys WHERE expires_at <= ?`
  ).run(now).changes;
}

type SelectionJourneyRow = {
  id: string;
  user_id: string;
  facts_hash: string;
  snapshot_json: string;
  expires_at: string;
};

function mapRow(row: SelectionJourneyRow): SelectionJourneyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    factsHash: row.facts_hash,
    snapshot: selectionJourneySnapshotSchema.parse(JSON.parse(row.snapshot_json)),
    expiresAt: row.expires_at
  };
}
