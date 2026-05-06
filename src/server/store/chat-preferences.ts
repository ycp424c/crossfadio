import { getDb } from './db.js';

export type ChatPreference = {
  id: number;
  summary: string;
  message_ids: string;
  created_at: string;
};

export function saveChatPreference(userId: string, summary: string, messageIds: number[]): number {
  const result = getDb()
    .prepare(
      `INSERT INTO chat_preferences (user_id, summary, message_ids, created_at) VALUES (?, ?, ?, datetime('now'))`
    )
    .run(userId, summary, JSON.stringify(messageIds));
  return Number(result.lastInsertRowid);
}

export function getLatestPreferences(userId: string, limit = 5): ChatPreference[] {
  return getDb()
    .prepare<[string, number], ChatPreference>(
      `SELECT id, summary, message_ids, created_at FROM chat_preferences
       WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit);
}

export function getPreferenceContext(userId: string, limit = 3): string {
  const prefs = getLatestPreferences(userId, limit);
  if (prefs.length === 0) return '';
  return prefs
    .reverse()
    .map((p) => p.summary)
    .join('\n---\n');
}
