import type { NcmClient } from '../ncm/client.js';
import { artistKeys } from './artists.js';
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

export type LikedRecallProfile = {
  ids: Set<string>;
  artistKeys: Set<string>;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type LikedProfileRefresh = {
  promise: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | null;
};

const LIKED_RECALL_CACHE_TTL_MS = 10 * 60 * 1000;
const LIKED_DETAIL_BATCH_SIZE = 200;
const LIKED_PROFILE_ARTIST_DETAIL_LIMIT = LIKED_DETAIL_BATCH_SIZE;

const likedIdCache = new Map<string, CacheEntry<string[]>>();
const likedTrackCache = new Map<string, CacheEntry<NcmTrackLike>>();
const likedProfileCache = new Map<string, CacheEntry<LikedRecallProfile>>();
const likedProfileRefreshes = new Map<string, LikedProfileRefresh>();

export function _resetLikedRecallCacheForTest(): void {
  likedIdCache.clear();
  likedTrackCache.clear();
  likedProfileCache.clear();
  for (const refresh of likedProfileRefreshes.values()) {
    if (refresh.timeout) clearTimeout(refresh.timeout);
  }
  likedProfileRefreshes.clear();
}

export async function _flushLikedProfileRefreshesForTest(): Promise<void> {
  await Promise.all([...likedProfileRefreshes.values()].map((refresh) => refresh.promise));
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

  for (let start = 0; start < missingIds.length; start += LIKED_DETAIL_BATCH_SIZE) {
    const batchIds = missingIds.slice(start, start + LIKED_DETAIL_BATCH_SIZE);
    if (batchIds.length === 0) continue;
    const fetchedTracks = await input.ncmClient.getSongDetails(batchIds);
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

export async function getCachedLikedProfile(input: LikedRecallInput): Promise<LikedRecallProfile> {
  const cached = readCache(likedProfileCache, input.userId);
  if (cached) return cloneLikedRecallProfile(cached);

  const ids = await getCachedLikedIds(input);
  const artistDetailIds = ids.slice(0, LIKED_PROFILE_ARTIST_DETAIL_LIMIT);
  const tracks = artistDetailIds.length > 0 ? await getCachedLikedTracks(input, artistDetailIds) : [];
  const profile: LikedRecallProfile = {
    ids: new Set(ids),
    artistKeys: new Set(tracks.flatMap((track) => (track.artists ?? []).flatMap(artistKeys)))
  };
  writeCache(likedProfileCache, input.userId, profile, LIKED_RECALL_CACHE_TTL_MS);
  if (ids.length > artistDetailIds.length) {
    refreshFullLikedProfileInBackground(input, ids);
  }
  return cloneLikedRecallProfile(profile);
}

function likedTrackCacheKey(userId: string, trackId: string): string {
  return `${userId}:${trackId}`;
}

function cloneLikedRecallProfile(profile: LikedRecallProfile): LikedRecallProfile {
  return {
    ids: new Set(profile.ids),
    artistKeys: new Set(profile.artistKeys)
  };
}

function refreshFullLikedProfileInBackground(input: LikedRecallInput, ids: string[]): void {
  if (likedProfileRefreshes.has(input.userId)) return;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      const refresh = likedProfileRefreshes.get(input.userId);
      if (refresh) refresh.timeout = null;
      void refreshFullLikedProfile(input, ids)
        .catch(() => {})
        .finally(() => {
          likedProfileRefreshes.delete(input.userId);
          resolve();
        });
    }, 0);
  });
  likedProfileRefreshes.set(input.userId, { promise, timeout });
}

async function refreshFullLikedProfile(input: LikedRecallInput, ids: string[]): Promise<void> {
  const tracks = ids.length > 0 ? await getCachedLikedTracks(input, ids) : [];
  const profile: LikedRecallProfile = {
    ids: new Set(ids),
    artistKeys: new Set(tracks.flatMap((track) => (track.artists ?? []).flatMap(artistKeys)))
  };
  writeCache(likedProfileCache, input.userId, profile, LIKED_RECALL_CACHE_TTL_MS);
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
