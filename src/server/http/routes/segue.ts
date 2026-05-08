import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { computeStream } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import { trackSchema } from '../../agent/schema.js';
import type { Fragments } from '../../agent/schema.js';
import { buildSegueTrackContext } from '../../agent/segue-context.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { saveSegue, getRecentSegues } from '../../store/segues.js';
import { fetchWeather } from '../../weather.js';
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

const SEGUE_LLM_TIMEOUT_MS = 60_000;
const SEGUE_TTS_TIMEOUT_MS = 30_000;

const triggerBodySchema = z.object({
  clientRequestId: z.string().min(1).max(128).optional(),
  from: trackSchema,
  to: trackSchema
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
  ncmClient: NcmClient
): Promise<void> {
  const logger = getLogger();
  const { requestId, clientRequestId, controller } = job;
  const signal = controller.signal;

  const emit = (payload: Record<string, unknown>, options: { allowAborted?: boolean } = {}): void => {
    if (signal.aborted && !options.allowAborted) return;
    broadcastToUser(userId, { ...payload, requestId, clientRequestId });
  };

  // Wire LLM/TTS hard timeouts to the same controller — abort cascades to all in-flight fetches.
  const llmTimeout = setTimeout(() => controller.abort(makeAbortReason('llm-timeout')), SEGUE_LLM_TIMEOUT_MS);
  let ttsTimeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const llmConfig = resolveLlmConfig();
    if (!llmConfig) {
      emit({ type: 'segue.degraded', reason: 'no-llm' });
      return;
    }

    const corpus = loadUserCorpus(userId);
    const likedTracks = await loadLikedTracksForPlanning(ncmClient);
    if (signal.aborted) return;
    const trackContext = await loadSegueContext(from, to, ncmClient, logger);
    if (signal.aborted) return;
    const weather = await fetchWeather(userId);
    if (signal.aborted) return;
    const now = new Date();

    const djPickReason = getDjPickReason(to.id);

    const fragments: Fragments = {
      mode: 'segue',
      system: buildSystemPrompt(corpus.djPersona || 'You are a DJ.', 'segue'),
      corpus: {
        taste: corpus.taste,
        routines: corpus.routines,
        moodRules: corpus.moodRules,
        playlists: corpus.playlists,
        likedTracks
      },
      env: {
        nowIso: now.toISOString(),
        localTime: formatLocalTime(now),
        weather,
        nowPlaying: {
          id: from.id,
          name: trackContext.fromTrack.name ?? '',
          artist: trackContext.fromTrack.artist ?? '',
          durationMs: null
        }
      },
      memory: { recentPlays: getRecentPlays(userId, 50), recentChat: getRecentMessages(userId, 20), recentSegues: getRecentSegues(userId, 10) },
      input: {
        kind: 'segueTrigger',
        from: trackContext.fromTrack,
        to: trackContext.toTrack,
        context: {
          from: trackContext.fromContext,
          to: trackContext.toContext,
          ...(djPickReason ? { djPickReason } : {})
        }
      },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    let finalOutput: unknown = null;

    for await (const event of computeStream(fragments, { llmConfig, signal })) {
      if (signal.aborted) return;
      if (event.type === 'delta') {
        emit({ type: 'segue.delta', say: event.say });
      } else if (event.type === 'done') {
        finalOutput = event.output;
      }
    }

    clearTimeout(llmTimeout);
    if (signal.aborted) return;

    if (!finalOutput || typeof finalOutput !== 'object' || !('say' in finalOutput)) {
      emit({ type: 'segue.degraded', reason: 'parse-failed' });
      return;
    }

    const segueOutput = finalOutput as {
      say: string;
      duckingHintSec: number;
      filterSweep: boolean;
      emotionTag: string;
    };
    const textDerivedSpeechDurationSec = estimateTtsDurationSec(segueOutput.say);

    saveSegue(userId, {
      fromId: from.id,
      fromName: trackContext.fromTrack.name,
      toId: to.id,
      toName: trackContext.toTrack.name,
      say: segueOutput.say
    });

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

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
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

async function loadSegueContext(
  from: z.infer<typeof trackSchema>,
  to: z.infer<typeof trackSchema>,
  ncmClient: NcmClient,
  logger: ReturnType<typeof getLogger>
): Promise<{
  fromTrack: z.infer<typeof trackSchema>;
  toTrack: z.infer<typeof trackSchema>;
  fromContext: ReturnType<typeof buildSegueTrackContext>;
  toContext: ReturnType<typeof buildSegueTrackContext>;
}> {
  const [detailRows, fromLyric, toLyric, fromWikiSummary, toWikiSummary] = await Promise.all([
    ncmClient.getSongDetails([from.id, to.id]).catch((err) => {
      logger.debug({ err, fromId: from.id, toId: to.id }, 'Failed to load song details for segue context');
      return [];
    }),
    ncmClient.getLyric(from.id).catch((err) => {
      logger.debug({ err, id: from.id }, 'Failed to load source lyric for segue context');
      return null;
    }),
    ncmClient.getLyric(to.id).catch((err) => {
      logger.debug({ err, id: to.id }, 'Failed to load target lyric for segue context');
      return null;
    }),
    ncmClient.getSongWikiSummary(from.id).catch((err) => {
      logger.debug({ err, id: from.id }, 'Failed to load source wiki summary for segue context');
      return null;
    }),
    ncmClient.getSongWikiSummary(to.id).catch((err) => {
      logger.debug({ err, id: to.id }, 'Failed to load target wiki summary for segue context');
      return null;
    })
  ]);

  const detailMap = new Map(detailRows.map((detail) => [String(detail.id), detail]));
  const fromContext = buildSegueTrackContext({
    track: from,
    detail: detailMap.get(from.id) ?? null,
    lyric: fromLyric,
    wikiSummary: fromWikiSummary
  });
  const toContext = buildSegueTrackContext({
    track: to,
    detail: detailMap.get(to.id) ?? null,
    lyric: toLyric,
    wikiSummary: toWikiSummary
  });

  return {
    fromTrack: {
      id: from.id,
      name: fromContext.name,
      artist: fromContext.artist
    },
    toTrack: {
      id: to.id,
      name: toContext.name,
      artist: toContext.artist
    },
    fromContext,
    toContext
  };
}
