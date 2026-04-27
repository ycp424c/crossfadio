import { getDb } from './db.js';

export type ChatPreference = {
  id: number;
  summary: string;
  message_ids: string;
  created_at: string;
};

export function saveChatPreference(summary: string, messageIds: number[]): number {
  const db = getDb();
  const result = db
    .prepare(`INSERT INTO chat_preferences (summary, message_ids, created_at) VALUES (?, ?, datetime('now'))`)
    .run(summary, JSON.stringify(messageIds));
  return Number(result.lastInsertRowid);
}

/** Returns the most recent preference summaries, newest first. */
export function getLatestPreferences(limit = 5): ChatPreference[] {
  const db = getDb();
  return db
    .prepare<[number], ChatPreference>(
      `SELECT id, summary, message_ids, created_at FROM chat_preferences ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

/** Returns a combined text of recent preference summaries for injection into agent context. */
export function getPreferenceContext(limit = 3): string {
  const prefs = getLatestPreferences(limit);
  if (prefs.length === 0) return '';
  return prefs
    .reverse()
    .map((p) => p.summary)
    .join('\n---\n');
}
