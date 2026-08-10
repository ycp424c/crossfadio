import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import {
  getUserAccessStatus,
  setUserAccessStatus,
  listSuspendedUsers
} from '../../src/server/store/user-access-controls';
import { upsertUser, getUserById } from '../../src/server/store/users';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-access-controls-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('user access controls store', () => {
  it('defaults missing rows to active', () => {
    expect(getUserAccessStatus('unknown-user')).toBe('active');
  });

  it('suspends and reactivates idempotently', () => {
    setUserAccessStatus('user-1', 'suspended');
    setUserAccessStatus('user-1', 'suspended');
    expect(getUserAccessStatus('user-1')).toBe('suspended');

    setUserAccessStatus('user-1', 'active');
    setUserAccessStatus('user-1', 'active');
    expect(getUserAccessStatus('user-1')).toBe('active');
  });

  it('survives a DB close and reopen', () => {
    setUserAccessStatus('user-1', 'suspended');
    _resetDbForTest();
    initDb();

    expect(getUserAccessStatus('user-1')).toBe('suspended');
  });

  it('lists suspended users with their updated timestamp', () => {
    setUserAccessStatus('user-1', 'suspended');
    setUserAccessStatus('user-2', 'suspended');

    const suspended = listSuspendedUsers();
    expect(suspended.map((entry) => entry.userId).sort()).toEqual(['user-1', 'user-2']);
    expect(suspended[0]?.updatedAt).toEqual(expect.any(String));
  });

  it('does not include reactivated users in the suspended list', () => {
    setUserAccessStatus('user-1', 'suspended');
    setUserAccessStatus('user-1', 'active');

    expect(listSuspendedUsers()).toEqual([]);
  });

  it('reactivation does not delete user data or change priority membership', () => {
    upsertUser({ ncmId: 'user-1', encryptedCookie: 'enc', profileJson: null });
    setUserAccessStatus('user-1', 'suspended');
    setUserAccessStatus('user-1', 'active');

    expect(getUserById('user-1')).not.toBeNull();
  });
});
