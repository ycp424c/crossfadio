import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

describe('adminMiddleware', () => {
  const originalAdminNcmId = process.env.CROSSFADIO_ADMIN_NCM_ID;

  beforeEach(async () => {
    vi.resetModules();
    // Set up required env vars for config loading
    process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
    process.env.CROSSFADIO_LLM_BASE_URL = 'http://localhost:8080/v1';
    process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
    process.env.CROSSFADIO_LLM_MODEL = 'gpt-test';
    process.env.CROSSFADIO_TTS_BASE_URL = 'http://localhost:8080/tts';
    process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();
  });

  afterEach(() => {
    if (originalAdminNcmId === undefined) delete process.env.CROSSFADIO_ADMIN_NCM_ID;
    else process.env.CROSSFADIO_ADMIN_NCM_ID = originalAdminNcmId;
  });

  function makeReqRes(userId?: string) {
    const req = { userId } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    return { req, res, next };
  }

  it('returns 403 when adminNcmId is not configured', async () => {
    delete process.env.CROSSFADIO_ADMIN_NCM_ID;
    const { adminMiddleware } = await import('../../src/server/http/middleware/admin');
    const { req, res, next } = makeReqRes('user123');

    adminMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.ok).toBe(false);
    expect(jsonCall.error).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when userId does not match adminNcmId', async () => {
    process.env.CROSSFADIO_ADMIN_NCM_ID = 'admin001';
    const { adminMiddleware } = await import('../../src/server/http/middleware/admin');
    const { req, res, next } = makeReqRes('user999');

    adminMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.ok).toBe(false);
    expect(jsonCall.error).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when userId matches adminNcmId', async () => {
    process.env.CROSSFADIO_ADMIN_NCM_ID = 'admin001';
    const { adminMiddleware } = await import('../../src/server/http/middleware/admin');
    const { req, res, next } = makeReqRes('admin001');

    adminMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
