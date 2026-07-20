import { createHash } from 'node:crypto';
import type { NcmClient } from './client.js';
import { getLogger } from '../logger.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';

type CacheEntry = {
  ncmId: string;
  name: string;
  artists: string[];
  resolvedAt: number;
};

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX = 500;

const cache = new Map<string, CacheEntry>();

export type ResolvedTrack = {
  ncmId: string;
  name: string;
  artists: string[];
};

export type TrackIdentityResolution =
  | { status: 'resolved'; track: ResolvedTrack }
  | { status: 'ambiguous' | 'not_found' | 'unavailable' };

export async function resolveTrackIdentity(
  input: { title: string; artist?: string | null },
  client: NcmClient,
  signal?: AbortSignal
): Promise<TrackIdentityResolution> {
  const title = input.title.trim();
  const artist = input.artist?.trim() ?? '';
  const query = [title, artist].filter(Boolean).join(' ');
  try {
    const songs = signal
      ? await client.searchSongs(query, 10, { signal })
      : await client.searchSongs(query, 10);
    const expectedTitle = normalizeIdentityText(title);
    const expectedArtist = normalizeIdentityText(artist);
    const matches = [...new Map(songs.flatMap((song) => {
      const id = String(song.id).trim();
      const name = song.name?.trim() ?? '';
      const artists = song.artists?.map((item) => item.trim()).filter(Boolean) ?? [];
      if (!id || !name || normalizeIdentityText(name) !== expectedTitle) return [];
      if (expectedArtist && !artists.some((item) => normalizeIdentityText(item) === expectedArtist)) {
        return [];
      }
      return [[id, { ncmId: id, name, artists }] as const];
    })).values()];
    if (matches.length === 1) return { status: 'resolved', track: matches[0]! };
    return { status: matches.length > 1 ? 'ambiguous' : 'not_found' };
  } catch (err) {
    getLogger().warn({
      error: safeOperationalError(err, 'track_identity_resolution_failed'),
      queryHash: hashQuery(query)
    }, 'Failed to resolve exact track identity');
    return { status: 'unavailable' };
  }
}

/**
 * Resolves a track query string ("歌名 — 艺人名") to NCM song ID + metadata.
 * Results are cached in-memory (LRU-like, 500 entries, 10 min TTL).
 * Returns null if no match found or NCM is unavailable.
 */
export async function resolveTrackQuery(
  query: string,
  client: NcmClient
): Promise<ResolvedTrack | null> {
  const key = query.trim().toLowerCase();

  // Cache hit
  const cached = cache.get(key);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return { ncmId: cached.ncmId, name: cached.name, artists: cached.artists };
  }

  try {
    const songs = await client.searchSongs(query, 1);
    const song = songs[0];
    if (!song) return null;

    const entry: CacheEntry = {
      ncmId: String(song.id),
      name: song.name,
      artists: song.artists,
      resolvedAt: Date.now()
    };

    // Evict oldest entries when at capacity
    if (cache.size >= CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }

    cache.set(key, entry);
    return { ncmId: entry.ncmId, name: entry.name, artists: entry.artists };
  } catch (err) {
    getLogger().warn({
      error: safeOperationalError(err, 'track_query_resolution_failed'),
      queryHash: hashQuery(query)
    }, 'Failed to resolve track query');
    return null;
  }
}

/** Visible for testing */
export function clearResolverCache(): void {
  cache.clear();
}

function normalizeIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}
