import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  listSuspendedUsers,
  setUserAccessStatus
} from '../../store/user-access-controls.js';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

// ── GET /api/access/suspended ───────────────────────────────────────────────────

export function createGetSuspendedHandler() {
  return (_req: Request, res: Response): void => {
    const suspended = listSuspendedUsers();
    res.json({ ok: true, suspended });
  };
}

// ── POST /api/access/suspended ──────────────────────────────────────────────────

export const suspendUserBodySchema = z.object({
  ncmId: z.string().trim().regex(/^\d+$/, 'ncmId must be a numeric string')
});

export function createSuspendUserHandler() {
  return (req: Request, res: Response): void => {
    const parsed = suspendUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }
    const { ncmId } = parsed.data;
    // adminProtect already guarantees the caller is the only admin; suspending
    // that account would lock the operator out of every admin entry, so the
    // action itself is rejected (the suspension boundary is never bypassed).
    if (getConfig().adminNcmId === ncmId) {
      res.status(400).json({ ok: false, error: 'cannot_suspend_self' });
      return;
    }
    setUserAccessStatus(ncmId, 'suspended');
    getLogger().info({ ncmId }, 'User suspended');
    // Suspension does not delete the user, JWT, Bridge token, or historical data;
    // it takes effect on the next JWT or Bridge request.
    res.json({ ok: true });
  };
}

// ── DELETE /api/access/suspended/:ncmId ─────────────────────────────────────────

export function createReactivateUserHandler() {
  return (req: Request, res: Response): void => {
    const { ncmId } = req.params;
    if (!ncmId || !/^\d+$/.test(ncmId)) {
      res.status(400).json({ ok: false, error: 'invalid ncmId' });
      return;
    }
    setUserAccessStatus(ncmId, 'active');
    getLogger().info({ ncmId }, 'User reactivated');
    // Reactivation restores access without promoting the user to priority.
    res.json({ ok: true });
  };
}
