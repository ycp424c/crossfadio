import { randomUUID } from 'node:crypto';

import { getDb } from './db.js';

export type RetrievalRequestKind = 'autonomous' | 'explicit_request';

export type RetrievalAttemptEntry = {
  query: string;
  normalizedQuery: string;
  source: string;
  searchedCount: number;
  resultCount: number;
  addedCount: number;
  selectedCount: number;
};

export type RetrievalAttempt = RetrievalAttemptEntry & {
  id: string;
  userId: string;
  runId: string;
  requestKind: RetrievalRequestKind;
  displayQuery: string;
  attemptedAt: string;
};

type RetrievalAttemptRow = {
  id: string;
  user_id: string;
  run_id: string;
  source: string;
  request_kind: RetrievalRequestKind;
  normalized_query: string;
  display_query: string;
  searched_count: number;
  result_count: number;
  added_count: number;
  selected_count: number;
  attempted_at: string;
};

const POLICY_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export function appendRetrievalAttempts(input: {
  userId: string;
  runId: string;
  requestKind: RetrievalRequestKind;
  attemptedAt?: Date;
  entries: RetrievalAttemptEntry[];
}): number {
  const attemptedAt = (input.attemptedAt ?? new Date()).toISOString();
  const statement = getDb().prepare(`
    INSERT OR IGNORE INTO retrieval_attempts (
      id, user_id, run_id, source, request_kind, normalized_query, display_query,
      searched_count, result_count, added_count, selected_count, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = getDb().transaction(() => {
    let inserted = 0;
    for (const entry of input.entries) {
      const displayQuery = compactWhitespace(entry.query);
      const normalizedQuery = compactWhitespace(entry.normalizedQuery);
      if (!displayQuery || !normalizedQuery || entry.searchedCount <= 0) continue;
      inserted += statement.run(
        randomUUID(),
        input.userId,
        input.runId,
        entry.source,
        input.requestKind,
        normalizedQuery,
        displayQuery,
        nonNegativeInteger(entry.searchedCount),
        nonNegativeInteger(entry.resultCount),
        nonNegativeInteger(entry.addedCount),
        nonNegativeInteger(entry.selectedCount),
        attemptedAt,
      ).changes;
    }
    return inserted;
  });
  return transaction();
}

export function listRecentRetrievalAttempts(input: {
  userId: string;
  source?: string;
  now?: Date;
}): RetrievalAttempt[] {
  const cutoff = new Date((input.now ?? new Date()).getTime() - POLICY_WINDOW_MS).toISOString();
  const rows = input.source
    ? getDb().prepare<[string, string, string], RetrievalAttemptRow>(`
        SELECT * FROM retrieval_attempts
        WHERE user_id = ? AND source = ? AND attempted_at >= ?
        ORDER BY attempted_at DESC, id DESC
      `).all(input.userId, input.source, cutoff)
    : getDb().prepare<[string, string], RetrievalAttemptRow>(`
        SELECT * FROM retrieval_attempts
        WHERE user_id = ? AND attempted_at >= ?
        ORDER BY attempted_at DESC, id DESC
      `).all(input.userId, cutoff);
  return rows.map(toRetrievalAttempt);
}

export function deleteExpiredRetrievalAttempts(now = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS).toISOString();
  return getDb()
    .prepare('DELETE FROM retrieval_attempts WHERE attempted_at < ?')
    .run(cutoff).changes;
}

function toRetrievalAttempt(row: RetrievalAttemptRow): RetrievalAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    requestKind: row.request_kind,
    query: row.display_query,
    displayQuery: row.display_query,
    normalizedQuery: row.normalized_query,
    source: row.source,
    searchedCount: row.searched_count,
    resultCount: row.result_count,
    addedCount: row.added_count,
    selectedCount: row.selected_count,
    attemptedAt: row.attempted_at,
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(value));
}
