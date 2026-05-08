import { getDb } from './db.js';

export type UserRow = {
  ncm_id: string;
  ncm_cookie: string;
  profile_json: string | null;
  created_at: string;
  last_seen_at: string;
};

export function upsertUser(params: {
  ncmId: string;
  encryptedCookie: string;
  profileJson: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (ncm_id, ncm_cookie, profile_json, created_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(ncm_id) DO UPDATE SET
       ncm_cookie   = excluded.ncm_cookie,
       profile_json = excluded.profile_json,
       last_seen_at = datetime('now')`
  ).run(params.ncmId, params.encryptedCookie, params.profileJson);
}

export function getUserById(ncmId: string): UserRow | null {
  const db = getDb();
  return (
    db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE ncm_id = ?')
      .get(ncmId) ?? null
  );
}

export function deleteUser(ncmId: string): void {
  getDb().prepare('DELETE FROM users WHERE ncm_id = ?').run(ncmId);
}

export function getAllUsers(): UserRow[] {
  return getDb().prepare<[], UserRow>('SELECT * FROM users').all();
}

export function recordBlockedAttempt(params: {
  ncmId: string;
  profileJson: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO blocked_login_attempts (ncm_id, profile_json) VALUES (?, ?)`
    )
    .run(params.ncmId, params.profileJson);
}

export type BlockedAttempt = {
  id: number;
  ncm_id: string;
  profile_json: string | null;
  attempted_at: string;
};

export function getBlockedAttempts(): BlockedAttempt[] {
  return getDb()
    .prepare<[], BlockedAttempt>(
      'SELECT * FROM blocked_login_attempts ORDER BY attempted_at DESC'
    )
    .all();
}

export function deleteBlockedAttempt(id: number): void {
  getDb().prepare('DELETE FROM blocked_login_attempts WHERE id = ?').run(id);
}

export function deleteBlockedAttemptsByNcmId(ncmId: string): void {
  getDb()
    .prepare('DELETE FROM blocked_login_attempts WHERE ncm_id = ?')
    .run(ncmId);
}
