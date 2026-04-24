import { getDb } from './db.js';
import type { AgentMessage } from '../agent/schema.js';

export type StoredMessage = {
  id: number;
  role: string;
  content: string;
  created_at: string;
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

export function getRecentMessages(limit = 20): AgentMessage[] {
  const db = getDb();
  const rows = db
    .prepare<[number], StoredMessage>(
      `SELECT id, role, content, created_at FROM messages ORDER BY id DESC LIMIT ?`
    )
    .all(limit)
    .reverse();

  return rows.map((r) => ({
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content
  }));
}
