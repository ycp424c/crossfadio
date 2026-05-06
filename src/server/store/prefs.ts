import { getDb } from './db.js';

export function getPref<T>(userId: string, key: string): T | null {
  const db = getDb();
  const row = db
    .prepare<[string, string], { value_json: string }>(
      'SELECT value_json FROM prefs WHERE user_id = ? AND key = ?'
    )
    .get(userId, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setPref(userId: string, key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO prefs (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(userId, key, JSON.stringify(value));
}

export function deletePref(userId: string, key: string): void {
  getDb().prepare('DELETE FROM prefs WHERE user_id = ? AND key = ?').run(userId, key);
}
