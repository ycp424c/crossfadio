import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import {
  LISTENING_EPISODE_DAILY_LIMIT,
  listeningEpisodeCheckpointSchema,
  listeningEpisodeCreateSchema,
  listeningEpisodeFinalizeSchema,
  listeningEpisodeKeepaliveCheckpointSchema
} from '../../../shared/listening.js';
import { indexPlayedTrack } from '../../music-agent/entity-indexer.js';
import { getLogger } from '../../logger.js';
import {
  checkpointListeningEpisode,
  createListeningEpisode,
  finalizeListeningEpisode
} from '../../store/listening-episodes.js';
import { deriveListeningSignals } from '../../listening/listening-signals.js';
import { recordTemporaryQueueBans } from '../../store/temporary-bans.js';
import { safeOperationalError } from '../../errors/safe-operational-error.js';

type AuthedRequest = Request & { userId: string };

const clientEpisodeIdSchema = z.string().trim().min(1).max(100);
const listeningEpisodePatchSchema = z.union([
  listeningEpisodeKeepaliveCheckpointSchema,
  listeningEpisodeFinalizeSchema,
  listeningEpisodeCheckpointSchema
]);

export function createPutListeningEpisodeHandler(): RequestHandler {
  return async (req, res) => {
    const clientEpisodeId = clientEpisodeIdSchema.safeParse(req.params.clientEpisodeId);
    const body = listeningEpisodeCreateSchema.safeParse(req.body);
    if (!clientEpisodeId.success || !body.success) {
      res.status(400).json({ ok: false, error: 'invalid Listening Episode' });
      return;
    }

    const userId = (req as AuthedRequest).userId;
    const result = createListeningEpisode(userId, clientEpisodeId.data, body.data);
    if (result.status === 'quota_exceeded') {
      res.status(429).json({
        ok: false,
        error: 'listening_episode_daily_quota_exceeded',
        dailyLimit: LISTENING_EPISODE_DAILY_LIMIT,
        quotaResetsAt: result.quotaResetsAt
      });
      return;
    }
    if (result.conflict) {
      res.status(409).json({ ok: false, error: 'Listening Episode id conflict' });
      return;
    }
    if (result.created) {
      void Promise.resolve(indexPlayedTrack({
        userId,
        track: {
          songId: result.episode.track.id,
          songName: result.episode.track.name,
          artistName: result.episode.track.artists.join(' / ')
        }
      })).catch((error) => {
        getLogger().error(
          safeOperationalError(error, 'listening_track_index_failed'),
          'Listening Episode played-track indexing failed'
        );
      });
    }

    res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      episode: result.episode
    });
  };
}

export function createPatchListeningEpisodeHandler(): RequestHandler {
  return (req, res) => {
    const clientEpisodeId = clientEpisodeIdSchema.safeParse(req.params.clientEpisodeId);
    const body = listeningEpisodePatchSchema.safeParse(req.body);
    if (!clientEpisodeId.success || !body.success) {
      res.status(400).json({ ok: false, error: 'invalid Listening Episode checkpoint' });
      return;
    }

    const userId = (req as AuthedRequest).userId;
    if ('create' in body.data) {
      const created = createListeningEpisode(userId, clientEpisodeId.data, body.data.create);
      if (created.status === 'quota_exceeded') {
        res.status(429).json({
          ok: false,
          error: 'listening_episode_daily_quota_exceeded',
          dailyLimit: LISTENING_EPISODE_DAILY_LIMIT,
          quotaResetsAt: created.quotaResetsAt
        });
        return;
      }
      if (created.conflict) {
        res.status(409).json({ ok: false, error: 'Listening Episode id conflict' });
        return;
      }
      if (created.created) indexEpisodeTrack(userId, created.episode);
    }
    const checkpoint = 'create' in body.data ? body.data.checkpoint : body.data;
    const finalization = listeningEpisodeFinalizeSchema.safeParse(checkpoint);
    const result = finalization.success
      ? finalizeListeningEpisode(userId, clientEpisodeId.data, finalization.data)
      : checkpointListeningEpisode(userId, clientEpisodeId.data, checkpoint);
    if (result.status === 'not_found') {
      res.status(404).json({ ok: false, error: 'Listening Episode not found' });
      return;
    }
    if (result.status === 'conflict') {
      res.status(409).json({ ok: false, error: 'Listening Episode checkpoint conflict' });
      return;
    }
    if (
      finalization.success
      && result.episode?.outcome === 'skipped'
      && deriveListeningSignals({
        outcome: result.episode.outcome,
        durationMs: result.episode.durationMs,
        positionMs: result.episode.positionMs,
        listenedMs: result.episode.listenedMs,
        legacyExposureOverride: result.episode.legacyExposureOverride
      }).earlySkip
    ) {
      recordTemporaryQueueBans(userId, [{
        id: result.episode.track.id,
        name: result.episode.track.name,
        artists: result.episode.track.artists
      }], result.episode.endedAt ? new Date(result.episode.endedAt) : new Date());
    }

    res.json({
      ok: true,
      updated: result.status === 'updated',
      episode: result.episode
    });
  };
}

function indexEpisodeTrack(
  userId: string,
  episode: { track: { id: string; name: string; artists: string[] } }
): void {
  void Promise.resolve(indexPlayedTrack({
    userId,
    track: {
      songId: episode.track.id,
      songName: episode.track.name,
      artistName: episode.track.artists.join(' / ')
    }
  })).catch((error) => {
    getLogger().error(
      safeOperationalError(error, 'listening_track_index_failed'),
      'Listening Episode played-track indexing failed'
    );
  });
}
