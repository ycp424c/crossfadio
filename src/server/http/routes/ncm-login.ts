import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { NcmAuthService } from '../../ncm/auth.js';
import { NcmApiError } from '../../ncm/client.js';
import { NCM_ERROR_CODE, type NcmErrorCode } from '../../../shared/schema.js';

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

export function createNcmSessionHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res) => {
    try {
      const session = await auth.getSession();
      res.json({ ok: true, ...session });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNcmLogoutHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res) => {
    try {
      await auth.logout();
      res.json({ ok: true });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

function sendNcmError(res: Response, error: unknown): void {
  const { code, message } = classifyError(error);
  res.status(httpStatusFor(code)).json({ ok: false, error: code, message });
}

function classifyError(error: unknown): { code: NcmErrorCode; message: string } {
  if (error instanceof NcmApiError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  return { code: NCM_ERROR_CODE.UNKNOWN, message };
}

function httpStatusFor(code: NcmErrorCode): number {
  switch (code) {
    case NCM_ERROR_CODE.UNAUTHORIZED:
    case NCM_ERROR_CODE.COOKIE_EXPIRED:
      return 401;
    case NCM_ERROR_CODE.RATE_LIMITED:
      return 429;
    case NCM_ERROR_CODE.TIMEOUT:
      return 504;
    case NCM_ERROR_CODE.UNAVAILABLE:
      return 503;
    case NCM_ERROR_CODE.BAD_RESPONSE:
      return 502;
    default:
      return 500;
  }
}
