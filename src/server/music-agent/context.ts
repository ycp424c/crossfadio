import type { NcmClient } from '../ncm/client.js';
import { fetchWeather } from '../weather.js';
import { getDailyTheme } from '../daily-theme.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { getRecentPlays } from '../store/plays.js';
import { getQueue } from '../store/queue.js';
import { getPref } from '../store/prefs.js';
import { getActiveTemporaryQueueBans } from '../store/temporary-bans.js';
import { loadLatestPlan } from '../store/plan.js';
import { formatShanghaiDate, formatShanghaiLocalTime, getDaypart, getShanghaiTimeParts } from '../timezone.js';
import {
  musicAgentContextSummarySchema,
  type MusicAgentContextSummary
} from './schema.js';
import { buildMusicTrackDedupeKey } from './dedupe.js';

const WEATHER_TIMEOUT_MS = 1500;
const QUEUE_ARTIST_PENALTIES = [0.36, 0.28, 0.2, 0.14, 0.1, 0.08];
const RECENT_PLAY_ARTIST_PENALTIES = [0.3, 0.24, 0.18, 0.12, 0.08, 0.06, 0.04, 0.04];
const TRACK_REPEAT_HISTORY_LIMIT = 200;
const TRACK_REPEAT_LOOKBACK_DAYS = 60;
const TRACK_REPEAT_HALF_LIFE_DAYS = 21;
const TRACK_REPEAT_GROWTH_RATE = 0.22;
const TRACK_REPEAT_MAX_PENALTY = 0.28;
const TRACK_REPEAT_MIN_PENALTY = 0.01;
const TRACK_REPEAT_MAX_ITEMS = 40;

export type BuildMusicAgentContextInput = {
  userId: string;
  ncmClient?: NcmClient;
  request: 'auto-fill' | 'chat-recommend';
  userText?: string;
  actionQueries?: string[];
  includeDailyTheme?: boolean;
  now?: Date;
};

type ActiveDirectivePref = {
  text?: string;
  expiresAt?: string;
};

export async function buildMusicAgentContext(input: BuildMusicAgentContextInput): Promise<MusicAgentContextSummary> {
  const now = input.now ?? new Date();
  const weather = await fetchWeatherWithTimeout(input.userId);
  const theme = input.includeDailyTheme === false ? null : getDailyTheme();
  const actionQueries = compactActionQueries(input.actionQueries ?? []);

  const context: MusicAgentContextSummary = {
    request: input.request,
    discoveryMode: getDiscoveryMode(input.userId),
    currentUserText: input.request === 'chat-recommend' ? truncate(input.userText ?? '', 600) : '',
    ...(actionQueries.length > 0 ? { actionQueries } : {}),
    currentMoment: {
      localTime: formatShanghaiLocalTime(now),
      daypart: getDaypart(getShanghaiTimeParts(now).hour),
      weather: weather ? `${weather.tempC}°C，${weather.desc}` : null,
      ...(theme ? { dailyTheme: `${theme.theme}（${theme.keywords.join('、')}）` } : {})
    },
    activeDirective: getActiveDirective(input.userId, now),
    currentPlanSegment: buildCurrentPlanSegment(input.userId, now),
    tasteSummary: buildTasteSummary(input.userId),
    recentPreferenceSummary: truncate(getPreferenceContext(input.userId, 3), 600),
    recentPlaySignals: buildRecentPlaySignals(input.userId),
    queueStateSummary: buildQueueStateSummary(input.userId),
    recentArtistPenalties: buildRecentArtistPenalties(input.userId),
    recentTrackPenalties: buildRecentTrackPenalties(input.userId, now),
    bannedSummary: buildBannedSummary(input.userId, now)
  };

  return musicAgentContextSummarySchema.parse(context);
}

function getDiscoveryMode(userId: string): 'explore' | 'comfort' {
  return getPref<'explore' | 'comfort'>(userId, 'discovery.mode') === 'comfort' ? 'comfort' : 'explore';
}

