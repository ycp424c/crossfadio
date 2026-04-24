import { getDb } from './db.js';
import type { PlanOutput } from '../agent/schema.js';

export function savePlan(plan: PlanOutput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO plan (plan_date, version, payload_json, created_at)
     VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM plan WHERE plan_date = ?), ?, datetime('now'))
     ON CONFLICT(plan_date, version) DO NOTHING`
  ).run(plan.date, plan.date, JSON.stringify(plan));
}

export function loadLatestPlan(date: string): PlanOutput | null {
  const db = getDb();
  const row = db
    .prepare<[string], { payload_json: string }>(
      `SELECT payload_json FROM plan WHERE plan_date = ? ORDER BY version DESC LIMIT 1`
    )
    .get(date);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as PlanOutput;
  } catch {
    return null;
  }
}

export function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}
