import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ── ncmId validation (unit test of the schema) ──────────────────────────────────

describe('addToWhitelistBodySchema', () => {
  it('rejects empty string', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only input', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric string', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: 'abc123' });
    expect(result.success).toBe(false);
  });

  it('rejects string with leading/trailing spaces and non-numeric content', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: ' 123abc ' });
    expect(result.success).toBe(false);
  });

  it('accepts numeric string', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: '123456' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ncmId).toBe('123456');
    }
  });

  it('trims whitespace around numeric id', async () => {
    const { addToWhitelistBodySchema } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const result = addToWhitelistBodySchema.safeParse({ ncmId: ' 123456 ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ncmId).toBe('123456');
    }
  });
});

// ── remove handler revokes user session ─────────────────────────────────────────
// The handler imports users.deleteUser at module load time, so we need to
// set up the allowlist and users DB before importing the route module.

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalJwtSecret = process.env.CROSSFADIO_JWT_SECRET;

describe('createRemoveFromWhitelistHandler revokes access', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-whitelist-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
    process.env.CROSSFADIO_LLM_BASE_URL = 'http://localhost:8080/v1';
    process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
    process.env.CROSSFADIO_LLM_MODEL = 'gpt-test';
    process.env.CROSSFADIO_TTS_BASE_URL = 'http://localhost:8080/tts';
    process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
    // Init DB and allowlist
    const { initDb } = await import('../../src/server/store/db');
    initDb();
    const { loadAllowlist } = await import('../../src/server/allowlist');
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["testuser1"]');
    loadAllowlist();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
    if (originalJwtSecret === undefined) delete process.env.CROSSFADIO_JWT_SECRET;
    else process.env.CROSSFADIO_JWT_SECRET = originalJwtSecret;
  });

  it('removes user from allowlist AND deletes user DB record', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    const { getAllowlist } = await import('../../src/server/allowlist');

    // Add a user to the DB (simulating they logged in)
    upsertUser({ ncmId: 'testuser1', encryptedCookie: 'encrypted', profileJson: null });
    expect(getUserById('testuser1')).not.toBeNull();
    expect(getAllowlist()).toContain('testuser1');

    const { createRemoveFromWhitelistHandler } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const handler = createRemoveFromWhitelistHandler();

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handler({ params: { ncmId: 'testuser1' } } as unknown as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    // Allowlist entry should be removed
    expect(getAllowlist()).not.toContain('testuser1');
    // User DB record should be deleted (session revoked)
    expect(getUserById('testuser1')).toBeNull();
  });
});
