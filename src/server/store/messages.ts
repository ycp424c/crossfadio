import { getDb } from './db.js';
import type { AgentMessage } from '../agent/schema.js';

export type StoredMessage = {
  id: number;
  role: string;
  content: string;
  created_at: string;
  extracted_at: string | null;
};

export function saveMessage(userId: string, role: 'user' | 'assistant', content: string): number {
  const db = getDb();
  const result = db
    .prepare<[string, string, string]>(
      `INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, datetime('now'))`
    )
    .run(userId, role, content);
  return Number(result.lastInsertRowid);
}

export function getRecentMessages(userId: string, limit = 20, withinMinutes?: number): AgentMessage[] {
  const db = getDb();
  let rows: StoredMessage[];
  if (withinMinutes !== undefined) {
    rows = db
      .prepare<[string, number, number], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages
         WHERE user_id = ? AND created_at >= datetime('now', ? || ' minutes')
         ORDER BY id DESC LIMIT ?`
      )
      .all(userId, -withinMinutes, limit)
      .reverse();
  } else {
    rows = db
      .prepare<[string, number], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(userId, limit)
      .reverse();
  }
  return rows.map((r) => ({
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content,
    created_at: r.created_at
  }));
}

export function getUnextractedMessages(userId: string): StoredMessage[] {
  const db = getDb();
  return db
    .prepare<[string], StoredMessage>(
      `SELECT id, role, content, created_at, extracted_at FROM messages
       WHERE user_id = ? AND extracted_at IS NULL ORDER BY id ASC`
    )
    .all(userId);
}

export function markMessagesExtracted(userId: string, ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE messages SET extracted_at = datetime('now') WHERE user_id = ? AND id IN (${placeholders})`
  ).run(userId, ...ids);
}
