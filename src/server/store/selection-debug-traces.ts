import { randomUUID } from 'node:crypto';
import {
  selectionDecisionTraceSchema,
  type SelectionDecisionTrace
} from '../../shared/selection.js';
import { getDb } from './db.js';

const DEBUG_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SelectionDebugTraceRecord = {
  id: string;
  userId: string;
  runId: string;
  schemaVersion: number;
  trace: SelectionDecisionTrace;
  createdAt: string;
  expiresAt: string;
};

export function saveSelectionDebugTrace(input: {
  userId: string;
  trace: SelectionDecisionTrace;
  createdAt?: Date;
}): SelectionDebugTraceRecord {
  const trace = selectionDecisionTraceSchema.parse(input.trace);
  const createdAt = (input.createdAt ?? new Date(trace.createdAt)).toISOString();
  const expiresAt = new Date(
    Date.parse(createdAt) + DEBUG_TRACE_RETENTION_MS
  ).toISOString();
  const db = getDb();
  db.prepare(`
    INSERT INTO selection_debug_traces (
      id, user_id, run_id, schema_version, trace_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, run_id, schema_version)
    DO UPDATE SET trace_json = excluded.trace_json,
                  created_at = excluded.created_at,
                  expires_at = excluded.expires_at
  `).run(
    randomUUID(),
    input.userId,
    trace.runId,
    trace.schemaVersion,
    JSON.stringify(trace),
    createdAt,
    expiresAt
  );
  return getSelectionDebugTrace(input.userId, trace.runId, {
    schemaVersion: trace.schemaVersion,
    now: new Date(createdAt)
  })!;
}

export function getSelectionDebugTrace(
  userId: string,
  runId: string,
  options: { now?: Date; schemaVersion?: number } = {}
): SelectionDebugTraceRecord | null {
  const now = (options.now ?? new Date()).toISOString();
  const row = options.schemaVersion === undefined
    ? getDb().prepare(`
        SELECT * FROM selection_debug_traces
        WHERE user_id = ? AND run_id = ? AND expires_at > ?
        ORDER BY schema_version DESC
        LIMIT 1
      `).get(userId, runId, now) as SelectionDebugTraceRow | undefined
    : getDb().prepare(`
        SELECT * FROM selection_debug_traces
        WHERE user_id = ? AND run_id = ? AND schema_version = ? AND expires_at > ?
      `).get(userId, runId, options.schemaVersion, now) as SelectionDebugTraceRow | undefined;
  return row ? mapRow(row) : null;
}

export function deleteExpiredSelectionDebugTraces(now: Date = new Date()): number {
  return getDb().prepare(
    `DELETE FROM selection_debug_traces WHERE expires_at <= ?`
  ).run(now.toISOString()).changes;
}

export const cleanupSelectionDebugTraces = deleteExpiredSelectionDebugTraces;

type SelectionDebugTraceRow = {
  id: string;
  user_id: string;
  run_id: string;
  schema_version: number;
  trace_json: string;
  created_at: string;
  expires_at: string;
};

function mapRow(row: SelectionDebugTraceRow): SelectionDebugTraceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    schemaVersion: row.schema_version,
    trace: selectionDecisionTraceSchema.parse(JSON.parse(row.trace_json)),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
