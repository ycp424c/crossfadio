import { computeStream } from '../agent/compute.js';
import { buildSystemPrompt } from '../agent/modes.js';
import { segueOutputSchema, trackSchema, type Fragments, type SegueOutput } from '../agent/schema.js';
import { buildSegueTrackContext } from '../agent/segue-context.js';
import type { LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import { getLogger } from '../logger.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { loadLikedTracksForAgentContext } from '../user-corpus/ncm-liked.js';
import { getRecentMessages } from '../store/messages.js';
import { getRecentPlays } from '../store/plays.js';
import { getRecentSegues, saveSegue } from '../store/segues.js';
import { appendDjEvent, getRecentTrackSelectedEvent, type DjEventRecord } from '../store/dj-events.js';
import { getDailyTheme } from '../daily-theme.js';
import { getPref } from '../store/prefs.js';
import { fetchWeather } from '../weather.js';
import type { z } from 'zod';
import { buildDjContextSnapshot } from './context.js';

export type GenerateSegueInput = {
  userId: string;
  from: z.infer<typeof trackSchema>;
  to: z.infer<typeof trackSchema>;
  ncmClient: NcmClient;
  llmConfig: LlmConfig;
  signal?: AbortSignal;
  emitDelta?: (say: string) => void;
  now?: Date;
  djPickReasonFallback?: string | null;
};

export type GenerateSegueResult = {
  segue: SegueOutput;
  fromTrack: z.infer<typeof trackSchema>;
  toTrack: z.infer<typeof trackSchema>;
  selectionEvent: DjEventRecord | null;
};

export async function generateSegue(input: GenerateSegueInput): Promise<GenerateSegueResult | null> {
  const logger = getLogger();
  const now = input.now ?? new Date();
  const corpus = loadUserCorpus(input.userId);
  const likedTracks = await loadLikedTracksForAgentContext(input.ncmClient);
  if (input.signal?.aborted) return null;

  const [trackContext, weather, djSnapshot] = await Promise.all([
    loadSegueContext(input.from, input.to, input.ncmClient, logger),
    fetchWeather(input.userId),
    buildDjContextSnapshot({
      userId: input.userId,
      ncmClient: input.ncmClient,
      includeDailyTheme: getPref<boolean>(input.userId, 'dailyTheme.enabled') !== false,
      now,
      recentEventLimit: 20
    })
  ]);
  if (input.signal?.aborted) return null;

  const dailyThemeEnabled = getPref<boolean>(input.userId, 'dailyTheme.enabled') !== false;
  const dailyTheme = dailyThemeEnabled ? getDailyTheme() : null;
  const dailyThemeStr = dailyTheme
    ? `今日主题：${dailyTheme.theme}（关键词：${dailyTheme.keywords.join('、')}）`
    : undefined;
  const selectionEvent = getRecentTrackSelectedEvent(input.userId, input.to.id);
  const selectionRationale = getSelectionRationale(selectionEvent);
  const personalSegueGuidance = djSnapshot.personalDjContext
    ? {
        summary: djSnapshot.personalDjContext.summary,
        tone: djSnapshot.personalDjContext.segueGuidance.tone,
        privacyRule: djSnapshot.personalDjContext.segueGuidance.privacyRule
      }
    : undefined;

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
        id: input.from.id,
        name: trackContext.fromTrack.name ?? '',
        artist: trackContext.fromTrack.artist ?? '',
        durationMs: null
      },
      dailyTheme: dailyThemeStr
    },
    memory: {
      recentPlays: getRecentPlays(input.userId, 50),
      recentChat: getRecentMessages(input.userId, 20),
      recentSegues: getRecentSegues(input.userId, 10)
    },
    input: {
      kind: 'segueTrigger',
      from: trackContext.fromTrack,
      to: trackContext.toTrack,
      context: {
        from: trackContext.fromContext,
        to: trackContext.toContext,
        ...(input.djPickReasonFallback ? { djPickReason: input.djPickReasonFallback } : {}),
        ...(selectionRationale ? { selectionRationale } : {}),
        ...(selectionEvent ? { selectionEventId: selectionEvent.id } : {}),
        ...(personalSegueGuidance ? { personalSegueGuidance } : {})
      }
    },
    trace: { triggeredBy: 'segue-hook', lastDecision: null }
  };

  let finalOutput: unknown = null;
  for await (const event of computeStream(fragments, { llmConfig: input.llmConfig, signal: input.signal })) {
    if (input.signal?.aborted) return null;
    if (event.type === 'delta') {
      input.emitDelta?.(event.say);
    } else if (event.type === 'done') {
      finalOutput = event.output;
    }
  }

  const parsed = segueOutputSchema.safeParse(finalOutput);
  if (!parsed.success) return null;
  const segue = parsed.data;
  saveSegue(input.userId, {
    fromId: input.from.id,
    fromName: trackContext.fromTrack.name,
    toId: input.to.id,
    toName: trackContext.toTrack.name,
    say: segue.say
  });
  appendDjEvent({
    userId: input.userId,
    type: 'segue_generated',
    correlationId: selectionEvent?.correlationId,
    causationEventId: selectionEvent?.id,
    runId: selectionEvent?.runId ?? undefined,
    trackId: input.to.id,
    payload: {
      fromTrackId: input.from.id,
      toTrackId: input.to.id,
      ...(selectionEvent ? { selectionEventId: selectionEvent.id } : {}),
      segueSummary: segue.say
    }
  });

  return {
    segue,
    fromTrack: trackContext.fromTrack,
    toTrack: trackContext.toTrack,
    selectionEvent
  };
}

function getSelectionRationale(event: DjEventRecord | null): string | null {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object') return null;
  const rationale = (payload as { selectionRationale?: unknown }).selectionRationale;
  return typeof rationale === 'string' && rationale.trim() ? rationale.trim() : null;
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

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}
