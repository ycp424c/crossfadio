import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { setQueueState } from '../../store/queue.js';
import { likedQueueResponseSchema } from '../../../shared/schema.js';

const queueStateBodySchema = z.object({
  queue: z.array(
    z.union([
      z.string().min(1),
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        artists: z.array(z.string()).optional(),
        durationMs: z.number().int().nonnegative().optional()
      })
    ])
  ),
  currentIndex: z.number().int().nonnegative().default(0)
});

const likedQueueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export function createSetQueueStateHandler(): RequestHandler {
  return (req, res) => {
    const parsed = queueStateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    setQueueState(
      parsed.data.queue.map((track) =>
        typeof track === 'string'
          ? { ncmId: track }
          : {
              ncmId: track.id,
              name: track.name,
              artists: track.artists,
              durationMs: track.durationMs
            }
      ),
      parsed.data.currentIndex
    );
    res.json({ ok: true });
  };
}

export function createGetLikedQueueHandler(ncmClient: NcmClient): RequestHandler {
  return async (req, res) => {
    const parsed = likedQueueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid query' });
      return;
    }

    try {
      const ids = (await ncmClient.getLikedSongIds()).slice(0, parsed.data.limit);
      const details = await ncmClient.getSongDetails(ids);
      const tracks = details.map((track) => ({
        id: String(track.id),
        name: track.name,
        artists: track.artists,
        durationMs: track.durationMs
      }));

      res.json(likedQueueResponseSchema.parse({ ok: true, source: 'ncm-liked', tracks, currentIndex: 0 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      res.status(502).json({ ok: false, error: 'NCM_E_BAD_RESPONSE', message });
    }
  };
}
