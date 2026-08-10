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
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["123456"]');
    loadAllowlist();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
    if (originalJwtSecret === undefined) delete process.env.CROSSFADIO_JWT_SECRET;
    else process.env.CROSSFADIO_JWT_SECRET = originalJwtSecret;
  });

  it('demotes a priority user without deleting the user record or user data', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    const { getAllowlist } = await import('../../src/server/allowlist');
    const { resolveUserTier } = await import('../../src/server/resource-policy');

    // Add a user to the DB (simulating they logged in)
    upsertUser({ ncmId: '123456', encryptedCookie: 'encrypted', profileJson: null });
    expect(getUserById('123456')).not.toBeNull();
    expect(getAllowlist()).toContain('123456');
    expect(resolveUserTier('123456')).toBe('priority');

    const { createRemoveFromWhitelistHandler } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const handler = createRemoveFromWhitelistHandler();

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handler({ params: { ncmId: '123456' } } as unknown as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    // Allowlist entry should be removed → tier drops to standard
    expect(getAllowlist()).not.toContain('123456');
    expect(resolveUserTier('123456')).toBe('standard');
    // User DB record must survive: access and data remain, only the tier changes
    expect(getUserById('123456')).not.toBeNull();
  });

  it('keeps suspended blocked-login attempts when granting priority membership', async () => {
    const { upsertUser, recordBlockedAttempt, getBlockedAttempts } = await import('../../src/server/store/users');
    const { setUserAccessStatus } = await import('../../src/server/store/user-access-controls');

    upsertUser({ ncmId: '2002', encryptedCookie: 'encrypted', profileJson: null });
    recordBlockedAttempt({ ncmId: '2002', profileJson: null });
    setUserAccessStatus('2002', 'suspended');
    expect(getBlockedAttempts().some((entry) => entry.ncm_id === '2002')).toBe(true);

    const { createAddToWhitelistHandler } = await import('../../src/server/http/routes/whitelist');
    const handler = createAddToWhitelistHandler();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handler({ body: { ncmId: '2002' } } as unknown as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    // Granting priority membership is orthogonal to safety suspension: the
    // blocked attempt must survive so only the unblock action can delete it.
    expect(getBlockedAttempts().some((entry) => entry.ncm_id === '2002')).toBe(true);
  });

  it('rejects a non-numeric ncmId on the demote path with 400', async () => {
    const { createRemoveFromWhitelistHandler } = await import(
      '../../src/server/http/routes/whitelist'
    );
    const handler = createRemoveFromWhitelistHandler();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handler({ params: { ncmId: 'not-a-number' } } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'invalid ncmId' });
  });

  it('unblocks a suspended user by reactivating them without adding priority membership', async () => {
    const { upsertUser, recordBlockedAttempt, getBlockedAttempts } = await import('../../src/server/store/users');
    const { setUserAccessStatus, getUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const { getAllowlist } = await import('../../src/server/allowlist');
    const { resolveUserTier } = await import('../../src/server/resource-policy');

    upsertUser({ ncmId: 'suspended1', encryptedCookie: 'encrypted', profileJson: null });
    recordBlockedAttempt({ ncmId: 'suspended1', profileJson: null });
    setUserAccessStatus('suspended1', 'suspended');
    const attempt = getBlockedAttempts().find((entry) => entry.ncm_id === 'suspended1');
    expect(attempt).toBeDefined();

    const { createUnblockHandler } = await import('../../src/server/http/routes/whitelist');
    const handler = createUnblockHandler();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;

    handler({ params: { id: String(attempt!.id) } } as unknown as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true, ncmId: 'suspended1' });
    expect(getBlockedAttempts().some((entry) => entry.id === attempt!.id)).toBe(false);
    expect(getUserAccessStatus('suspended1')).toBe('active');
    // Unblocking must NOT promote the user to the priority list
    expect(getAllowlist()).not.toContain('suspended1');
    expect(resolveUserTier('suspended1')).toBe('standard');
  });
});
