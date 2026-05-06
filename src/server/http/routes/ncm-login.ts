import type { RequestHandler, Request, Response } from 'express';
import { z } from 'zod';
import type { NcmAuthService } from '../../ncm/auth.js';
import type { NcmClient } from '../../ncm/client.js';
import { NcmApiError } from '../../ncm/client.js';
import { NCM_ERROR_CODE, type NcmErrorCode } from '../../../shared/schema.js';
import { getUserById, deleteUser } from '../../store/users.js';
import { deriveKey, decrypt } from '../../crypto.js';
import { getConfig } from '../../config.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const qrQuerySchema = z.object({
  key: z.string().min(1)
});

export function createNcmQrHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res) => {
    try {
      const payload = await auth.createQr();
      res.json({ ok: true, ...payload });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNcmQrStatusHandler(auth: NcmAuthService): RequestHandler {
  return async (req, res) => {
    const parsed = qrQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: NCM_ERROR_CODE.BAD_RESPONSE, message: 'missing key' });
      return;
    }
    try {
      const result = await auth.checkQr(parsed.data.key);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNcmSessionHandler(): RequestHandler {
  return async (req, res) => {
    const { userId, ncmClient } = req as AuthedRequest;
    try {
      const loginStatus = await ncmClient.getLoginStatus();
      const profile = (loginStatus as any)?.data?.profile ?? null;
      res.json({ ok: true, hasCookie: true, profile });
    } catch {
      res.json({ ok: true, hasCookie: false, profile: null });
    }
  };
}

export function createNcmLogoutHandler(): RequestHandler {
  return async (req, res) => {
    const { userId, ncmClient } = req as AuthedRequest;
    try {
      await ncmClient.logout();
    } catch {
      // best effort
    } finally {
      deleteUser(userId);
    }
    res.json({ ok: true });
  };
}

function sendNcmError(res: Response, error: unknown): void {
  const { code, message } = classifyError(error);
  res.status(httpStatusFor(code)).json({ ok: false, error: code, message });
}

function classifyError(error: unknown): { code: NcmErrorCode; message: string } {
  if (error instanceof NcmApiError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : 'unknown error';
  return { code: NCM_ERROR_CODE.UNKNOWN, message };
}

function httpStatusFor(code: NcmErrorCode): number {
  switch (code) {
    case NCM_ERROR_CODE.UNAUTHORIZED:
    case NCM_ERROR_CODE.COOKIE_EXPIRED: return 401;
    case NCM_ERROR_CODE.RATE_LIMITED: return 429;
    case NCM_ERROR_CODE.TIMEOUT: return 504;
    case NCM_ERROR_CODE.UNAVAILABLE: return 503;
    case NCM_ERROR_CODE.BAD_RESPONSE: return 502;
    default: return 500;
  }
}
