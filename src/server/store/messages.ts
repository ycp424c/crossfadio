import { getDb } from './db.js';
import type { AgentMessage } from '../agent/schema.js';

export type StoredMessage = {
  id: number;
  role: string;
  content: string;
  created_at: string;
  extracted_at: string | null;
};

export function saveMessage(role: 'user' | 'assistant', content: string): number {
  const db = getDb();
  const result = db
    .prepare<[string, string]>(
      `INSERT INTO messages (role, content, created_at) VALUES (?, ?, datetime('now'))`
    )
    .run(role, content);
  return Number(result.lastInsertRowid);
}

/** Returns the most recent messages, optionally limited to those within the last `withinMinutes`. */
export function getRecentMessages(limit = 20, withinMinutes?: number): AgentMessage[] {
  const db = getDb();
  let rows: StoredMessage[];

  if (withinMinutes !== undefined) {
    rows = db
      .prepare<[number, number], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages
         WHERE created_at >= datetime('now', ? || ' minutes')
         ORDER BY id DESC LIMIT ?`
      )
      .all(-withinMinutes, limit)
      .reverse();
  } else {
    rows = db
      .prepare<[number], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages ORDER BY id DESC LIMIT ?`
      )
      .all(limit)
      .reverse();
  }

  return rows.map((r) => ({
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content
  }));
}

/** Returns unextracted messages (extracted_at IS NULL), oldest first. */
export function getUnextractedMessages(): StoredMessage[] {
  const db = getDb();
  return db
    .prepare<[], StoredMessage>(
      `SELECT id, role, content, created_at, extracted_at FROM messages
       WHERE extracted_at IS NULL ORDER BY id ASC`
    )
    .all();
}

/** Marks the given message IDs as extracted. */
export function markMessagesExtracted(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`UPDATE messages SET extracted_at = datetime('now') WHERE id IN (${placeholders})`)
    .run(...ids);
}
