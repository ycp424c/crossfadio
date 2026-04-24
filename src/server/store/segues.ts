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

export function saveSegue(params: {
  fromId: string;
  fromName?: string;
  toId: string;
  toName?: string;
  say: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO segues (from_id, from_name, to_id, to_name, say) VALUES (?, ?, ?, ?, ?)`
  ).run(params.fromId, params.fromName ?? null, params.toId, params.toName ?? null, params.say);
}

export function getRecentSegues(limit = 10): SegueRecord[] {
  const db = getDb();
  const rows = db
    .prepare<[number], StoredSegue>(
      `SELECT id, from_id, from_name, to_id, to_name, say, created_at FROM segues ORDER BY id DESC LIMIT ?`
    )
    .all(limit)
    .reverse();

  return rows.map((r) => ({
    fromName: r.from_name ?? r.from_id ?? '未知',
    toName: r.to_name ?? r.to_id ?? '未知',
    say: r.say.slice(0, 200),
    createdAt: r.created_at
  }));
}
