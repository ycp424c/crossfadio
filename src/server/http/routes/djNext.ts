import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { setQueueState } from '../../store/queue.js';
import { broadcastToUser } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { initSseRes, writeSseEvent, endSse } from '../sse.js';
import { createDjPickNextRunner } from '../../dj/pickNextRunner.js';
import { getAutoFillBatchSize, getJobTimeoutMs, runDjPickNext } from '../../dj/pickNextRun.js';

export {
  buildDiscoveryModePromptParts,
  buildDjTimeContext,
  buildTrackDedupeKey,
  getCandidateSourceMix,
  getDjPickReason,
  getMusicAgentCandidateSourceDiagnostics,
  isTrackDedupeKeyExcluded,
  parseDjCandidatePicks,
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
      id: z.string().min(1),
      name: z.string().optional(),
      artists: z.array(z.string()).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      coverImgUrl: z.string().nullable().optional()
    })
  ).optional(),
  currentIndex: z.number().int().nonnegative().optional()
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
    applyClientQueueSnapshot(req, userId);
    res.json({ ok: true, running: false });
    void djPickNextRunner.run({
      userId,
      ncmClient,
      onTimeout: ({ jobTimeoutMs }) => {
        getLogger().warn('DJ pick-next job timed out after %dms', jobTimeoutMs);
        broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'timeout' });
      }
    });
  };
}

function applyClientQueueSnapshot(req: Request, userId: string): void {
  const parsed = pickNextBodySchema.safeParse(req.body);
  if (!parsed.success || !parsed.data?.queue) return;

  setQueueState(
    userId,
    parsed.data.queue.map((track) => ({
      ncmId: track.id,
      name: track.name,
      artists: track.artists,
      durationMs: track.durationMs,
      coverImgUrl: track.coverImgUrl
    })),
    parsed.data.currentIndex ?? 0
  );
}

export function createSseDjPickNextHandler(opts: DjNextOptions) {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    initSseRes(res);
    if (djPickNextRunner.isRunning(userId)) {
      endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' });
      return;
    }
    applyClientQueueSnapshot(req, userId);
    const emit = (payload: Record<string, unknown>): void => {
      const type = typeof payload.type === 'string' ? payload.type : 'message';
      broadcastToUser(userId, payload);
      try { writeSseEvent(res, type, payload); } catch { /* disconnect */ }
    };
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));
    void djPickNextRunner.run({ userId, ncmClient, emit, signal: controller.signal }).then((result) => {
      if (result.status === 'already-running' && !res.writableEnded) {
        endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' });
        return;
      }
      if (result.status === 'timeout' && !res.writableEnded) {
        endSse(res, 'dj.pick-next.done', { added: false, reason: 'timeout' });
        return;
      }
      if (!res.writableEnded) res.end();
    }).catch((_err: Error) => {
      if (!res.writableEnded) endSse(res, 'dj.pick-next.done', { added: false, reason: 'error' });
    });
    req.on('close', () => { if (!res.writableEnded) res.end(); });
  };
}

function getScopedNcmClient(req: Request, fallback?: NcmClient): NcmClient {
  const ncmClient = (req as Partial<AuthedRequest>).ncmClient ?? fallback;
  if (!ncmClient) {
    throw new Error('NCM client missing from request scope');
  }
  return ncmClient;
}
