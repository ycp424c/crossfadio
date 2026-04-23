import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { NcmApiError, type NcmClient } from '@main/ncm/client';
import {
  NCM_ERROR_CODE,
  nextTrackResponseSchema,
  nowPlayingResponseSchema,
  type NcmErrorCode
} from '@shared/schema';

const DEFAULT_PREFETCH_LEAD_SEC = 10;
const DEFAULT_CROSSFADE_SEC = 8;
const DEFAULT_SEGUE_LEAD_SEC = 12;

const nowQuerySchema = z.object({
  ncmId: z.string().min(1)
});

const nextQuerySchema = z.object({
  queue: z.string().min(1),
  current: z.string().min(1).optional()
});

export function createNowHandler(ncmClient: NcmClient): RequestHandler {
  return async (req, res) => {
    const parsed = nowQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ ok: false, error: NCM_ERROR_CODE.BAD_RESPONSE, message: 'missing ncmId query' });
      return;
    }

    try {
      const ncmId = parsed.data.ncmId;
      const [songUrl, lyric] = await Promise.all([
        ncmClient.getSongUrl(ncmId),
        ncmClient.getLyric(ncmId)
      ]);

      if (!songUrl?.url) {
        throw new NcmApiError(
          NCM_ERROR_CODE.BAD_RESPONSE,
          `NCM song url is unavailable for ncmId=${ncmId}`
        );
      }

      const payload = nowPlayingResponseSchema.parse({
        ok: true,
        ncmId,
        url: songUrl.url,
        durationMs: estimateDurationMs(songUrl.size, songUrl.br),
        lyric: lyric?.lyric ?? null,
        translation: lyric?.translation ?? null,
        timing: defaultTiming()
      });

      res.json(payload);
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNextHandler(ncmClient: NcmClient): RequestHandler {
  return async (req, res) => {
    const parsed = nextQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: NCM_ERROR_CODE.BAD_RESPONSE,
        message: 'missing queue query, e.g. ?queue=1,2,3&current=1'
      });
      return;
    }

    const queueIds = parseQueueIds(parsed.data.queue);
    const nextId = pickNextTrackId(queueIds, parsed.data.current);
    if (!nextId) {
      res
        .status(400)
        .json({ ok: false, error: NCM_ERROR_CODE.BAD_RESPONSE, message: 'queue has no next track' });
      return;
    }

    try {
      const songUrl = await ncmClient.getSongUrl(nextId);
      if (!songUrl?.url) {
        throw new NcmApiError(
          NCM_ERROR_CODE.BAD_RESPONSE,
          `NCM song url is unavailable for ncmId=${nextId}`
        );
      }

      const payload = nextTrackResponseSchema.parse({
        ok: true,
        track: { id: nextId },
        url: songUrl.url,
        durationMs: estimateDurationMs(songUrl.size, songUrl.br),
        timing: defaultTiming()
      });

      res.json(payload);
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function parseQueueIds(csv: string): string[] {
  return csv
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function pickNextTrackId(queueIds: string[], current?: string): string | null {
  if (queueIds.length === 0) {
    return null;
  }

  if (!current) {
    return queueIds[0];
  }

  const index = queueIds.indexOf(current);
  if (index === -1) {
    return queueIds[0];
  }

  return queueIds[index + 1] ?? null;
}

export function estimateDurationMs(
  size: number | null | undefined,
  bitrate: number | null | undefined
): number | null {
  if (
    typeof size !== 'number' ||
    typeof bitrate !== 'number' ||
    !Number.isFinite(size) ||
    !Number.isFinite(bitrate) ||
    size <= 0 ||
    bitrate <= 0
  ) {
    return null;
  }

  return Math.floor(((size * 8) / bitrate) * 1000);
}

function defaultTiming() {
  return {
    prefetchLeadSec: DEFAULT_PREFETCH_LEAD_SEC,
    crossfadeSec: DEFAULT_CROSSFADE_SEC,
    segueLeadSec: DEFAULT_SEGUE_LEAD_SEC
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
