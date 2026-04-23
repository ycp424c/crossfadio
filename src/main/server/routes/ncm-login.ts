import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { NcmAuthService } from '@main/ncm/auth';

const qrQuerySchema = z.object({
  key: z.string().min(1)
});

export function createNcmQrHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res, next) => {
    try {
      const payload = await auth.createQr();
      res.json({ ok: true, ...payload });
    } catch (error) {
      next(error);
    }
  };
}

export function createNcmQrStatusHandler(auth: NcmAuthService): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = qrQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'missing key' });
        return;
      }

      const result = await auth.checkQr(parsed.data.key);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  };
}

export function createNcmSessionHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res, next) => {
    try {
      const session = await auth.getSession();
      res.json({ ok: true, ...session });
    } catch (error) {
      next(error);
    }
  };
}

export function createNcmLogoutHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res, next) => {
    try {
      await auth.logout();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
}
