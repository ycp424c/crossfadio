import { getDb } from './db.js';

export type UserAccessStatus = 'active' | 'suspended';

export type SuspendedUserRecord = {
  userId: string;
  updatedAt: string;
};

type UserAccessControlRow = {
  user_id: string;
  status: UserAccessStatus;
  updated_at: string;
};

/**
 * Persistent safety status independent of priority membership. Missing rows
 * default to active so existing installs keep working without backfills.
 */
export function getUserAccessStatus(userId: string): UserAccessStatus {
  const row = getDb()
    .prepare<[string], UserAccessControlRow>(
      'SELECT * FROM user_access_controls WHERE user_id = ?'
    )
    .get(userId);
  return row?.status === 'suspended' ? 'suspended' : 'active';
}

export function setUserAccessStatus(userId: string, status: UserAccessStatus): void {
  getDb()
    .prepare(
      `INSERT INTO user_access_controls (user_id, status, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         status     = excluded.status,
         updated_at = datetime('now')`
    )
    .run(userId, status);
}

export function listSuspendedUsers(): SuspendedUserRecord[] {
  const rows = getDb()
    .prepare<[], UserAccessControlRow>(
      `SELECT * FROM user_access_controls WHERE status = 'suspended' ORDER BY updated_at DESC`
    )
    .all();
  return rows.map((row) => ({ userId: row.user_id, updatedAt: row.updated_at }));
}
