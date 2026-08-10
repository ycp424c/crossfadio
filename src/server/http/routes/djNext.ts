import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import {
  compareAndSetQueueState,
  getQueueStateSnapshot,
  type QueueStateSnapshot
} from '../../store/queue.js';
import { broadcastToUser } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { initSseRes, writeSseEvent, endSse } from '../sse.js';
import { createDjPickNextRunner } from '../../dj/pickNextRunner.js';
import { getAutoFillBatchSize, getJobTimeoutMs, runDjPickNext } from '../../dj/pickNextRun.js';
import {
  MAX_QUEUE_TRACK_ARTIST_LENGTH,
  MAX_QUEUE_TRACK_ARTISTS,
  MAX_QUEUE_TRACK_COVER_URL_LENGTH,
  MAX_QUEUE_TRACK_ID_LENGTH,
  MAX_QUEUE_TRACK_NAME_LENGTH,
  MAX_QUEUE_TRACKS
} from '../../../shared/queue.js';
import {
  acquireResourcePermit,
  ResourceLimitError,
  type ResourcePermit
} from '../../resource-governor.js';
import { sendResourceLimitResponse } from '../resource-limit-response.js';

export {
  buildTrackDedupeKey,
  getDjPickReason,
  getMusicAgentCandidateSourceDiagnostics,
  isTrackDedupeKeyExcluded,
  searchCandidates,
  serializeDjPickNextErrorForLog
} from '../../dj/pickNextRun.js';
export type { DiscoveryMode, DjPickNextFallbackPath } from '../../dj/pickNextRun.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

type DjNextOptions = {
  secrets: any;
  ncmClient?: NcmClient;
};

const pickNextBodySchema = z.object({
  queue: z.array(
    z.object({
      id: z.string().min(1).max(MAX_QUEUE_TRACK_ID_LENGTH),
      name: z.string().max(MAX_QUEUE_TRACK_NAME_LENGTH).optional(),
      artists: z.array(z.string().min(1).max(MAX_QUEUE_TRACK_ARTIST_LENGTH))
        .max(MAX_QUEUE_TRACK_ARTISTS).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      coverImgUrl: z.string().max(MAX_QUEUE_TRACK_COVER_URL_LENGTH).nullable().optional()
    })
  ).max(MAX_QUEUE_TRACKS).optional(),
  currentIndex: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional()
}).superRefine((value, context) => {
  if (value.queue && value.revision === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revision'],
      message: 'revision is required when queue is present'
    });
  }
}).optional();

const djPickNextRunner = createDjPickNextRunner({
  getTargetPickCount: getAutoFillBatchSize,
  getJobTimeoutMs,
  runPickNext: ({ userId, ncmClient, emit, signal }) => runDjPickNext(userId, ncmClient, emit, signal)
});

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    if (djPickNextRunner.isRunning(userId)) {
      res.json({ ok: true, running: true });
      return;
    }
    const queueUpdate = applyClientQueueSnapshot(req, userId);
    if (queueUpdate.status === 'invalid') {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    if (!queueUpdate.applied) {
      res.status(409).json(queueConflictPayload(queueUpdate.snapshot));
      return;
    }
    let permit: ResourcePermit;
    try {
      permit = acquireResourcePermit(userId, 'dj_pick_next');
    } catch (err) {
      if (err instanceof ResourceLimitError) {
        sendResourceLimitResponse(res, err);
        return;
      }
      throw err;
    }
    res.json({ ok: true, running: false });
    void djPickNextRunner.run({
      userId,
      ncmClient,
      onTimeout: ({ jobTimeoutMs }) => {
        getLogger().warn('DJ pick-next job timed out after %dms', jobTimeoutMs);
        broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'timeout' });
      }
    }).finally(() => permit.release());
  };
}

