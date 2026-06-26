import { describe, expect, it } from 'vitest';
import { createLegacyCandidatePool } from '../../src/server/dj/legacyCandidatePool';

describe('Legacy DJ candidate pool', () => {
  it('keeps liked tracks first in comfort mode and omits duplicate search results', () => {
    const { allCandidates, phase3Debug } = createLegacyCandidatePool({
      likedSample: [
        { id: 'liked-1', name: 'Liked One', artist: 'Liked Artist' },
        { id: 'shared', name: 'Liked Shared', artist: 'Shared Artist' }
      ],
      searchedTracks: [
        { id: 'shared', name: 'Search Shared', artist: 'Search Artist' },
        { id: 'search-1', name: 'Search One', artist: 'Search Artist' }
      ],
      preferSearchCandidates: false,
      sqRawSay: '{"styles":[]}',
      searchQueries: ['city pop'],
      excludeState: {
        ids: new Set(['played-1']),
        dedupeKeys: new Set(['artist::song'])
      }
    });

    expect(allCandidates.map((track) => track.id)).toEqual(['liked-1', 'shared', 'search-1']);
    expect(phase3Debug).toMatchObject({
      likedSample: [
        { id: 'liked-1', name: 'Liked One', artist: 'Liked Artist' },
        { id: 'shared', name: 'Liked Shared', artist: 'Shared Artist' }
      ],
      sqRaw: '{"styles":[]}',
      searchQueries: ['city pop'],
      searchedTracks: [
        { id: 'shared', name: 'Search Shared', artist: 'Search Artist' },
        { id: 'search-1', name: 'Search One', artist: 'Search Artist' }
      ],
      excludedIds: ['played-1'],
      excludedDedupeKeys: ['artist::song'],
      totalCandidates: 3
    });
    expect(phase3Debug.candidateScoreTable).toEqual([
      expect.objectContaining({ rank: 1, id: 'liked-1', song: 'Liked One', artist: 'Liked Artist', sources: 'liked', adjustedScore: 1 }),
      expect.objectContaining({ rank: 2, id: 'shared', song: 'Liked Shared', artist: 'Shared Artist', sources: 'liked', adjustedScore: 0.5 }),
      expect.objectContaining({ rank: 3, id: 'search-1', song: 'Search One', artist: 'Search Artist', sources: 'search', adjustedScore: 0 })
    ]);
  });

  it('keeps search tracks first in explore mode while retaining liked backfill', () => {
    const { allCandidates, phase3Debug } = createLegacyCandidatePool({
      likedSample: [
        { id: 'liked-1', name: 'Liked One', artist: 'Liked Artist' },
        { id: 'shared', name: 'Liked Shared', artist: 'Shared Artist' }
      ],
      searchedTracks: [
        { id: 'search-1', name: 'Search One', artist: 'Search Artist' },
        { id: 'shared', name: 'Search Shared', artist: 'Search Artist' }
      ],
      preferSearchCandidates: true,
      sqRawSay: '',
      searchQueries: [],
      excludeState: {
        ids: new Set(),
        dedupeKeys: new Set()
      }
    });

    expect(allCandidates.map((track) => track.id)).toEqual(['search-1', 'liked-1', 'shared']);
    expect(phase3Debug.totalCandidates).toBe(3);
    expect(phase3Debug.candidateScoreTable.map((row) => ({ id: row.id, sources: row.sources }))).toEqual([
      { id: 'search-1', sources: 'search' },
      { id: 'liked-1', sources: 'liked' },
      { id: 'shared', sources: 'liked' }
    ]);
  });

  it('assigns a full score to a single candidate', () => {
    const { phase3Debug } = createLegacyCandidatePool({
      likedSample: [{ id: 'only', name: 'Only Track', artist: undefined }],
      searchedTracks: [],
      preferSearchCandidates: false,
      sqRawSay: '',
      searchQueries: [],
      excludeState: {
        ids: new Set(),
        dedupeKeys: new Set()
      }
    });

    expect(phase3Debug.candidateScoreTable).toEqual([
      expect.objectContaining({
        rank: 1,
        id: 'only',
        song: 'Only Track',
        artist: '未知艺人',
        sources: 'liked',
        baseScore: 1,
        adjustedScore: 1
      })
    ]);
  });
});
