import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { trackSchema } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import { beginForegroundLlmWork } from '../../llm/foreground-activity.js';
import type { NcmClient } from '../../ncm/client.js';
import { TENCENT_TTS_MAX_INPUT_UNITS, TtsClient, type TtsConfig } from '../../tts/client.js';
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
import {
  acquireResourcePermit,
  ResourceLimitError,
  type ResourcePermit
} from '../../resource-governor.js';
import { sendResourceLimitResponse } from '../resource-limit-response.js';

const SEGUE_LLM_TIMEOUT_MS = 60_000;
const SEGUE_TTS_TIMEOUT_MS = 30_000;
const SEGUE_TTS_WARM_TIMEOUT_MS = 15_000;

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
  userId: string;
  requestId: string;
  clientRequestId: string | null;
  fromId: string;
  toId: string;
  controller: AbortController;
  /** Resolves after the job fully settles and its permit has been released. */
  settled: Promise<void>;
};

const activeJobsByUser = new Map<string, ActiveSegueJob>();

export function _resetActiveSegueJobForTests(): void {
  for (const job of activeJobsByUser.values()) job.controller.abort();
  activeJobsByUser.clear();
}

export function createSegueTriggerHandler(opts: SegueRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = triggerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    if (parsed.data.from.id === parsed.data.to.id) {
      res.status(400).json({ ok: false, error: 'from and to must be different tracks' });
      return;
    }

    const userId = (req as AuthedRequest).userId;
    const clientRequestId = parsed.data.clientRequestId ?? null;

    // Latest-wins replacement must be serial, and multiple concurrent
    // replacements may be waiting on the SAME old job. Re-check the active job
    // on every wakeup (CAS-style loop): whichever request wakes first starts
    // its job; every later waiter then aborts that just-started replacement
    // and waits for it to truly settle before acquiring/charging/starting its
    // own. This keeps the truly latest request running, never 429s a later
    // standard request, and never lets priority replacements run in parallel.
    for (;;) {
      const activeJob = activeJobsByUser.get(userId);

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

      if (!activeJob) break;

      // Abort the old job, wait for it to truly settle and release its permit,
      // and only then re-check the active job and (if still the latest) start.
      activeJob.controller.abort();
      await activeJob.settled;
    }

    let permit: ResourcePermit;
    try {
      permit = acquireResourcePermit(userId, 'segue');
    } catch (err) {
      if (err instanceof ResourceLimitError) {
        sendResourceLimitResponse(res, err);
        return;
      }
      throw err;
    }

    const requestId = randomBytes(8).toString('hex');
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const job: ActiveSegueJob = {
      userId,
      requestId,
      clientRequestId,
      fromId: parsed.data.from.id,
      toId: parsed.data.to.id,
      controller,
      settled
    };
    activeJobsByUser.set(userId, job);

    res.json({ ok: true, requestId, clientRequestId });

    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    void runSegueJob(job, parsed.data.from, parsed.data.to, opts, userId, ncmClient).finally(() => {
      if (activeJobsByUser.get(userId) === job) activeJobsByUser.delete(userId);
      permit.release();
      resolveSettled();
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

    const releaseForegroundLlm = beginForegroundLlmWork();
    const ttsProvider = resolveTtsConfig(userId).provider;
    let segueResult: Awaited<ReturnType<typeof generateSegue>>;
    try {
      segueResult = await generateSegue({
        userId,
        from,
        to,
        ncmClient,
        llmConfig,
        signal,
        djPickReasonFallback: getDjPickReason(userId, to.id),
        emitDelta: (say) => emit({ type: 'segue.delta', say }),
        // 腾讯 TextToVoice 有文本长度上限：在保存/展示/估时之前统一截断，保证音频、文案与时序一致。
        maxSayUnits: ttsProvider === 'tencent-cloud' ? TENCENT_TTS_MAX_INPUT_UNITS : undefined
      });
    } finally {
      releaseForegroundLlm();
    }

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

    // Deliver tts-ready first so the user stays responsive; the fallback
    // template warm then completes INSIDE the same segue permit lifecycle.
    emit({
      type: 'segue.tts-ready',
      audioUrl: buildSegueAudioUrl(ttsResult.filePath),
      speechDurationSec,
      fallbackTts: ttsResult.fallback,
      segue: segueOutput
    });

    // Cold-cache warm: bounded (SEGUE_TTS_WARM_TIMEOUT_MS) and abortable via
    // the segue controller. A warm failure is logged only — it must never turn
    // an already-successful segue into a failure.
    if (!ttsResult.fallback) {
      await warmFallbackTtsWithinPermit(ttsConfig, fallbackText, ttsClient, signal);
    }
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

/**
 * Warm the fallback TTS template under the CURRENT segue permit. Bounded by
 * SEGUE_TTS_WARM_TIMEOUT_MS and linked to the segue abort signal; failures are
 * logged only so a successful main segue is never degraded by warm problems.
 */
async function warmFallbackTtsWithinPermit(
  ttsConfig: TtsConfig,
  fallbackText: string,
  ttsClient: TtsClient,
  signal: AbortSignal
): Promise<void> {
  const logger = getLogger();
  const warmController = new AbortController();
  const warmTimer = setTimeout(
    () => warmController.abort(new Error('warm-timeout')),
    SEGUE_TTS_WARM_TIMEOUT_MS
  );
  const abortFromParent = (): void => {
    warmController.abort(signal.reason ?? new Error('aborted'));
  };
  if (signal.aborted) abortFromParent();
  else signal.addEventListener('abort', abortFromParent, { once: true });
  try {
    await ensureFallbackTtsCached(ttsConfig, fallbackText, (text) =>
      ttsClient.synthesize(text, { signal: warmController.signal })
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to warm fallback TTS template');
  } finally {
    clearTimeout(warmTimer);
    signal.removeEventListener('abort', abortFromParent);
  }
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

    let permit: ResourcePermit;
    try {
      permit = acquireResourcePermit(userId, 'segue');
    } catch (err) {
      if (err instanceof ResourceLimitError) {
        sendResourceLimitResponse(res, err);
        return;
      }
      throw err;
    }

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
      userId,
      requestId,
      clientRequestId,
      fromId: parsed.data.from.id,
      toId: parsed.data.to.id,
      controller,
      // SSE jobs are never replaced through activeJobsByUser; the settled
      // signal is unused here.
      settled: Promise.resolve()
    };

    runSegueJob(job, parsed.data.from, parsed.data.to, opts, userId, ncmClient, sendSse)
      .then(() => {
        endSse(res, 'segue.done', { requestId, clientRequestId });
      })
      .catch((err) => {
        const logger = getLogger();
        logger.warn({ err, requestId, clientRequestId }, 'SSE segue job failed');
        endSse(res, 'segue.degraded', { requestId, clientRequestId, reason: 'error' });
      })
      .finally(() => permit.release());
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
