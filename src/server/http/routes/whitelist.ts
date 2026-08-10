import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllowlist,
  addToAllowlist,
  removeFromAllowlist
} from '../../allowlist.js';
import {
  getBlockedAttempts,
  deleteBlockedAttempt
} from '../../store/users.js';
import { setUserAccessStatus } from '../../store/user-access-controls.js';

// ── GET /api/whitelist ──────────────────────────────────────────────────────────

export function createGetWhitelistHandler() {
  return (_req: Request, res: Response): void => {
    const entries = getAllowlist();
    res.json({ ok: true, entries });
  };
}

// ── GET /api/whitelist/blocked ──────────────────────────────────────────────────

export function createGetBlockedHandler() {
  return (_req: Request, res: Response): void => {
    const blocked = getBlockedAttempts();
    res.json({ ok: true, blocked });
  };
}

// ── POST /api/whitelist ─────────────────────────────────────────────────────────

export const addToWhitelistBodySchema = z.object({
  ncmId: z.string().trim().regex(/^\d+$/, 'ncmId must be a numeric string')
});

export function createAddToWhitelistHandler() {
  return (req: Request, res: Response): void => {
    const parsed = addToWhitelistBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }
    const { ncmId } = parsed.data;
    // Priority membership is orthogonal to safety suspension: granting it must
    // NOT clear blocked login attempts — only the unblock action deletes the
    // selected attempt (reactivating the suspended user without promoting).
    addToAllowlist(ncmId);
    res.json({ ok: true });
  };
}

// ── DELETE /api/whitelist/:ncmId ────────────────────────────────────────────────

export function createRemoveFromWhitelistHandler() {
  return (req: Request, res: Response): void => {
    const { ncmId } = req.params;
    if (!ncmId || !/^\d+$/.test(ncmId)) {
      res.status(400).json({ ok: false, error: 'invalid ncmId' });
      return;
    }
    // Priority membership only: the user keeps their account, JWT, cookie and
    // all historical data — only their resource tier drops back to standard.
    removeFromAllowlist(ncmId);
    res.json({ ok: true });
  };
}

// ── POST /api/whitelist/unblock/:id ─────────────────────────────────────────────

export function createUnblockHandler() {
  return (req: Request, res: Response): void => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ ok: false, error: 'invalid blocked attempt id' });
      return;
    }
    const attempts = getBlockedAttempts();
    const found = attempts.find((a) => a.id === id);
    if (!found) {
      res.status(404).json({ ok: false, error: 'blocked attempt not found' });
      return;
    }
    // Reactivate a suspended user and drop the attempt. This must NOT promote
    // the user to the priority list — priority membership is managed only via
    // the whitelist add/remove endpoints.
    setUserAccessStatus(found.ncm_id, 'active');
    deleteBlockedAttempt(id);
    res.json({ ok: true, ncmId: found.ncm_id });
  };
}
