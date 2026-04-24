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

export function startPlay(input: StartPlayInput): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO plays (song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(input.songId, input.songName, input.artistName);
  return Number(result.lastInsertRowid);
}

export function endPlay(id: number, reason: EndReason): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE plays SET ended_at = datetime('now'), end_reason = ?
       WHERE id = ? AND ended_at IS NULL`
    )
    .run(reason, id);
  return result.changes > 0;
}

export function getRecentPlays(limit = 50): PlayRecord[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM plays ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as PlayRecord[];
}
