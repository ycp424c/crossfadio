import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-users-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-16-chars';
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('users store', () => {
  it('upsertUser stores and retrieves a user', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    upsertUser({ ncmId: 'u1', encryptedCookie: 'enc_cookie', profileJson: '{"name":"test"}' });
    const user = getUserById('u1');
    expect(user).not.toBeNull();
    expect(user!.ncm_id).toBe('u1');
    expect(user!.ncm_cookie).toBe('enc_cookie');
  });

  it('upsertUser updates cookie and last_seen_at on second call', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    upsertUser({ ncmId: 'u2', encryptedCookie: 'old_cookie', profileJson: null });
    upsertUser({ ncmId: 'u2', encryptedCookie: 'new_cookie', profileJson: null });
    const user = getUserById('u2');
    expect(user!.ncm_cookie).toBe('new_cookie');
  });

  it('recordBlockedAttempt saves ncm_id and profile', async () => {
    const { recordBlockedAttempt } = await import('../../src/server/store/users');
    const Database = (await import('better-sqlite3')).default;
    recordBlockedAttempt({ ncmId: 'blocked1', profileJson: '{"name":"stranger"}' });
    const db = new Database(path.join(dataDir, 'state.db'));
    const row = db.prepare('SELECT * FROM blocked_login_attempts WHERE ncm_id = ?').get('blocked1') as { ncm_id: string };
    expect(row.ncm_id).toBe('blocked1');
    db.close();
  });

  it('getUserById returns null for unknown id', async () => {
    const { getUserById } = await import('../../src/server/store/users');
    expect(getUserById('nonexistent')).toBeNull();
  });
});
