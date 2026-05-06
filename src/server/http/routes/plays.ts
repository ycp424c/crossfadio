import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { startPlay, endPlay } from '../../store/plays.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const startPlayBodySchema = z.object({
  songId: z.string().min(1),
  songName: z.string().min(1),
  artistName: z.string().default('')
});

const endPlayBodySchema = z.object({
  reason: z.enum(['completed', 'skip', 'error'])
});

export function createStartPlayHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = startPlayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    const id = startPlay(userId, parsed.data);
    res.status(201).json({ ok: true, id });
  };
}

export function createEndPlayHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: 'invalid id' });
      return;
    }
    const parsed = endPlayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    const updated = endPlay(userId, id, parsed.data.reason);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'play not found or already ended' });
      return;
    }
    res.json({ ok: true });
  };
}
