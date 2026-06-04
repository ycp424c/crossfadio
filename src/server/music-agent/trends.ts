import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAppDataDir } from '../app-paths.js';
import {
  trendContextSchema,
  type TrendContext,
  type TrendSource,
  type TrendTrackHint
} from './schema.js';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface TrendCapableNcmClient {
  getSearchHotDetail(): Promise<Array<{ searchWord: string; content?: string }>>;
  getTopSongHints(type?: string): Promise<
    Array<{ title: string; artist: string; source: 'ncm_top_song'; reason: string }>
  >;
  getArtistToplist(): Promise<string[]>;
}

export type BuildTrendContextOptions = {
  ncmClient: TrendCapableNcmClient;
  locale: 'zh-CN' | 'global';
  maxFetchMs: number;
  ttlMs?: number;
};

export async function buildTrendContext(options: BuildTrendContextOptions): Promise<TrendContext> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cached = await readTrendCache(options.locale);
  if (cached && isFresh(cached, ttlMs)) {
    return cached;
  }

  const empty = createEmptyTrendContext(options.locale);
  const fetched = await withTimeout(
    fetchTrendContext(options.ncmClient, options.locale),
    options.maxFetchMs,
    empty
  );

  if (fetched.sources.length > 0) {
    await writeTrendCache(fetched);
    return fetched;
  }

  return empty;
}

export async function readTrendCache(locale: TrendContext['locale']): Promise<TrendContext | null> {
  try {
    const raw = await fs.readFile(resolveTrendCachePath(locale), 'utf8');
    const parsed = trendContextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeTrendCache(context: TrendContext): Promise<void> {
  const parsed = trendContextSchema.parse(context);
  const cachePath = resolveTrendCachePath(parsed.locale);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(parsed, null, 2), 'utf8');
}

async function fetchTrendContext(
  ncmClient: TrendCapableNcmClient,
  locale: TrendContext['locale']
): Promise<TrendContext> {
  const [searchHot, topSongHints, artistToplist] = await Promise.all([
    ncmClient.getSearchHotDetail().catch(() => []),
    ncmClient.getTopSongHints().catch(() => []),
    ncmClient.getArtistToplist().catch(() => [])
  ]);

  const hotStyles = uniqueStrings(searchHot.map((item) => item.searchWord)).slice(0, 12);
  const chartTrackHints = normalizeTrackHints(topSongHints).slice(0, 20);
  const hotArtists = uniqueStrings(artistToplist).slice(0, 20);
  const sources = collectSources({ hotStyles, chartTrackHints, hotArtists });

  return trendContextSchema.parse({
    fetchedAt: new Date().toISOString(),
    locale,
    sources,
    hotArtists,
    hotStyles,
    chartTrackHints,
    confidence: sources.length === 0 ? 0 : Math.min(1, sources.length / 3)
  });
}

function collectSources(input: {
  hotStyles: string[];
  chartTrackHints: TrendTrackHint[];
  hotArtists: string[];
}): TrendSource[] {
  const sources: TrendSource[] = [];
  if (input.hotStyles.length > 0) {
    sources.push('ncm_search_hot');
  }
  if (input.chartTrackHints.length > 0) {
    sources.push('ncm_top_song');
  }
  if (input.hotArtists.length > 0) {
    sources.push('ncm_artist_toplist');
  }
  return sources;
}

function normalizeTrackHints(
  hints: Array<{ title: string; artist: string; source: 'ncm_top_song'; reason: string }>
): TrendTrackHint[] {
  return hints
    .map((hint) => ({
      title: hint.title.trim(),
      artist: hint.artist.trim(),
      source: hint.source,
      reason: hint.reason
    }))
    .filter((hint) => hint.title.length > 0 && hint.artist.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  );
}

function isFresh(context: TrendContext, ttlMs: number): boolean {
  if (ttlMs <= 0) {
    return false;
  }
  const fetchedAt = Date.parse(context.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs;
}

function createEmptyTrendContext(locale: TrendContext['locale']): TrendContext {
  return trendContextSchema.parse({
    fetchedAt: new Date().toISOString(),
    locale,
    sources: [],
    hotArtists: [],
    hotStyles: [],
    chartTrackHints: [],
    confidence: 0
  });
}

function resolveTrendCachePath(locale: TrendContext['locale']): string {
  return path.join(resolveAppDataDir(), 'cache', 'trends', `${locale}.json`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (timeoutMs <= 0) {
    return fallback;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
