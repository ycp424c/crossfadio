export type PickReasonCache = {
  get(userId: string, trackId: string): string | null;
  set(userId: string, trackId: string, reason: string): void;
  size(): number;
};

export function createPickReasonCache(options: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}): PickReasonCache {
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries));
  const entries = new Map<string, { reason: string; expiresAt: number }>();

  const pruneExpired = (): void => {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  };

  return {
    get(userId, trackId) {
      pruneExpired();
      const key = cacheKey(userId, trackId);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.reason;
    },
    set(userId, trackId, reason) {
      pruneExpired();
      const key = cacheKey(userId, trackId);
      entries.delete(key);
      entries.set(key, {
        reason,
        expiresAt: now() + Math.max(1, options.ttlMs)
      });
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    size() {
      pruneExpired();
      return entries.size;
    }
  };
}

function cacheKey(userId: string, trackId: string): string {
  return `${userId}\0${trackId}`;
}
