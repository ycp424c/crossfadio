import { describe, expect, it } from 'vitest';
import { buildDjPickDebugLog } from '../../src/renderer/views/Player/PlayerView';

describe('DJ pick debug log', () => {
  it('counts real query funnel search results instead of selected picks', () => {
    const log = buildDjPickDebugLog({
      likedSample: [],
      searchQueries: ['The Archer — Taylor Swift'],
      searchedTracks: [
        { id: '28111293', name: 'Ours', artist: 'Taylor Swift' },
        { id: '208927', name: '思念', artist: '蔡健雅' },
        { id: '1382781549', name: 'ME!', artist: 'Taylor Swift' },
        { id: '208900', name: '谁', artist: '蔡健雅' }
      ],
      selectedTracks: [
        { id: '28111293', name: 'Ours', artist: 'Taylor Swift', reason: '红心兜底', source: 'liked' }
      ],
      totalCandidates: 4,
      selectedSay: '我从红心兜底池里选。',
      queryFunnel: [{
        query: 'The Archer — Taylor Swift',
        normalizedQuery: 'the archer — taylor swift',
        source: 'search',
        searchedCount: 1,
        resultCount: 8,
        addedCount: 0,
        selectedCount: 0,
        scoreMultiplier: 0.65,
        repeatPenalty: 0.32,
        selectionRate: 0
      }]
    });

    expect(log.searchResultCount).toBe(8);
    expect(log.searchAddedCount).toBe(0);
    expect(log.searchedTracks).toHaveLength(4);
  });
});
