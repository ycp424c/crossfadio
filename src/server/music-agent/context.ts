import type { NcmClient } from '../ncm/client.js';
import { fetchWeather } from '../weather.js';
import { getDailyTheme } from '../daily-theme.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { getRecentPlays } from '../store/plays.js';
import { getQueue } from '../store/queue.js';
import { getPref } from '../store/prefs.js';
import { loadLatestPlan } from '../store/plan.js';
import {
  musicAgentContextSummarySchema,
  type MusicAgentContextSummary
} from './schema.js';

const WEATHER_TIMEOUT_MS = 1500;

export type BuildMusicAgentContextInput = {
  userId: string;
  ncmClient?: NcmClient;
  request: 'auto-fill' | 'chat-recommend';
  userText?: string;
  now?: Date;
};

type ActiveDirectivePref = {
  text?: string;
  expiresAt?: string;
};

export async function buildMusicAgentContext(input: BuildMusicAgentContextInput): Promise<MusicAgentContextSummary> {
  const now = input.now ?? new Date();
  const weather = await fetchWeatherWithTimeout(input.userId);
  const theme = getDailyTheme();

  const context: MusicAgentContextSummary = {
    request: input.request,
    currentUserText: input.request === 'chat-recommend' ? truncate(input.userText ?? '', 600) : '',
    currentMoment: {
      localTime: formatLocalTime(now),
      daypart: getDaypart(now.getHours()),
      weather: weather ? `${weather.tempC}°C，${weather.desc}` : null,
      ...(theme ? { dailyTheme: `${theme.theme}（${theme.keywords.join('、')}）` } : {})
    },
    activeDirective: getActiveDirective(input.userId, now),
    currentPlanSegment: buildCurrentPlanSegment(input.userId, now),
    tasteSummary: buildTasteSummary(input.userId),
    recentPreferenceSummary: truncate(getPreferenceContext(input.userId, 3), 600),
    recentPlaySignals: buildRecentPlaySignals(input.userId),
    queueStateSummary: buildQueueStateSummary(input.userId),
    bannedSummary: buildBannedSummary(input.userId)
  };

  return musicAgentContextSummarySchema.parse(context);
}

async function fetchWeatherWithTimeout(userId: string) {
  return withTimeout(fetchWeather(userId).catch(() => null), WEATHER_TIMEOUT_MS, null);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}

function getDaypart(hour: number): string {
  if (hour >= 5 && hour < 9) return '早晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19) return '傍晚';
  if (hour >= 19 && hour < 23) return '晚上';
  return '深夜';
}

function getActiveDirective(userId: string, now: Date): string {
  const directive = getPref<ActiveDirectivePref>(userId, 'queue.activeDirective');
  const text = directive?.text?.trim() ?? '';
  if (!text) return '';

  const expiresAt = directive?.expiresAt ? new Date(directive.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return '';
  return truncate(text, 300);
}

function buildCurrentPlanSegment(userId: string, now: Date): string | null {
  const plan = loadLatestPlan(userId, formatDate(now));
  if (!plan) return null;

  const segmentId = getPlanSegmentId(now.getHours());
  const segment = plan.segments.find((item) => item.id === segmentId);
  if (!segment) return null;

  const tracks = segment.tracks
    .slice(0, 4)
    .map((track) => track.query)
    .filter(Boolean)
    .join('、');
  const parts = [
    `${segment.label} ${segment.timeRange}`,
    `mood=${segment.mood}`,
    `energy=${segment.energyPct}`,
    tracks ? `tracks=${tracks}` : ''
  ].filter(Boolean);
  return truncate(parts.join('；'), 500);
}

function getPlanSegmentId(hour: number): 'morning' | 'work' | 'evening' | 'late-night' {
  if (hour >= 5 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 17) return 'work';
  if (hour >= 17 && hour < 23) return 'evening';
  return 'late-night';
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildTasteSummary(userId: string): string {
  const corpus = loadUserCorpus(userId);
  const parts = [
    corpus.taste ? `taste: ${compactWhitespace(corpus.taste)}` : '',
    corpus.routines ? `routines: ${compactWhitespace(corpus.routines)}` : '',
    corpus.moodRules ? `moodRules: ${compactWhitespace(corpus.moodRules)}` : ''
  ].filter(Boolean);
  return truncate(parts.join('\n'), 900);
}

function buildRecentPlaySignals(userId: string): string {
  const plays = getRecentPlays(userId, 12);
  if (plays.length === 0) return '';
  return truncate(
    plays
      .map((play) => {
        const song = play.song_name || play.song_id || 'unknown';
        const artist = play.artist_name ? ` - ${play.artist_name}` : '';
        const reason = play.end_reason ? ` (${play.end_reason})` : '';
        return `${song}${artist}${reason}`;
      })
      .join('\n'),
    700
  );
}

function buildQueueStateSummary(userId: string): string {
  const queue = getQueue(userId).slice(0, 8);
  if (queue.length === 0) return '';
  return truncate(
    queue
      .map((track, index) => {
        const name = track.name || track.query || 'unknown';
        const artists = track.artists?.length ? ` - ${track.artists.join('/')}` : '';
        return `${index + 1}. ${name}${artists} [${track.ncmId}]`;
      })
      .join('\n'),
    700
  );
}

function buildBannedSummary(userId: string): string {
  const moodOverride = getPref<unknown>(userId, 'queue.moodOverride');
  const replanHint = getPref<unknown>(userId, 'plan.replanHint');
  const parts = [
    moodOverride ? `queue.moodOverride=${compactValue(moodOverride)}` : '',
    replanHint ? `plan.replanHint=${compactValue(replanHint)}` : ''
  ].filter(Boolean);
  return truncate(parts.join('\n'), 600);
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return compactWhitespace(value);
  try {
    return compactWhitespace(JSON.stringify(value));
  } catch {
    return '';
  }
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}
