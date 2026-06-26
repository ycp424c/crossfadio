export type RecallSearchCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type RecallSearchArtistFallbackTrack = {
  artists?: string[] | null;
};

export function readRecallSearchCache<T>(
  cache: Map<string, RecallSearchCacheEntry<T>>,
  key: string
): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function writeRecallSearchCache<T>(
  cache: Map<string, RecallSearchCacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number
): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

export function recallSearchCacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}::${limit}`;
}

export function artistFallbackNameFromQuery(query: string, tracks: RecallSearchArtistFallbackTrack[]): string {
  const withoutParenthetical = query.replace(/[（(][^）)]*[）)]/g, ' ').trim();
  const dashParts = withoutParenthetical.split(/\s+(?:—|-|–)\s+/).map((part) => part.trim()).filter(Boolean);
  const queryArtist = dashParts.length >= 2 ? dashParts.at(-1) ?? '' : '';
  if (queryArtist) return queryArtist;

  for (const track of tracks) {
    const artist = track.artists?.find((item) => item?.trim());
    if (artist) return artist.trim();
  }
  return '';
}
