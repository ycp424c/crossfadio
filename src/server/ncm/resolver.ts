import type { NcmClient } from './client.js';
import { getLogger } from '../logger.js';

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
    getLogger().warn({ err, query }, 'Failed to resolve track query');
    return null;
  }
}

/** Visible for testing */
export function clearResolverCache(): void {
  cache.clear();
}
