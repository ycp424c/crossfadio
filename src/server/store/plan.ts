import { getDb } from './db.js';
import type { PlanOutput } from '../agent/schema.js';

export function savePlan(userId: string, plan: PlanOutput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO plan (user_id, plan_date, version, payload_json, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM plan WHERE user_id = ? AND plan_date = ?), ?, datetime('now'))
     ON CONFLICT(user_id, plan_date, version) DO NOTHING`
  ).run(userId, plan.date, userId, plan.date, JSON.stringify(plan));
}

export function loadLatestPlan(userId: string, date: string): PlanOutput | null {
  const db = getDb();
  const row = db
    .prepare<[string, string], { payload_json: string }>(
      `SELECT payload_json FROM plan WHERE user_id = ? AND plan_date = ? ORDER BY version DESC LIMIT 1`
    )
    .get(userId, date);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as PlanOutput;
  } catch {
    return null;
  }
}

export function todayDateStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
