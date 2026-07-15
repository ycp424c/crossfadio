import type { NcmClient } from '../ncm/client.js';
import { fetchWeather } from '../weather.js';
import { getDailyTheme } from '../daily-theme.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { getRecentPlays } from '../store/plays.js';
import { getQueue } from '../store/queue.js';
import { getPref } from '../store/prefs.js';
import { getActiveTemporaryQueueBans } from '../store/temporary-bans.js';
import {
  getPersonalDjContextSnapshot,
  type PersonalDjContextRecord
} from '../store/personal-dj-context.js';
import { formatShanghaiLocalTime, getDaypart, getShanghaiTimeParts } from '../timezone.js';
import {
  MUSIC_AGENT_TRACK_PENALTY_SUMMARY_MAX_ITEMS,
  musicAgentRuntimeContextSchema,
  type MusicAgentContextSummary,
  type MusicAgentRuntimeContext
} from './schema.js';
import { buildMusicTrackDedupeKey } from './dedupe.js';
import { artistKeys, primaryArtistKey } from './artists.js';

const WEATHER_TIMEOUT_MS = 1500;
const QUEUE_ARTIST_PENALTIES = [0.36, 0.28, 0.2, 0.14, 0.1, 0.08];
const RECENT_PLAY_ARTIST_PENALTIES = [0.3, 0.24, 0.18, 0.12, 0.08, 0.06, 0.04, 0.04];
const ARTIST_REPEAT_HISTORY_LIMIT = 200;
const ARTIST_REPEAT_LOOKBACK_DAYS = 60;
const ARTIST_REPEAT_HALF_LIFE_DAYS = 21;
const ARTIST_REPEAT_GROWTH_RATE = 0.2;
const ARTIST_REPEAT_MAX_PENALTY = 0.24;
const ARTIST_REPEAT_MIN_PENALTY = 0.04;
const ARTIST_REPEAT_MAX_ITEMS = 40;
const TRACK_REPEAT_HISTORY_LIMIT = 200;
const TRACK_REPEAT_LOOKBACK_DAYS = 60;
const TRACK_REPEAT_HALF_LIFE_DAYS = 21;
const TRACK_REPEAT_GROWTH_RATE = 0.22;
const TRACK_REPEAT_MAX_PENALTY = 0.28;
const TRACK_REPEAT_MIN_PENALTY = 0.01;

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

export async function buildMusicAgentContext(input: BuildMusicAgentContextInput): Promise<MusicAgentRuntimeContext> {
  const now = input.now ?? new Date();
  const weather = await fetchWeatherWithTimeout(input.userId);
  const theme = input.includeDailyTheme === false ? null : getDailyTheme();
  const actionQueries = compactActionQueries(input.actionQueries ?? []);
  const rankingTrackPenalties = buildRecentTrackPenalties(input.userId, now);

  const context: MusicAgentRuntimeContext = {
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
    tasteSummary: buildTasteSummary(input.userId),
    recentPreferenceSummary: truncate(getPreferenceContext(input.userId, 3), 600),
    recentPlaySignals: buildRecentPlaySignals(input.userId),
    queueStateSummary: buildQueueStateSummary(input.userId),
    recentArtistPenalties: buildRecentArtistPenalties(input.userId, now),
    recentTrackPenalties: rankingTrackPenalties.slice(0, MUSIC_AGENT_TRACK_PENALTY_SUMMARY_MAX_ITEMS),
    rankingTrackPenalties,
    ...buildPersonalDjContextForMusicAgent(input.userId, now),
    bannedSummary: buildBannedSummary(input.userId, now)
  };

  return musicAgentRuntimeContextSchema.parse(context);
}

function buildPersonalDjContextForMusicAgent(
  userId: string,
  now: Date
): Pick<MusicAgentContextSummary, 'personalDjContext'> {
  const snapshot = getPersonalDjContextSnapshot(userId, now);
  if (!snapshot.current) return {};

  return {
    personalDjContext: {
      summary: truncate(snapshot.current.payload.summary, 1200),
      currentState: snapshot.current.payload.currentState,
      musicGuidance: snapshot.current.payload.musicGuidance,
      musicHints: snapshot.current.payload.musicHints,
      segueGuidance: snapshot.current.payload.segueGuidance,
      trend: snapshot.trend.map(toPersonalDjTrendContext)
    }
  };
}

function toPersonalDjTrendContext(record: PersonalDjContextRecord): NonNullable<MusicAgentContextSummary['personalDjContext']>['trend'][number] {
  return {
    uploadedAt: record.uploadedAt,
    summary: truncate(record.payload.summary, 500),
    musicGuidance: record.payload.musicGuidance,
    musicHints: record.payload.musicHints
  };
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

function buildRecentArtistPenalties(userId: string, now: Date): Array<{ artist: string; penalty: number }> {
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

  for (const item of buildLongLivedArtistPenalties(userId, now)) {
    addArtistPenalty(byArtist, item.artist, item.penalty);
  }

  return [...byArtist.entries()].map(([artist, penalty]) => ({ artist, penalty }));
}

function addArtistPenalty(byArtist: Map<string, number>, artist: string | null | undefined, penalty: number): void {
  for (const normalized of artistKeys(artist)) {
    byArtist.set(normalized, Math.max(byArtist.get(normalized) ?? 0, penalty));
  }
}

function buildLongLivedArtistPenalties(userId: string, now: Date): Array<{ artist: string; penalty: number }> {
  const byArtist = new Map<string, number>();

  for (const play of getRecentPlays(userId, ARTIST_REPEAT_HISTORY_LIMIT)) {
    const startedAt = parseSqliteDate(play.started_at);
    if (!startedAt) continue;
    const ageDays = Math.max(0, (now.getTime() - startedAt.getTime()) / 86_400_000);
    if (ageDays > ARTIST_REPEAT_LOOKBACK_DAYS) continue;

    const exposure = Math.pow(0.5, ageDays / ARTIST_REPEAT_HALF_LIFE_DAYS);
    for (const artist of artistKeys(play.artist_name)) {
      byArtist.set(artist, (byArtist.get(artist) ?? 0) + exposure);
    }
  }

  return [...byArtist.entries()]
    .map(([artist, exposure]) => ({
      artist,
      penalty: roundPenalty(ARTIST_REPEAT_MAX_PENALTY * (1 - Math.exp(-exposure * ARTIST_REPEAT_GROWTH_RATE)))
    }))
    .filter((item) => item.penalty >= ARTIST_REPEAT_MIN_PENALTY)
    .sort((left, right) => right.penalty - left.penalty || left.artist.localeCompare(right.artist))
    .slice(0, ARTIST_REPEAT_MAX_ITEMS);
}

function buildRecentTrackPenalties(userId: string, now: Date): Array<{ trackKey: string; title: string; artist: string; penalty: number }> {
  const byTrack = new Map<string, { title: string; artist: string; exposure: number }>();

  for (const play of getRecentPlays(userId, TRACK_REPEAT_HISTORY_LIMIT)) {
    const title = play.song_name?.trim() ?? '';
    if (!title) continue;
    const artist = primaryArtistKey(play.artist_name) || (play.artist_name?.trim() ?? '');
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
    .sort((left, right) => right.penalty - left.penalty || left.trackKey.localeCompare(right.trackKey));
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

function buildBannedSummary(userId: string, now: Date): string {
  const moodOverride = getPref<unknown>(userId, 'queue.moodOverride');
  const temporaryBans = getActiveTemporaryQueueBans(userId, now);
  const parts = [
    moodOverride ? `queue.moodOverride=${compactValue(moodOverride)}` : '',
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
