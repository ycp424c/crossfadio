import { describe, expect, it, vi } from 'vitest';
import { loadLegacyLikedSample } from '../../src/server/dj/legacyLikedSample';

describe('Legacy DJ liked sample loader', () => {
  it('samples available liked ids, fetches details, and filters invalid or deduped tracks', async () => {
    const sampleIds = vi.fn((ids: string[], target: number) => ids.slice(0, target));
    const fetchSongDetails = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['1', '3', '4']);
      return [
        { id: 1, name: 'Keep Me', artists: ['Artist A'] },
        { id: 3, name: 'No Artist', artists: [] },
        { id: 4, name: 'Duplicate Song', artists: ['Artist B'] }
      ];
    });

    const result = await loadLegacyLikedSample({
      allLikedIds: ['1', '2', '3', '4'],
      excludeIds: new Set(['2']),
      excludeDedupeKeys: new Set(['artist b::duplicate song']),
      likedSampleSize: 3,
      sampleIds,
      fetchSongDetails,
      buildTrackDedupeKey: (track) => `${track.artist?.toLowerCase()}::${track.name?.toLowerCase()}`,
      isTrackDedupeKeyExcluded: (key, excluded) => key !== '' && excluded.has(key)
    });

    expect(sampleIds).toHaveBeenCalledWith(['1', '3', '4'], 3);
    expect(fetchSongDetails).toHaveBeenCalledWith(['1', '3', '4']);
    expect(result).toEqual({
      likedSample: [{ id: '1', name: 'Keep Me', artist: 'Artist A' }],
      candidateCount: 3,
      likedSampleTarget: 3
    });
  });
});
