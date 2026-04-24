import { getDb } from './db.js';

export function getPref<T>(key: string): T | null {
  const db = getDb();
  const row = db
    .prepare<[string], { value_json: string }>('SELECT value_json FROM prefs WHERE key = ?')
    .get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setPref(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO prefs (key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value));
}

export function deletePref(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM prefs WHERE key = ?').run(key);
}
