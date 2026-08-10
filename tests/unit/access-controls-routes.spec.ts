import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { SignJWT } from 'jose';

const originalEnv = { ...process.env };
const ADMIN_NCM_ID = '100001';

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-access-controls-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  process.env.CROSSFADIO_ADMIN_NCM_ID = ADMIN_NCM_ID;
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

function createJsonResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  };
  return res;
}

describe('suspend user handler input validation', () => {
  it('rejects a non-numeric ncmId with 400', async () => {
    const { createSuspendUserHandler } = await import('../../src/server/http/routes/access-controls');
    const { getUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const handler = createSuspendUserHandler();
    const res = createJsonResponse();

    handler({ body: { ncmId: 'abc123' } } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid body' });
    // No suspension row may be written for a malformed id.
    expect(getUserAccessStatus('abc123')).toBe('active');
  });

  it('rejects suspending the currently logged-in admin (self-suspension)', async () => {
    const { createSuspendUserHandler } = await import('../../src/server/http/routes/access-controls');
    const { getUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const handler = createSuspendUserHandler();
    const res = createJsonResponse();

    handler({ body: { ncmId: ADMIN_NCM_ID } } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'cannot_suspend_self' });
    // The admin account must remain active — we reject the action instead of
    // bypassing the suspension boundary for admin requests.
    expect(getUserAccessStatus(ADMIN_NCM_ID)).toBe('active');
  });

  it('allows suspending another user', async () => {
    const { createSuspendUserHandler } = await import('../../src/server/http/routes/access-controls');
    const { getUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const handler = createSuspendUserHandler();
    const res = createJsonResponse();

    handler({ body: { ncmId: '2001' } } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getUserAccessStatus('2001')).toBe('suspended');
  });
});

describe('reactivate user handler input validation', () => {
  it('rejects a non-numeric path ncmId with 400', async () => {
    const { createReactivateUserHandler } = await import('../../src/server/http/routes/access-controls');
    const handler = createReactivateUserHandler();
    const res = createJsonResponse();

    handler({ params: { ncmId: 'not-a-number' } } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid ncmId' });
  });

  it('accepts a numeric path ncmId', async () => {
    const { createReactivateUserHandler } = await import('../../src/server/http/routes/access-controls');
    const { setUserAccessStatus, getUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    setUserAccessStatus('2002', 'suspended');
    const handler = createReactivateUserHandler();
    const res = createJsonResponse();

    handler({ params: { ncmId: '2002' } } as never, res as never, vi.fn() as never);

    expect(res.statusCode).toBe(200);
    expect(getUserAccessStatus('2002')).toBe('active');
  });
});

// ── Real Express middleware chain regression ───────────────────────────────────
// authMiddleware → userScopeMiddleware → adminMiddleware → access-controls handler.
// Proves the self-suspension rejection keeps the admin able to use the
// reactivation entry, and that the suspension boundary itself still blocks
// suspended users (we do NOT bypass suspension for admins).

describe('access-controls through the real Express middleware chain', () => {
  let server: Server;
  let baseUrl: string;
  let adminToken: string;

  async function upsertAuthedUser(ncmId: string, encryptedCookie: string): Promise<void> {
    const { upsertUser } = await import('../../src/server/store/users');
    upsertUser({ ncmId, encryptedCookie, profileJson: null });
  }

  async function mintJwt(ncmId: string): Promise<string> {
    const secret = new TextEncoder().encode(process.env.CROSSFADIO_JWT_SECRET);
    return new SignJWT({ sub: ncmId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret);
  }

  beforeEach(async () => {
    const { deriveKey, encrypt } = await import('../../src/server/crypto');
    const cookie = encrypt('ncm-cookie-value', deriveKey(process.env.CROSSFADIO_JWT_SECRET!));
    await upsertAuthedUser(ADMIN_NCM_ID, cookie);
    await upsertAuthedUser('100002', cookie);
    adminToken = await mintJwt(ADMIN_NCM_ID);

    const {
      createGetSuspendedHandler,
      createSuspendUserHandler,
      createReactivateUserHandler
    } = await import('../../src/server/http/routes/access-controls');
    const { authMiddleware } = await import('../../src/server/http/middleware/auth');
    const { userScopeMiddleware } = await import('../../src/server/http/middleware/userScope');
    const { adminMiddleware } = await import('../../src/server/http/middleware/admin');

    const app = express();
    app.locals.ncmBaseUrl = 'http://localhost:3000';
    app.use(express.json());
    app.get('/api/access/suspended', authMiddleware, userScopeMiddleware, adminMiddleware, createGetSuspendedHandler());
    app.post('/api/access/suspended', authMiddleware, userScopeMiddleware, adminMiddleware, createSuspendUserHandler());
    app.delete('/api/access/suspended/:ncmId', authMiddleware, userScopeMiddleware, adminMiddleware, createReactivateUserHandler());
    // A plain protected probe used to verify the suspension boundary.
    app.get('/api/protected-probe', authMiddleware, userScopeMiddleware, (_req, res) => {
      res.json({ ok: true });
    });

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function request(method: string, pathName: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  }

  it('rejects self-suspension but keeps the admin able to reactivate users afterwards', async () => {
    const { getUserAccessStatus } = await import('../../src/server/store/user-access-controls');

    // Admin suspends another user through the real chain.
    const suspendOther = await request('POST', '/api/access/suspended', adminToken, { ncmId: '100002' });
    expect(suspendOther.status).toBe(200);
    expect(getUserAccessStatus('100002')).toBe('suspended');

    // Admin tries to suspend themselves: must be rejected and stay active.
    const selfSuspend = await request('POST', '/api/access/suspended', adminToken, { ncmId: ADMIN_NCM_ID });
    expect(selfSuspend.status).toBe(400);
    expect(getUserAccessStatus(ADMIN_NCM_ID)).toBe('active');

    // The reactivation entry must still work for the admin after the rejection.
    const reactivate = await request('DELETE', `/api/access/suspended/100002`, adminToken);
    expect(reactivate.status).toBe(200);
    expect(getUserAccessStatus('100002')).toBe('active');
  });

  it('keeps the suspension boundary intact: a suspended user stays blocked at the JWT boundary', async () => {
    const { setUserAccessStatus } = await import('../../src/server/store/user-access-controls');
    const user1Token = await mintJwt('100002');

    const before = await request('GET', '/api/protected-probe', user1Token);
    expect(before.status).toBe(200);

    setUserAccessStatus('100002', 'suspended');
    const blocked = await request('GET', '/api/protected-probe', user1Token);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ ok: false, error: 'forbidden' });

    // Reactivation restores access — no priority promotion involved.
    const reactivate = await request('DELETE', '/api/access/suspended/100002', adminToken);
    expect(reactivate.status).toBe(200);
    const restored = await request('GET', '/api/protected-probe', user1Token);
    expect(restored.status).toBe(200);
  });
});
