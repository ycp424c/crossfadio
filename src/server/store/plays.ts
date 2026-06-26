import { getDb } from './db.js';

export type PlayRecord = {
  id: number;
  song_id: string | null;
  song_name: string | null;
  artist_name: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
};

export type StartPlayInput = {
  songId: string;
  songName: string;
  artistName: string;
};

export type EndReason = 'completed' | 'skip' | 'error';

export function startPlay(userId: string, input: StartPlayInput): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(userId, input.songId, input.songName, input.artistName);
  return Number(result.lastInsertRowid);
}

export function endPlay(userId: string, id: number, reason: EndReason): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE plays SET ended_at = datetime('now'), end_reason = ?
       WHERE user_id = ? AND id = ? AND ended_at IS NULL`
    )
    .run(reason, userId, id);
  return result.changes > 0;
}

export function getRecentPlays(userId: string, limit = 50): PlayRecord[] {
  const db = getDb();
  return db
    .prepare<[string, number]>(
      `SELECT * FROM plays WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`
    )
    .all(userId, limit) as PlayRecord[];
}

export function getTodayPlayedSongIds(userId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare<[string]>(
      `SELECT DISTINCT song_id FROM plays
       WHERE user_id = ?
         AND song_id IS NOT NULL
         AND date(started_at, 'localtime') = date('now', 'localtime')
       ORDER BY song_id`
    )
    .all(userId) as Array<{ song_id: string }>;
  return rows.map((row) => row.song_id);
}

export function getTodayPlays(userId: string): PlayRecord[] {
  const db = getDb();
  return db
    .prepare<[string]>(
      `SELECT * FROM plays
       WHERE user_id = ?
         AND date(started_at, 'localtime') = date('now', 'localtime')
       ORDER BY started_at DESC, id DESC`
    )
    .all(userId) as PlayRecord[];
}
