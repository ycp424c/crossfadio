import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const scheduleTasteAnalysisIfDueMock = vi.hoisted(() => vi.fn());
const scheduleMusicEntityIndexIfDueMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/http/routes/taste-analysis.js', () => ({
  scheduleTasteAnalysisIfDue: scheduleTasteAnalysisIfDueMock
}));

vi.mock('../../src/server/music-agent/entity-indexer.js', () => ({
  scheduleMusicEntityIndexIfDue: scheduleMusicEntityIndexIfDueMock
}));

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalJwtSecret = process.env.CROSSFADIO_JWT_SECRET;

describe('userScopeMiddleware allowlist check', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    scheduleTasteAnalysisIfDueMock.mockReset();
    scheduleMusicEntityIndexIfDueMock.mockReset();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-userscope-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
    process.env.CROSSFADIO_LLM_BASE_URL = 'http://localhost:8080/v1';
    process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
    process.env.CROSSFADIO_LLM_MODEL = 'gpt-test';
    process.env.CROSSFADIO_TTS_BASE_URL = 'http://localhost:8080/tts';
    process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
    // Init DB
    const { initDb } = await import('../../src/server/store/db');
    initDb();
    // Set up allowlist
    const { loadAllowlist } = await import('../../src/server/allowlist');
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["allowedUser"]');
    loadAllowlist();
    // Reset config
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
    if (originalJwtSecret === undefined) delete process.env.CROSSFADIO_JWT_SECRET;
    else process.env.CROSSFADIO_JWT_SECRET = originalJwtSecret;
  });

  function makeReqRes(userId?: string) {
    const req = {
      userId,
      app: { locals: { ncmBaseUrl: 'http://localhost:3000' } }
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    return { req, res, next };
  }

  it('passes an ordinary user not in the allowlist through to next()', async () => {
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    // User exists in DB but is NOT in the allowlist (ordinary standard user)
    const { deriveKey, encrypt } = await import('../../src/server/crypto');
    const { getConfig } = await import('../../src/server/config');
    const { upsertUser } = await import('../../src/server/store/users');
    const encryptedCookie = encrypt('MUSIC_U=unit-test;', deriveKey(getConfig().jwtSecret));
    upsertUser({ ncmId: 'disallowedUser', encryptedCookie, profileJson: null });

    const { req, res, next } = makeReqRes('disallowedUser');

    await userScopeMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as Request & { ncmClient?: unknown }).ncmClient).toBeTruthy();
  });

  it('does not schedule automatic taste analysis or entity indexing for standard users', async () => {
    const { deriveKey, encrypt } = await import('../../src/server/crypto');
    const { getConfig } = await import('../../src/server/config');
    const { upsertUser } = await import('../../src/server/store/users');
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    const encryptedCookie = encrypt('MUSIC_U=unit-test;', deriveKey(getConfig().jwtSecret));
    upsertUser({ ncmId: 'disallowedUser', encryptedCookie, profileJson: null });

    const { req, res, next } = makeReqRes('disallowedUser');

    await userScopeMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(scheduleTasteAnalysisIfDueMock).not.toHaveBeenCalled();
    expect(scheduleMusicEntityIndexIfDueMock).not.toHaveBeenCalled();
  });

  it('returns 401 when userId is missing', async () => {
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    const { req, res, next } = makeReqRes(undefined);

    await userScopeMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when user not found in DB even if in allowlist', async () => {
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    // User is in allowlist but has no DB record (e.g. session was deleted
    // during removal from allowlist)
    const { req, res, next } = makeReqRes('allowedUser');

    await userScopeMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a persistently suspended user with 403 even when they hold a valid JWT', async () => {
    const { deriveKey, encrypt } = await import('../../src/server/crypto');
    const { getConfig } = await import('../../src/server/config');
    const { upsertUser } = await import('../../src/server/store/users');
    const { setUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    const encryptedCookie = encrypt('MUSIC_U=unit-test;', deriveKey(getConfig().jwtSecret));
    upsertUser({ ncmId: 'suspendedUser', encryptedCookie, profileJson: null });
    setUserAccessStatus('suspendedUser', 'suspended');

    const { req, res, next } = makeReqRes('suspendedUser');

    await userScopeMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.ok).toBe(false);
    expect(jsonCall.error).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('schedules automatic taste analysis and entity indexing only for priority users', async () => {
    const { deriveKey, encrypt } = await import('../../src/server/crypto');
    const { getConfig } = await import('../../src/server/config');
    const { upsertUser } = await import('../../src/server/store/users');
    const { userScopeMiddleware } = await import(
      '../../src/server/http/middleware/userScope'
    );
    const encryptedCookie = encrypt('MUSIC_U=unit-test;', deriveKey(getConfig().jwtSecret));
    upsertUser({ ncmId: 'allowedUser', encryptedCookie, profileJson: null });

    const { req, res, next } = makeReqRes('allowedUser');

    await userScopeMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as Request & { ncmClient?: unknown }).ncmClient).toBeTruthy();
    expect(scheduleTasteAnalysisIfDueMock).toHaveBeenCalledWith(
      'allowedUser',
      (req as Request & { ncmClient?: unknown }).ncmClient
    );
    expect(scheduleMusicEntityIndexIfDueMock).toHaveBeenCalledWith(
      'allowedUser',
      (req as Request & { ncmClient?: unknown }).ncmClient
    );
  });
});
