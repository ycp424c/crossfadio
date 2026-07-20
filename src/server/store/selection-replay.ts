import { randomUUID } from 'node:crypto';
import type { SelectionPolicyReplayCase } from '../music-agent/selection-policy/replay-case.js';
import type {
  SelectionPolicyReplayContext
} from '../music-agent/selection-policy/replay-case.js';
import type { SelectionPolicyMode } from '../music-agent/selection-policy/types.js';
import type { SelectionPhaseDecision } from '../music-agent/selection-policy/types.js';
import type { PromptJsonStatus } from '../music-agent/schema.js';
import { getDb } from './db.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function recordSelectionPolicyReplayCases(input: {
  userId: string;
  runId: string;
  mode: SelectionPolicyMode;
  cases: SelectionPolicyReplayCase[];
  createdAt?: string;
}): void {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + RETENTION_MS).toISOString();
  const statement = getDb().prepare(`
    INSERT INTO selection_policy_replay_cases (
      id, user_id, run_id, candidate_id, candidate_track_key, candidate_artist_key,
      mode, identity_valid, source, quality_signals_json, title_motif_keys_json,
      base_score, batch_index, batch_limit, context_json, pressure_json,
      expected_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, run_id, candidate_id) DO UPDATE SET
      candidate_track_key = excluded.candidate_track_key,
      candidate_artist_key = excluded.candidate_artist_key,
      mode = excluded.mode,
      identity_valid = excluded.identity_valid,
      source = excluded.source,
      quality_signals_json = excluded.quality_signals_json,
      title_motif_keys_json = excluded.title_motif_keys_json,
      base_score = excluded.base_score,
      batch_index = excluded.batch_index,
      batch_limit = excluded.batch_limit,
      context_json = excluded.context_json,
      pressure_json = excluded.pressure_json,
      expected_json = excluded.expected_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  getDb().transaction(() => {
    for (const replayCase of input.cases) {
      statement.run(
        randomUUID(), input.userId, input.runId, replayCase.candidateId,
        replayCase.candidateTrackKey, replayCase.candidateArtistKey, input.mode,
        replayCase.identityValid ? 1 : 0, replayCase.source,
        JSON.stringify(replayCase.qualitySignals), JSON.stringify(replayCase.titleMotifKeys),
        replayCase.baseScore, replayCase.batchIndex, replayCase.batchLimit,
        JSON.stringify(replayCase.context), JSON.stringify(replayCase.pressure),
        JSON.stringify(replayCase.expected), createdAt, expiresAt
      );
    }
  })();
}

export function finalizeSelectionPolicyReplayCases(input: {
  userId: string;
  runId: string;
  decisions: Array<{
    candidateId: string;
    decision: SelectionPhaseDecision;
    replayContext?: SelectionPolicyReplayContext;
  }>;
}): void {
  const select = getDb().prepare(`
    SELECT expected_json AS expectedJson
    FROM selection_policy_replay_cases
    WHERE user_id = ? AND run_id = ? AND candidate_id = ?
  `);
  const update = getDb().prepare(`
    UPDATE selection_policy_replay_cases
    SET expected_json = ?
    WHERE user_id = ? AND run_id = ? AND candidate_id = ?
  `);
  getDb().transaction(() => {
    for (const item of input.decisions) {
      // queue_target_reached and other non-evaluated terminal bookkeeping do
      // not have a replayable live Final context and must remain Final=null.
      if (!item.replayContext) continue;
      const row = select.get(input.userId, input.runId, item.candidateId) as {
        expectedJson: string;
      } | undefined;
      if (!row) continue;
      const expected = JSON.parse(row.expectedJson) as SelectionPolicyReplayCase['expected'];
      expected.final = {
        action: item.decision.action,
        reasonCodes: [...item.decision.reasonCodes]
      };
      expected.finalContext = item.replayContext;
      update.run(
        JSON.stringify(expected),
        input.userId,
        input.runId,
        item.candidateId
      );
    }
  })();
}

export function recordSelectionReplayRun(input: {
  userId: string;
  runId: string;
  selectedTrackIds: string[];
  candidateCount: number;
  eligibleCount: number;
  appendedCount: number;
  latencyMs: number;
  hardViolationCount: number;
  promptJsonStatus: PromptJsonStatus;
  journeyPublished: boolean;
  outcome: 'succeeded' | 'failed' | 'empty' | 'superseded';
  reasonCodes: string[];
  startedAt: string;
  completedAt?: string | null;
}): void {
  const completedAt = input.completedAt === undefined ? new Date().toISOString() : input.completedAt;
  const expiresAt = new Date(Date.parse(input.startedAt) + RETENTION_MS).toISOString();
  const narrationApplicable = input.appendedCount > 0 && input.outcome === 'succeeded';
  const narrationStatus = narrationApplicable ? 'pending' : 'not_applicable';
  const narrationDeadlineAt = narrationApplicable
    ? new Date(Date.parse(input.startedAt) + 24 * 60 * 60 * 1_000).toISOString()
    : null;
  getDb().prepare(`
    INSERT INTO selection_replay_runs (
      id, user_id, run_id, selected_track_ids_json, candidate_count,
      eligible_count, appended_count, latency_ms, hard_violation_count,
      prompt_json_status, journey_published, narration_status, narration_deadline_at,
      outcome, reason_codes_json, started_at, completed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, run_id) DO UPDATE SET
      selected_track_ids_json = excluded.selected_track_ids_json,
      candidate_count = excluded.candidate_count,
      eligible_count = excluded.eligible_count,
      appended_count = excluded.appended_count,
      latency_ms = excluded.latency_ms,
      hard_violation_count = excluded.hard_violation_count,
      prompt_json_status = excluded.prompt_json_status,
      journey_published = excluded.journey_published,
      narration_status = CASE
        WHEN excluded.appended_count = 0 OR excluded.outcome != 'succeeded'
          THEN 'not_applicable'
        WHEN selection_replay_runs.narration_status IN ('succeeded', 'failed')
          THEN selection_replay_runs.narration_status
        ELSE excluded.narration_status
      END,
      narration_deadline_at = excluded.narration_deadline_at,
      outcome = excluded.outcome,
      reason_codes_json = excluded.reason_codes_json,
      completed_at = excluded.completed_at,
      expires_at = excluded.expires_at
  `).run(
    randomUUID(), input.userId, input.runId, JSON.stringify(input.selectedTrackIds),
    input.candidateCount, input.eligibleCount, input.appendedCount, input.latencyMs,
    input.hardViolationCount, input.promptJsonStatus,
    input.journeyPublished ? 1 : 0, narrationStatus, narrationDeadlineAt, input.outcome,
    JSON.stringify([...new Set(input.reasonCodes)]), input.startedAt, completedAt, expiresAt
  );
}

export function markSelectionReplayNarrationSucceeded(input: {
  userId: string;
  runId: string;
  polishedAt: string;
}): void {
  getDb().prepare(`
    UPDATE selection_replay_runs
    SET narration_status = CASE
      WHEN julianday(?) < julianday(COALESCE(narration_deadline_at, datetime(started_at, '+1 day')))
        THEN 'succeeded' ELSE 'failed' END,
        narration_deadline_at = COALESCE(narration_deadline_at, datetime(started_at, '+1 day'))
    WHERE user_id = ? AND run_id = ?
  `).run(input.polishedAt, input.userId, input.runId);
}

export function markSelectionReplayNarrationFailed(input: {
  userId: string;
  runId: string;
  failedAt: string;
}): void {
  getDb().prepare(`
    UPDATE selection_replay_runs
    SET narration_status = 'failed',
        narration_deadline_at = COALESCE(narration_deadline_at, ?)
    WHERE user_id = ? AND run_id = ?
      AND narration_status IN ('not_applicable', 'pending')
  `).run(input.failedAt, input.userId, input.runId);
}

export function cleanupSelectionReplay(now = new Date().toISOString()): number {
  const db = getDb();
  return db.transaction(() => (
    db.prepare('DELETE FROM selection_policy_replay_cases WHERE expires_at <= ?').run(now).changes
    + db.prepare('DELETE FROM selection_replay_runs WHERE expires_at <= ?').run(now).changes
  ))();
}
