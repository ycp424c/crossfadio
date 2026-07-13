import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { trackSchema } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import { TtsClient } from '../../tts/client.js';
import { resolveTtsConfig } from '../../tts/config.js';
import { getTtsCacheDir } from '../../tts/cache.js';
import { estimateTtsDurationSec } from '../../tts/duration.js';
import {
  buildFallbackTemplateText,
  ensureFallbackTtsCached,
  synthesizeTtsWithFallback
} from '../../tts/fallback.js';
import { getDjPickReason } from './djNext.js';
import { broadcastToUser } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { initSseRes, writeSseEvent, endSse } from '../sse.js';
import { generateSegue } from '../../dj-agent/segue.js';

const SEGUE_LLM_TIMEOUT_MS = 60_000;
const SEGUE_TTS_TIMEOUT_MS = 30_000;

const triggerBodySchema = z.object({
  clientRequestId: z.string().min(1).max(128).optional(),
  from: trackSchema,
  to: trackSchema
});

const sseSegueBodySchema = z.object({
  clientRequestId: z.string().min(1),
  from: z.object({ id: z.string().min(1), name: z.string().optional(), artist: z.string().optional() }),
  to: z.object({ id: z.string().min(1), name: z.string().optional(), artist: z.string().optional() })
});

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

type SegueRouteOptions = {
  secrets: any;
  ncmClient?: NcmClient;
};

type ActiveSegueJob = {
  requestId: string;
  clientRequestId: string | null;
  fromId: string;
  toId: string;
  controller: AbortController;
};

let activeJob: ActiveSegueJob | null = null;

export function _resetActiveSegueJobForTests(): void {
  if (activeJob) activeJob.controller.abort();
  activeJob = null;
}

export function createSegueTriggerHandler(opts: SegueRouteOptions) {
  return (req: Request, res: Response): void => {
    const parsed = triggerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    if (parsed.data.from.id === parsed.data.to.id) {
      res.status(400).json({ ok: false, error: 'from and to must be different tracks' });
      return;
    }

    const clientRequestId = parsed.data.clientRequestId ?? null;

    // Dedup: if same client request is in flight, return its existing requestId.
    if (
      activeJob &&
      clientRequestId !== null &&
      activeJob.clientRequestId === clientRequestId &&
      !activeJob.controller.signal.aborted
    ) {
      res.json({ ok: true, requestId: activeJob.requestId, clientRequestId });
      return;
    }

    // Abort any prior job; we only ever care about the latest segue request.
    if (activeJob && !activeJob.controller.signal.aborted) {
      activeJob.controller.abort();
    }

    const requestId = randomBytes(8).toString('hex');
    const controller = new AbortController();
    const job: ActiveSegueJob = {
      requestId,
      clientRequestId,
      fromId: parsed.data.from.id,
      toId: parsed.data.to.id,
      controller
    };
    activeJob = job;

    res.json({ ok: true, requestId, clientRequestId });

    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    void runSegueJob(job, parsed.data.from, parsed.data.to, opts, userId, ncmClient).finally(() => {
      if (activeJob === job) activeJob = null;
    });
  };
}

async function runSegueJob(
  job: ActiveSegueJob,
  from: z.infer<typeof trackSchema>,
  to: z.infer<typeof trackSchema>,
  opts: SegueRouteOptions,
  userId: string,
  ncmClient: NcmClient,
  sendEmit?: (payload: Record<string, unknown>, options?: { allowAborted?: boolean }) => void
): Promise<void> {
  const logger = getLogger();
  const { requestId, clientRequestId, controller } = job;
  const signal = controller.signal;

  const emit = sendEmit ?? ((payload: Record<string, unknown>, options: { allowAborted?: boolean } = {}): void => {
    if (signal.aborted && !options.allowAborted) return;
    broadcastToUser(userId, { ...payload, requestId, clientRequestId });
  });

  // Wire LLM/TTS hard timeouts to the same controller — abort cascades to all in-flight fetches.
  const llmTimeout = setTimeout(() => controller.abort(makeAbortReason('llm-timeout')), SEGUE_LLM_TIMEOUT_MS);
  let ttsTimeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const llmConfig = resolveLlmConfig(userId);
    if (!llmConfig) {
      emit({ type: 'segue.degraded', reason: 'no-llm' });
      return;
    }

    const segueResult = await generateSegue({
      userId,
      from,
      to,
      ncmClient,
      llmConfig,
      signal,
      djPickReasonFallback: getDjPickReason(to.id),
      emitDelta: (say) => emit({ type: 'segue.delta', say })
    });

    clearTimeout(llmTimeout);
    if (signal.aborted) return;

    if (!segueResult) {
      emit({ type: 'segue.degraded', reason: 'parse-failed' });
      return;
    }

    const segueOutput = segueResult.segue;
    const textDerivedSpeechDurationSec = estimateTtsDurationSec(segueOutput.say);

    const ttsConfig = resolveTtsConfig(userId);
    if (!ttsConfig) {
      emit({
        type: 'segue.tts-ready',
        audioUrl: null,
        speechDurationSec: textDerivedSpeechDurationSec,
        segue: segueOutput
      });
      return;
    }

    ttsTimeout = setTimeout(() => controller.abort(makeAbortReason('tts-timeout')), SEGUE_TTS_TIMEOUT_MS);

    const speechDurationSec = estimateTtsDurationSec(segueOutput.say, ttsConfig.speed);
    const ttsClient = new TtsClient(ttsConfig);
    const fallbackText = buildFallbackTemplateText(to);
    const ttsResult = await synthesizeTtsWithFallback(
      ttsConfig,
      segueOutput.say,
      fallbackText,
      (text) => ttsClient.synthesize(text, { signal })
    );

    if (ttsTimeout) {
      clearTimeout(ttsTimeout);
      ttsTimeout = null;
    }
    if (signal.aborted) return;

    if (!ttsResult.fallback) {
      void ensureFallbackTtsCached(ttsConfig, fallbackText, (text) => ttsClient.synthesize(text)).catch((err) => {
        logger.warn({ err }, 'Failed to warm fallback TTS template');
      });
    }

    emit({
      type: 'segue.tts-ready',
      audioUrl: buildSegueAudioUrl(ttsResult.filePath),
      speechDurationSec,
      fallbackTts: ttsResult.fallback,
      segue: segueOutput
    });
  } catch (err) {
    if (signal.aborted) {
      const reason = abortReason(controller.signal.reason) ?? 'aborted';
      logger.info({ requestId, clientRequestId, reason }, 'Segue job aborted');
      // Only the in-flight job's owner gets to broadcast a degraded signal — and only if the
      // reason is a timeout (not because a newer job replaced it).
      if (reason === 'llm-timeout' || reason === 'tts-timeout') {
        emit({ type: 'segue.degraded', reason }, { allowAborted: true });
      }
      return;
    }
    logger.warn({ err, requestId, clientRequestId }, 'Segue job failed');
    emit({ type: 'segue.degraded', reason: 'error' });
  } finally {
    clearTimeout(llmTimeout);
    if (ttsTimeout) clearTimeout(ttsTimeout);
  }
}

