import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { broadcastToUser } from '../broadcast.js';
import {
  compareAndSetQueueStateWithTemporaryBans
} from '../../store/queue.js';
import { likedQueueResponseSchema } from '../../../shared/schema.js';
import {
  MAX_QUEUE_TRACK_ARTIST_LENGTH,
  MAX_QUEUE_TRACK_ARTISTS,
  MAX_QUEUE_TRACK_COVER_URL_LENGTH,
  MAX_QUEUE_TRACK_ID_LENGTH,
  MAX_QUEUE_TRACK_NAME_LENGTH,
  MAX_QUEUE_TRACKS,
  MAX_TEMPORARY_QUEUE_BANS_PER_MUTATION
} from '../../../shared/queue.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const queueStateBodySchema = z.object({
  queue: z.array(
    z.union([
      z.string().min(1).max(MAX_QUEUE_TRACK_ID_LENGTH),
      z.object({
        id: z.string().min(1).max(MAX_QUEUE_TRACK_ID_LENGTH),
        name: z.string().max(MAX_QUEUE_TRACK_NAME_LENGTH).optional(),
        artists: z.array(z.string().min(1).max(MAX_QUEUE_TRACK_ARTIST_LENGTH))
          .max(MAX_QUEUE_TRACK_ARTISTS).optional(),
        durationMs: z.number().int().nonnegative().optional(),
        coverImgUrl: z.string().max(MAX_QUEUE_TRACK_COVER_URL_LENGTH).nullable().optional()
      })
    ])
  ).max(MAX_QUEUE_TRACKS),
  currentIndex: z.number().int().nonnegative().default(0),
  revision: z.number().int().nonnegative(),
  mutationId: z.string().uuid(),
  temporaryBanTracks: z.array(
    z.object({
      id: z.string().min(1).max(MAX_QUEUE_TRACK_ID_LENGTH),
      name: z.string().max(MAX_QUEUE_TRACK_NAME_LENGTH).optional(),
      artists: z.array(z.string().min(1).max(MAX_QUEUE_TRACK_ARTIST_LENGTH))
        .max(MAX_QUEUE_TRACK_ARTISTS).optional()
    })
  ).max(MAX_TEMPORARY_QUEUE_BANS_PER_MUTATION).optional()
});

const likeBodySchema = z.object({
  id: z.string().min(1),
  like: z.boolean()
});

const likedQueueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export function createSetQueueStateHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = queueStateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    const tracks = parsed.data.queue.map((track) =>
        typeof track === 'string'
          ? { ncmId: track }
          : {
              ncmId: track.id,
              name: track.name,
              artists: track.artists,
              durationMs: track.durationMs,
              coverImgUrl: track.coverImgUrl
            }
      );
    const update = compareAndSetQueueStateWithTemporaryBans({
      userId,
      mutationId: parsed.data.mutationId,
      expectedRevision: parsed.data.revision,
      tracks,
      nextCurrentIndex: parsed.data.currentIndex,
      temporaryBanTracks: parsed.data.temporaryBanTracks
    });
    if (!update.applied) {
      res.status(409).json({
        ok: false,
        error: update.reason,
        queue: update.snapshot.queue.map((track) => ({
          id: track.ncmId,
          name: track.name ?? `Track ${track.ncmId}`,
          artists: track.artists ?? [],
          durationMs: track.durationMs ?? 0,
          coverImgUrl: track.coverImgUrl ?? null
        })),
        currentIndex: update.snapshot.currentIndex,
        revision: update.snapshot.revision
      });
      return;
    }
    const authoritativePayload = {
      ok: true,
      queue: update.snapshot.queue.map(toQueueTrackDto),
      currentIndex: update.snapshot.currentIndex,
      revision: update.snapshot.revision
    };
    res.json(authoritativePayload);
    broadcastToUser(userId, { type: 'queue-updated', ...authoritativePayload });
  };
}

function toQueueTrackDto(track: {
  ncmId: string;
  name?: string;
  artists?: string[];
  durationMs?: number;
  coverImgUrl?: string | null;
}) {
  return {
    id: track.ncmId,
    name: track.name ?? `Track ${track.ncmId}`,
    artists: track.artists ?? [],
    durationMs: track.durationMs ?? 0,
    coverImgUrl: track.coverImgUrl ?? null
  };
}

export function createLikeTrackHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { ncmClient } = req as AuthedRequest;
    const parsed = likeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    try {
      await ncmClient.likeTrack(parsed.data.id, parsed.data.like);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      res.status(502).json({ ok: false, error: 'NCM_E_BAD_RESPONSE', message });
    }
  };
}

export function createGetLikedIdsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { ncmClient } = req as AuthedRequest;
    try {
      const ids = (await ncmClient.getLikedSongIds()).map(String);
      res.json({ ok: true, ids });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      res.status(502).json({ ok: false, error: 'NCM_E_BAD_RESPONSE', message });
    }
  };
}

export function createGetLikedQueueHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { ncmClient } = req as AuthedRequest;
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
        durationMs: track.durationMs,
        coverImgUrl: track.coverImgUrl
      }));

      res.json(likedQueueResponseSchema.parse({ ok: true, source: 'ncm-liked', tracks, currentIndex: 0 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      res.status(502).json({ ok: false, error: 'NCM_E_BAD_RESPONSE', message });
    }
  };
}
