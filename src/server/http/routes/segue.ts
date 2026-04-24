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
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
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
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

const triggerBodySchema = z.object({
  from: trackSchema,
  to: trackSchema
});

type SegueRouteOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

export function createSegueTriggerHandler(opts: SegueRouteOptions) {
  return (req: Request, res: Response): void => {
    const parsed = triggerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    const requestId = randomBytes(8).toString('hex');
    res.json({ ok: true, requestId });

    void runSegueJob(requestId, parsed.data.from, parsed.data.to, opts);
  };
}

async function runSegueJob(
  requestId: string,
  from: z.infer<typeof trackSchema>,
  to: z.infer<typeof trackSchema>,
  opts: SegueRouteOptions
): Promise<void> {
  const logger = getLogger();

  try {
    const llmConfig = resolveLlmConfig(opts.secrets);
    if (!llmConfig) {
      broadcast({ type: 'segue.degraded', requestId, reason: 'no-llm' });
      return;
    }

    const corpus = loadUserCorpus();
    const likedTracks = await loadLikedTracksForPlanning(opts.ncmClient);
    const trackContext = await loadSegueContext(from, to, opts.ncmClient, logger);
    const weather = await fetchWeather();
    const now = new Date();

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
      memory: { recentPlays: getRecentPlays(50), recentChat: getRecentMessages(20) },
      input: {
        kind: 'segueTrigger',
        from: trackContext.fromTrack,
        to: trackContext.toTrack,
        context: {
          from: trackContext.fromContext,
          to: trackContext.toContext
        }
      },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    let sayText = '';
    let finalOutput: unknown = null;

    for await (const event of computeStream(fragments, { llmConfig })) {
      if (event.type === 'delta') {
        sayText += event.say;
        broadcast({ type: 'segue.delta', requestId, say: event.say });
      } else if (event.type === 'done') {
        finalOutput = event.output;
      }
    }

    if (!finalOutput || typeof finalOutput !== 'object' || !('say' in finalOutput)) {
      broadcast({ type: 'segue.degraded', requestId, reason: 'parse-failed' });
      return;
    }

    const segueOutput = finalOutput as {
      say: string;
      duckingHintSec: number;
      filterSweep: boolean;
      emotionTag: string;
    };
    const textDerivedSpeechDurationSec = estimateTtsDurationSec(segueOutput.say);

    // Synthesize TTS
    const ttsConfig = resolveTtsConfig(opts.secrets);
    if (!ttsConfig) {
      broadcast({
        type: 'segue.tts-ready',
        requestId,
        audioUrl: null,
        speechDurationSec: textDerivedSpeechDurationSec,
        segue: segueOutput
      });
      return;
    }

    const speechDurationSec = estimateTtsDurationSec(segueOutput.say, ttsConfig.speed);
    const ttsClient = new TtsClient(ttsConfig);
    const fallbackText = buildFallbackTemplateText(to);
    const ttsResult = await synthesizeTtsWithFallback(
      ttsConfig,
      segueOutput.say,
      fallbackText,
      (text) => ttsClient.synthesize(text)
    );

    if (!ttsResult.fallback) {
      void ensureFallbackTtsCached(ttsConfig, fallbackText, (text) => ttsClient.synthesize(text)).catch((err) => {
        logger.warn({ err }, 'Failed to warm fallback TTS template');
      });
    }

    broadcast({
      type: 'segue.tts-ready',
      requestId,
      audioUrl: buildSegueAudioUrl(ttsResult.filePath),
      speechDurationSec,
      fallbackTts: ttsResult.fallback,
      segue: segueOutput
    });
  } catch (err) {
    logger.warn({ err }, 'Segue job failed');
    broadcast({ type: 'segue.degraded', requestId, reason: 'error' });
  }
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
      if (err) res.status(404).json({ ok: false, error: 'not found' });
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
