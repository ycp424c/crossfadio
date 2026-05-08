import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllowlist,
  addToAllowlist,
  removeFromAllowlist
} from '../../allowlist.js';
import {
  getBlockedAttempts,
  deleteBlockedAttempt,
  deleteBlockedAttemptsByNcmId,
  deleteUser
} from '../../store/users.js';

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
    addToAllowlist(ncmId);
    deleteBlockedAttemptsByNcmId(ncmId);
    res.json({ ok: true });
  };
}

// ── DELETE /api/whitelist/:ncmId ────────────────────────────────────────────────

export function createRemoveFromWhitelistHandler() {
  return (req: Request, res: Response): void => {
    const { ncmId } = req.params;
    if (!ncmId) {
      res.status(400).json({ ok: false, error: 'ncmId is required' });
      return;
    }
    // Revoke active session first: delete user record so userScopeMiddleware
    // rejects this ncmId on the next request even if the user holds a valid JWT.
    // If deletion succeeds but allowlist removal later fails, the user can still
    // re-authenticate (they're in the allowlist) and the admin can retry — safer
    // than the reverse where the session stays alive after removal appears to succeed.
    deleteUser(ncmId);
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
    addToAllowlist(found.ncm_id);
    deleteBlockedAttempt(id);
    res.json({ ok: true, ncmId: found.ncm_id });
  };
}
