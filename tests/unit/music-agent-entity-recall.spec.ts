import { describe, expect, it, vi } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import {
  recallFromEntity,
  type EntityRecallNcmClient
} from '../../src/server/music-agent/entity-recall';
import type { MusicAgentContextSummary } from '../../src/server/music-agent/schema';

describe('MusicAgent entity recall', () => {
  it('recalls explicit track entities without consuming search budget and keeps verified provenance', async () => {
    const pool = new CandidatePool();
    const ncmClient = ncmClientStub({
      getSongDetails: vi.fn(async () => [{
        id: 'track-1',
        name: 'City Light',
        artists: ['Fresh Artist']
      }])
    });
    const consumeNcmSearch = vi.fn(() => true);
    const consumePlaylistFetch = vi.fn(() => true);

    const result = await recallFromEntity({
      entity: { type: 'track', providerId: 'track-1', title: 'City Light', artist: 'Fresh Artist' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 3,
      searchLimit: 3,
      consumeNcmSearch,
      consumePlaylistFetch,
      avoidArtists: new Set(),
      artistCounts: new Map(),
      provenanceKind: 'verified_entity'
    });

    expect(result).toEqual({ added: 1, problems: [] });
    expect(consumeNcmSearch).not.toHaveBeenCalled();
    expect(consumePlaylistFetch).not.toHaveBeenCalled();
    expect(pool.list()).toEqual([
      expect.objectContaining({
        id: 'track-1',
        name: 'City Light',
        artist: 'Fresh Artist',
        sources: ['search'],
        provenance: [{ kind: 'verified_entity', source: 'search' }]
      })
    ]);
  });

  it('uses the provided search-budget callback for artist entity expansion', async () => {
    const pool = new CandidatePool();
    const getArtistTopSongs = vi.fn(async () => [{
      id: 'top-1',
      name: 'Top Song',
      artists: ['Fresh Artist']
    }]);
    const ncmClient = ncmClientStub({
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Fresh Artist' }]),
      getArtistTopSongs
    });
    const consumeNcmSearch = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await recallFromEntity({
      entity: { type: 'artist', name: 'Fresh Artist' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 3,
      searchLimit: 3,
      consumeNcmSearch,
      consumePlaylistFetch: vi.fn(() => true),
      avoidArtists: new Set(),
      artistCounts: new Map(),
      provenanceKind: 'semantic_discovery'
    });

    expect(result).toEqual({ added: 0, problems: ['NCM search budget exhausted'] });
    expect(consumeNcmSearch).toHaveBeenCalledTimes(2);
    expect(getArtistTopSongs).not.toHaveBeenCalled();
    expect(pool.count()).toBe(0);
  });
});

function ncmClientStub(overrides: Partial<EntityRecallNcmClient> = {}): EntityRecallNcmClient {
  return {
    getLikedSongIds: vi.fn(async () => []),
    getSongDetails: vi.fn(async () => []),
    searchSongs: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    ...overrides
  };
}

function context(): MusicAgentContextSummary {
  return {
    request: 'chat-recommend',
    discoveryMode: 'explore',
    currentUserText: '',
    currentMoment: { localTime: '周五 15:00', daypart: '下午', weather: null },
    activeDirective: '',
    currentPlanSegment: null,
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}
