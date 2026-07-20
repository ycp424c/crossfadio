import { getDb } from './db.js';

export type MusicEntityIndexSource = 'liked' | 'listening_episodes' | 'play_start' | 'embedding';

export type MusicEntityIndexStateRecord = {
  userId: string;
  source: string;
  cursor: string;
  lastRunAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

type MusicEntityIndexStateRow = {
  user_id: string;
  source: string;
  cursor: string;
  last_run_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export function getMusicEntityIndexState(userId: string, source: string): MusicEntityIndexStateRecord | null {
  const normalizedUserId = userId.trim();
  const normalizedSource = source.trim();
  if (!normalizedUserId || !normalizedSource) return null;

  const row = getDb().prepare<[string, string], MusicEntityIndexStateRow>(
    `SELECT *
     FROM music_entity_index_state
     WHERE user_id = ? AND source = ?`
  ).get(normalizedUserId, normalizedSource);
  return row ? musicEntityIndexStateFromRow(row) : null;
}

export function recordMusicEntityIndexSuccess(input: {
  userId: string;
  source: string;
  cursor?: string;
  ranAt?: string;
}): void {
  const userId = input.userId.trim();
  const source = input.source.trim();
  if (!userId || !source) return;

  getDb().prepare(
    `INSERT INTO music_entity_index_state (
       user_id, source, cursor, last_run_at, last_error, updated_at
     )
     VALUES (?, ?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(user_id, source) DO UPDATE SET
       cursor = excluded.cursor,
       last_run_at = excluded.last_run_at,
       last_error = NULL,
       updated_at = datetime('now')`
  ).run(userId, source, input.cursor?.trim() ?? '', input.ranAt ?? new Date().toISOString());
}

export function recordMusicEntityIndexError(input: {
  userId: string;
  source: string;
  error: string;
  ranAt?: string;
}): void {
  const userId = input.userId.trim();
  const source = input.source.trim();
  if (!userId || !source) return;

  getDb().prepare(
    `INSERT INTO music_entity_index_state (
       user_id, source, cursor, last_run_at, last_error, updated_at
     )
     VALUES (?, ?, '', ?, ?, datetime('now'))
     ON CONFLICT(user_id, source) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_error = excluded.last_error,
       updated_at = datetime('now')`
  ).run(userId, source, input.ranAt ?? new Date().toISOString(), input.error.trim());
}

function musicEntityIndexStateFromRow(row: MusicEntityIndexStateRow): MusicEntityIndexStateRecord {
  return {
    userId: row.user_id,
    source: row.source,
    cursor: row.cursor,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}