function applyClientQueueSnapshot(
  req: Request,
  userId: string
): { status: 'valid'; applied: boolean; snapshot: QueueStateSnapshot } | { status: 'invalid' } {
  const parsed = pickNextBodySchema.safeParse(req.body);
  if (!parsed.success) return { status: 'invalid' };
  if (!parsed.data?.queue) {
    return { status: 'valid', applied: true, snapshot: getQueueStateSnapshot(userId) };
  }

  const queue = parsed.data.queue.map((track) => ({
      ncmId: track.id,
      name: track.name,
      artists: track.artists,
      durationMs: track.durationMs,
      coverImgUrl: track.coverImgUrl
    }));
  const update = compareAndSetQueueState(
    userId,
    parsed.data.revision!,
    queue,
    parsed.data.currentIndex ?? 0
  );
  return { status: 'valid', ...update };
}

export function createSseDjPickNextHandler(opts: DjNextOptions) {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    if (djPickNextRunner.isRunning(userId)) {
      initSseRes(res);
      endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' });
      return;
    }
    // Body validation and queue CAS complete BEFORE any permit is acquired or
    // SSE headers are committed: malformed/stale requests stay ordinary JSON
    // 400/409, never charge credits, and never start provider work.
    const queueUpdate = applyClientQueueSnapshot(req, userId);
    if (queueUpdate.status === 'invalid') {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    if (!queueUpdate.applied) {
      // Preserve the client's auto-correction: the stale-queue rejection stays
      // an ordinary JSON 409 (no SSE headers, no credits, no provider work),
      // but the authoritative queue-updated payload is broadcast over the
      // persistent SSE stream first so the player can re-sync before retrying.
      broadcastToUser(userId, {
        type: 'queue-updated',
        queue: queueUpdate.snapshot.queue,
        currentIndex: queueUpdate.snapshot.currentIndex,
        revision: queueUpdate.snapshot.revision
      });
      res.status(409).json(queueConflictPayload(queueUpdate.snapshot));
      return;
    }
    let permit: ResourcePermit;
    try {
      permit = acquireResourcePermit(userId, 'dj_pick_next');
    } catch (err) {
      if (err instanceof ResourceLimitError) {
        sendResourceLimitResponse(res, err);
        return;
      }
      throw err;
    }
    initSseRes(res);
    const emit = (payload: Record<string, unknown>): void => {
      const type = typeof payload.type === 'string' ? payload.type : 'message';
      broadcastToUser(userId, payload);
      try { writeSseEvent(res, type, payload); } catch { /* disconnect */ }
    };
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));
    void djPickNextRunner.run({
      userId,
      ncmClient,
      emit,
      signal: controller.signal,
      onTimeout: () => {
        // End the SSE response immediately on timeout so the client is
        // notified right away; the permit stays held until the runner's
        // underlying job truly settles.
        if (!res.writableEnded) {
          endSse(res, 'dj.pick-next.done', { added: false, reason: 'timeout' });
        }
      }
    }).then((result) => {
      if (result.status === 'already-running' && !res.writableEnded) {
        endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' });
        return;
      }
      if (!res.writableEnded) res.end();
    }).catch((_err: Error) => {
      if (!res.writableEnded) endSse(res, 'dj.pick-next.done', { added: false, reason: 'error' });
    }).finally(() => permit.release());
    req.on('close', () => { if (!res.writableEnded) res.end(); });
  };
}

function queueConflictPayload(snapshot: QueueStateSnapshot): Record<string, unknown> {
  return {
    ok: false,
    error: 'queue_revision_conflict',
    type: 'queue-updated',
    queue: snapshot.queue,
    currentIndex: snapshot.currentIndex,
    revision: snapshot.revision
  };
}

function getScopedNcmClient(req: Request, fallback?: NcmClient): NcmClient {
  const ncmClient = (req as Partial<AuthedRequest>).ncmClient ?? fallback;
  if (!ncmClient) {
    throw new Error('NCM client missing from request scope');
  }
  return ncmClient;
}
