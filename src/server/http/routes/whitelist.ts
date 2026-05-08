import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import {
  getAllowlist,
  addToAllowlist,
  removeFromAllowlist
} from '../../allowlist.js';
import {
  getBlockedAttempts,
  deleteBlockedAttempt,
  deleteBlockedAttemptsByNcmId
} from '../../store/users.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

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

const addToWhitelistBodySchema = z.object({
  ncmId: z.string().min(1, 'ncmId is required')
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