function makeAbortReason(reason: string): Error {
  const err = new Error(`segue:${reason}`);
  err.name = 'SegueAbortReason';
  return err;
}

function abortReason(value: unknown): string | null {
  if (value instanceof Error && value.name === 'SegueAbortReason') {
    return value.message.replace(/^segue:/, '');
  }
  return null;
}

export function createSseSegueHandler(opts: SegueRouteOptions) {
  return (req: Request, res: Response): void => {
    const parsed = sseSegueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    if (parsed.data.from.id === parsed.data.to.id) {
      res.status(400).json({ ok: false, error: 'from and to must be different tracks' });
      return;
    }

    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);

    initSseRes(res);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const clientRequestId = parsed.data.clientRequestId;
    const requestId = randomBytes(8).toString('hex');

    const sendSse = (payload: Record<string, unknown>): void => {
      const eventPayload = { ...payload, requestId, clientRequestId };
      const eventType = typeof payload.type === 'string' ? payload.type : 'message';
      writeSseEvent(res, eventType, eventPayload);
    };

    const job: ActiveSegueJob = {
      requestId,
      clientRequestId,
      fromId: parsed.data.from.id,
      toId: parsed.data.to.id,
      controller
    };

    runSegueJob(job, parsed.data.from, parsed.data.to, opts, userId, ncmClient, sendSse)
      .then(() => {
        endSse(res, 'segue.done', { requestId, clientRequestId });
      })
      .catch((err) => {
        const logger = getLogger();
        logger.warn({ err, requestId, clientRequestId }, 'SSE segue job failed');
        endSse(res, 'segue.degraded', { requestId, clientRequestId, reason: 'error' });
      });
  };
}

export function createSegueAudioHandler() {
  return (req: Request, res: Response): void => {
    const relativePath = req.params[0];
    if (!isSafeTtsRelativePath(relativePath)) {
      res.status(400).json({ ok: false, error: 'invalid audio path' });
      return;
    }
    res.sendFile(relativePath, { root: getTtsCacheDir() }, (err) => {
      // sendFile may invoke the callback even after headers were sent
      // (e.g. client disconnect mid-stream). Only respond if headers
      // haven't been sent yet; otherwise the error would crash the process.
      if (err && !res.headersSent) {
        try {
          res.status(404).json({ ok: false, error: 'not found' });
        } catch {
          // best-effort: if headers were sent between check and send, don't crash
        }
      }
    });
  };
}

export function buildSegueAudioUrl(filePath: string): string {
  const relativePath = path.relative(getTtsCacheDir(), filePath);
  if (!isSafeTtsRelativePath(relativePath)) {
    return `/api/segue/audio/${encodeURIComponent(path.basename(filePath))}`;
  }
  return `/api/segue/audio/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function isSafeTtsRelativePath(value: string | undefined): value is string {
  if (!value) return false;
  return !path.isAbsolute(value) && !value.includes('..') && !value.includes('\\');
}

function getScopedNcmClient(req: Request, fallback?: NcmClient): NcmClient {
  const ncmClient = (req as Partial<AuthedRequest>).ncmClient ?? fallback;
  if (!ncmClient) {
    throw new Error('NCM client missing from request scope');
  }
  return ncmClient;
}
