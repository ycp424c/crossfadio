import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artistFallbackNameFromQuery,
  readRecallSearchCache,
  recallSearchCacheKey,
  writeRecallSearchCache
} from '../../src/server/music-agent/recall-search';

describe('MusicAgent recall search helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes recall search cache keys', () => {
    expect(recallSearchCacheKey('  City Pop Mix  ', 8)).toBe('city pop mix::8');
  });

  it('reads fresh recall cache entries and evicts expired entries', () => {
    const cache = new Map<string, { value: string[]; expiresAt: number }>();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    writeRecallSearchCache(cache, 'query::2', ['track-a'], 500);

    expect(readRecallSearchCache(cache, 'query::2')).toEqual(['track-a']);

    now.mockReturnValue(1_500);
    expect(readRecallSearchCache(cache, 'query::2')).toBeNull();
    expect(cache.has('query::2')).toBe(false);
  });

  it('prefers explicit artist names parsed from dash-separated queries', () => {
    expect(artistFallbackNameFromQuery('Song Title（Live） — Query Artist', [
      { id: '1', name: 'Song Title', artists: ['Track Artist'] }
    ])).toBe('Query Artist');
    expect(artistFallbackNameFromQuery('Song Title - Query Artist', [])).toBe('Query Artist');
    expect(artistFallbackNameFromQuery('Song Title – Query Artist', [])).toBe('Query Artist');
  });

  it('falls back to the first non-empty track artist when the query has no artist', () => {
    expect(artistFallbackNameFromQuery('Song Title', [
      { id: '1', name: 'Song Title', artists: ['', ' Track Artist '] }
    ])).toBe('Track Artist');
    expect(artistFallbackNameFromQuery('Song Title', [])).toBe('');
  });
});
