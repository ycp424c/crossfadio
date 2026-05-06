import { getDb } from './db.js';

export type StoredSegue = {
  id: number;
  from_id: string | null;
  from_name: string | null;
  to_id: string | null;
  to_name: string | null;
  say: string;
  created_at: string;
};

export type SegueRecord = {
  fromName: string;
  toName: string;
  say: string;
  createdAt: string;
};

export function saveSegue(
  userId: string,
  params: { fromId: string; fromName?: string; toId: string; toName?: string; say: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO segues (user_id, from_id, from_name, to_id, to_name, say) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, params.fromId, params.fromName ?? null, params.toId, params.toName ?? null, params.say);
}

export function getRecentSegues(userId: string, limit = 10): SegueRecord[] {
  const rows = getDb()
    .prepare<[string, number], StoredSegue>(
      `SELECT id, from_id, from_name, to_id, to_name, say, created_at
       FROM segues WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit)
    .reverse();
  return rows.map((r) => ({
    fromName: r.from_name ?? r.from_id ?? '未知',
    toName: r.to_name ?? r.to_id ?? '未知',
    say: r.say.slice(0, 200),
    createdAt: r.created_at
  }));
}
