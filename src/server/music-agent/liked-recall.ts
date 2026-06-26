import type { NcmClient } from '../ncm/client.js';
import type { MusicCandidateQualitySignals } from './schema.js';

export type NcmTrackLike = {
  id?: number | string | null;
  name?: string | null;
  artists?: string[] | null;
  qualitySignals?: MusicCandidateQualitySignals | null;
};

export type LikedRecallNcmClient = Pick<NcmClient, 'getLikedSongIds' | 'getSongDetails'>;

export type LikedRecallInput = {
  userId: string;
  ncmClient: LikedRecallNcmClient;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const LIKED_RECALL_CACHE_TTL_MS = 10 * 60 * 1000;

const likedIdCache = new Map<string, CacheEntry<string[]>>();
const likedTrackCache = new Map<string, CacheEntry<NcmTrackLike>>();

export function _resetLikedRecallCacheForTest(): void {
  likedIdCache.clear();
  likedTrackCache.clear();
}

export async function getLikedRecallTracks(
  input: LikedRecallInput,
  limit: number,
  signal?: AbortSignal
): Promise<NcmTrackLike[] | 'aborted'> {
  const allIds = await getCachedLikedIds(input);
  if (signal?.aborted) return 'aborted';
  const ids = sampleLikedRecallIds(allIds, limit);
  if (ids.length === 0) {
    return [];
  }
  return getCachedLikedTracks(input, ids);
}

export async function getCachedLikedIds(input: LikedRecallInput): Promise<string[]> {
  const cached = readCache(likedIdCache, input.userId);
  if (cached) return cached;

  const ids = (await input.ncmClient.getLikedSongIds()).map(String);
  writeCache(likedIdCache, input.userId, ids, LIKED_RECALL_CACHE_TTL_MS);
  return ids;
}

export async function getCachedLikedTracks(
  input: LikedRecallInput,
  ids: string[]
): Promise<NcmTrackLike[]> {
  const cachedTracks = new Map<string, NcmTrackLike>();
  const missingIds: string[] = [];

  for (const id of ids) {
    const cached = readCache(likedTrackCache, likedTrackCacheKey(input.userId, id));
    if (cached) cachedTracks.set(id, cached);
    else missingIds.push(id);
  }

  if (missingIds.length > 0) {
    const fetchedTracks = await input.ncmClient.getSongDetails(missingIds);
    for (const track of fetchedTracks) {
      const id = String(track.id);
      cachedTracks.set(id, track);
      writeCache(likedTrackCache, likedTrackCacheKey(input.userId, id), track, LIKED_RECALL_CACHE_TTL_MS);
    }
  }

  return ids
    .map((id) => cachedTracks.get(id))
    .filter((track): track is NcmTrackLike => Boolean(track));
}

function likedTrackCacheKey(userId: string, trackId: string): string {
  return `${userId}:${trackId}`;
}

export function sampleLikedRecallIds<T>(items: T[], count: number): T[] {
  if (count >= items.length) return [...items];

  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
