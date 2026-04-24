import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../../src/server/security';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalSecretKey = process.env.CROSSFADIO_SECRET_KEY;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-secrets-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_SECRET_KEY = 'unit-test-secret-key';
});

afterEach(() => {
  restoreEnv('CROSSFADIO_DATA_DIR', originalDataDir);
  restoreEnv('CROSSFADIO_SECRET_KEY', originalSecretKey);
});

describe('SecretStore', () => {
  it('does not persist secret values as plaintext', () => {
    const store = new SecretStore();

    store.set('ncm.cookie', 'MUSIC_U=abc;');

    const raw = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf-8');
    expect(raw).not.toContain('MUSIC_U=abc;');
    expect(new SecretStore().get('ncm.cookie')).toBe('MUSIC_U=abc;');
  });

  it('can read legacy plaintext secret files', () => {
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ 'ncm.cookie': 'MUSIC_U=legacy;' }));

    expect(new SecretStore().get('ncm.cookie')).toBe('MUSIC_U=legacy;');
  });

  it('migrates legacy unencrypted records to encrypted records', () => {
    fs.writeFileSync(
      path.join(dataDir, 'secrets.json'),
      JSON.stringify({ 'ncm.cookie': { encrypted: false, value: 'MUSIC_U=legacy-record;' } })
    );

    expect(new SecretStore().get('ncm.cookie')).toBe('MUSIC_U=legacy-record;');

    const raw = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf-8');
    expect(raw).not.toContain('MUSIC_U=legacy-record;');
    expect(JSON.parse(raw)['ncm.cookie']).toMatchObject({ encrypted: true, algorithm: 'aes-256-gcm' });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