function compactActionQueries(queries: string[]): string[] {
  return Array.from(
    new Set(
      queries
        .map((query) => compactWhitespace(query).slice(0, 160))
        .filter((query) => query.length > 0)
    )
  ).slice(0, 6);
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

function getActiveDirective(userId: string, now: Date): string {
  const directive = getPref<ActiveDirectivePref>(userId, 'queue.activeDirective');
  const text = directive?.text?.trim() ?? '';
  if (!text) return '';

  const expiresAt = directive?.expiresAt ? new Date(directive.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return '';
  return truncate(text, 300);
}

function buildCurrentPlanSegment(userId: string, now: Date): string | null {
  const timeParts = getShanghaiTimeParts(now);
  const plan = loadLatestPlan(userId, formatShanghaiDate(now));
  if (!plan) return null;

  const segment = plan.segments.find((item) => isCurrentTimeInSegmentRange(item.timeRange, timeParts))
    ?? plan.segments.find((item) => item.id === getPlanSegmentId(timeParts.hour));
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

function isCurrentTimeInSegmentRange(
  timeRange: string,
  timeParts: Pick<ReturnType<typeof getShanghaiTimeParts>, 'hour' | 'minute'>
): boolean {
  const range = parseSegmentTimeRange(timeRange);
  if (!range) return false;
  const currentMinutes = timeParts.hour * 60 + timeParts.minute;
  if (range.start === range.end) return false;
  if (range.start < range.end) {
    return currentMinutes >= range.start && currentMinutes < range.end;
  }
  return currentMinutes >= range.start || currentMinutes < range.end;
}

function parseSegmentTimeRange(timeRange: string): { start: number; end: number } | null {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(?:[-–—~至到]+)\s*(\d{1,2})(?::(\d{2}))?/.exec(timeRange);
  if (!match) return null;
  const [, startHourRaw, startMinuteRaw, endHourRaw, endMinuteRaw] = match;
  const start = parseTimeOfDay(startHourRaw, startMinuteRaw);
  const end = parseTimeOfDay(endHourRaw, endMinuteRaw);
  if (start === null || end === null) return null;
  return { start, end };
}

function parseTimeOfDay(hourRaw: string, minuteRaw: string | undefined): number | null {
  const hour = Number.parseInt(hourRaw, 10);
  const minute = minuteRaw === undefined ? 0 : Number.parseInt(minuteRaw, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return (hour % 24) * 60 + minute;
}

function getPlanSegmentId(hour: number): 'morning' | 'work' | 'evening' | 'late-night' {
  if (hour >= 5 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 17) return 'work';
  if (hour >= 17 && hour < 23) return 'evening';
  return 'late-night';
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

function buildRecentArtistPenalties(userId: string): Array<{ artist: string; penalty: number }> {
  const byArtist = new Map<string, number>();

  getQueue(userId).slice(0, QUEUE_ARTIST_PENALTIES.length).forEach((track, index) => {
    const penalty = QUEUE_ARTIST_PENALTIES[index];
    for (const artist of track.artists ?? []) {
      addArtistPenalty(byArtist, artist, penalty);
    }
  });

  getRecentPlays(userId, RECENT_PLAY_ARTIST_PENALTIES.length).forEach((play, index) => {
    const penalty = RECENT_PLAY_ARTIST_PENALTIES[index];
    addArtistPenalty(byArtist, play.artist_name, penalty);
  });

  return [...byArtist.entries()].map(([artist, penalty]) => ({ artist, penalty }));
}

function addArtistPenalty(byArtist: Map<string, number>, artist: string | null | undefined, penalty: number): void {
  const normalized = primaryArtist(artist);
  if (!normalized) return;
  byArtist.set(normalized, Math.max(byArtist.get(normalized) ?? 0, penalty));
}

function buildRecentTrackPenalties(userId: string, now: Date): Array<{ trackKey: string; title: string; artist: string; penalty: number }> {
  const byTrack = new Map<string, { title: string; artist: string; exposure: number }>();

  for (const play of getRecentPlays(userId, TRACK_REPEAT_HISTORY_LIMIT)) {
    const title = play.song_name?.trim() ?? '';
    if (!title) continue;
    const artist = primaryArtist(play.artist_name) || (play.artist_name?.trim() ?? '');
    const trackKey = buildMusicTrackDedupeKey({ name: title, artist });
    if (!trackKey) continue;

    const startedAt = parseSqliteDate(play.started_at);
    if (!startedAt) continue;
    const ageDays = Math.max(0, (now.getTime() - startedAt.getTime()) / 86_400_000);
    if (ageDays > TRACK_REPEAT_LOOKBACK_DAYS) continue;

    const exposure = Math.pow(0.5, ageDays / TRACK_REPEAT_HALF_LIFE_DAYS);
    const existing = byTrack.get(trackKey);
    if (existing) {
      existing.exposure += exposure;
    } else {
      byTrack.set(trackKey, {
        title,
        artist: play.artist_name?.trim() ?? '',
        exposure
      });
    }
  }

  return [...byTrack.entries()]
    .map(([trackKey, item]) => ({
      trackKey,
      title: item.title,
      artist: item.artist,
      penalty: roundPenalty(TRACK_REPEAT_MAX_PENALTY * (1 - Math.exp(-item.exposure * TRACK_REPEAT_GROWTH_RATE)))
    }))
    .filter((item) => item.penalty >= TRACK_REPEAT_MIN_PENALTY)
    .sort((left, right) => right.penalty - left.penalty || left.trackKey.localeCompare(right.trackKey))
    .slice(0, TRACK_REPEAT_MAX_ITEMS);
}

function parseSqliteDate(value: string): Date | null {
  const trimmed = value.trim();
  const sqliteMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (sqliteMatch) {
    const [, year, month, day, hour, minute, second] = sqliteMatch;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ));
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roundPenalty(value: number): number {
  return Number(value.toFixed(4));
}

function primaryArtist(artist: string | null | undefined): string {
  const value = artist ?? '';
  return value.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim().toLowerCase() ?? value.trim().toLowerCase();
}

function buildBannedSummary(userId: string, now: Date): string {
  const moodOverride = getPref<unknown>(userId, 'queue.moodOverride');
  const replanHint = getPref<unknown>(userId, 'plan.replanHint');
  const temporaryBans = getActiveTemporaryQueueBans(userId, now);
  const parts = [
    moodOverride ? `queue.moodOverride=${compactValue(moodOverride)}` : '',
    replanHint ? `plan.replanHint=${compactValue(replanHint)}` : '',
    temporaryBans.length > 0 ? `temporaryQueueBans=${formatTemporaryBans(temporaryBans)}` : ''
  ].filter(Boolean);
  return truncate(parts.join('\n'), 600);
}

function formatTemporaryBans(bans: ReturnType<typeof getActiveTemporaryQueueBans>): string {
  return bans
    .slice(0, 8)
    .map((ban) => {
      const name = ban.name || ban.id;
      const artists = ban.artists?.length ? ` - ${ban.artists.join('/')}` : '';
      return `${name}${artists} [${ban.id}]`;
    })
    .join('；');
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
