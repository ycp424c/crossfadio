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

  it('reports bounded candidate-pool rejects for track entity recall admissions', async () => {
    const pool = new CandidatePool({ maxCandidates: 0 });
    const ncmClient = ncmClientStub({
      getSongDetails: vi.fn(async () => [{
        id: 'track-1',
        name: 'City Light',
        artists: ['Fresh Artist']
      }])
    });

    const result = await recallFromEntity({
      entity: { type: 'track', providerId: 'track-1', title: 'City Light', artist: 'Fresh Artist' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 3,
      searchLimit: 3,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      provenanceKind: 'verified_entity'
    });

    expect(result).toEqual({
      added: 0,
      problems: ['candidate admission: rejectedByPool=1 (pool_full=1)']
    });
    expect(pool.count()).toBe(0);
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
      provenanceKind: 'semantic_discovery'
    });

    expect(result).toEqual({ added: 0, problems: ['NCM search budget exhausted'] });
    expect(consumeNcmSearch).toHaveBeenCalledTimes(2);
    expect(getArtistTopSongs).not.toHaveBeenCalled();
    expect(pool.count()).toBe(0);
  });

  it('samples artist top songs while retaining the full explicit recall limit', async () => {
    const pool = new CandidatePool();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const ncmClient = ncmClientStub({
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Fresh Artist' }]),
      getArtistTopSongs: vi.fn(async () => [
        { id: 'top-1', name: 'Top One', artists: ['Fresh Artist'] },
        { id: 'top-2', name: 'Top Two', artists: ['Fresh Artist'] },
        { id: 'top-3', name: 'Top Three', artists: ['Fresh Artist'] },
        { id: 'top-4', name: 'Top Four', artists: ['Fresh Artist'] },
        { id: 'top-5', name: 'Top Five', artists: ['Fresh Artist'] }
      ])
    });

    try {
      const result = await recallFromEntity({
        entity: { type: 'artist', name: 'Fresh Artist' },
        ncmClient,
        candidatePool: pool,
        context: context(),
        limit: 5,
        searchLimit: 3,
        consumeNcmSearch: vi.fn(() => true),
        consumePlaylistFetch: vi.fn(() => true),
        provenanceKind: 'verified_entity'
      });

      expect(result.added).toBe(5);
      expect(pool.list().map((candidate) => candidate.id)).toEqual([
        'top-2', 'top-3', 'top-4', 'top-5', 'top-1'
      ]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('chooses the first playlist whose title satisfies required anchors', async () => {
    const pool = new CandidatePool();
    const getPlaylistDetail = vi.fn(async (id: string) => ({
      id,
      name: '粤语男声精选，唱尽难眠心事',
      tracks: [
        { id: 'p-1', name: 'Good Cantonese One', artists: ['Singer A'] },
        { id: 'p-2', name: 'Good Cantonese Two', artists: ['Singer B'] },
        { id: 'p-3', name: '翻唱｜温柔男声', artists: ['Singer C'] }
      ]
    }));
    const ncmClient = ncmClientStub({
      searchPlaylists: vi.fn(async () => [
        { id: 'wrong-language', name: '【日语】干净温暖的男声', trackCount: 119, coverImgUrl: null },
        { id: 'cover-only', name: '粤语：温柔男声翻唱', trackCount: 21, coverImgUrl: null },
        { id: 'good-playlist', name: '粤语男声精选，唱尽难眠心事', trackCount: 44, coverImgUrl: null }
      ]),
      getPlaylistDetail
    });

    const result = await recallFromEntity({
      entity: { type: 'playlist', name: '粤语 男声 温暖' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 4,
      searchLimit: 5,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      provenanceKind: 'verified_entity'
    });

    expect(result).toEqual({ added: 2, problems: [] });
    expect(getPlaylistDetail).toHaveBeenCalledWith('good-playlist');
    expect(pool.list().map((candidate) => candidate.name)).toEqual([
      'Good Cantonese One',
      'Good Cantonese Two'
    ]);
  });

  it('does not require a male title anchor for English female-vocal playlist queries', async () => {
    const pool = new CandidatePool();
    const getPlaylistDetail = vi.fn(async (id: string) => ({
      id,
      name: 'city pop 女声精选',
      tracks: [
        { id: 'female-1', name: 'City Pop One', artists: ['Singer A'] }
      ]
    }));
    const ncmClient = ncmClientStub({
      searchPlaylists: vi.fn(async () => [
        { id: 'female-playlist', name: 'city pop 女声精选', trackCount: 18, coverImgUrl: null }
      ]),
      getPlaylistDetail
    });

    const result = await recallFromEntity({
      entity: { type: 'playlist', name: 'city pop female vocal' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 4,
      searchLimit: 5,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      provenanceKind: 'verified_entity'
    });

    expect(result).toEqual({ added: 1, problems: [] });
    expect(getPlaylistDetail).toHaveBeenCalledWith('female-playlist');
    expect(pool.list().map((candidate) => candidate.name)).toEqual(['City Pop One']);
  });

  it('skips low-quality album matches and filters variant tracks from album expansion', async () => {
    const pool = new CandidatePool();
    const getAlbumDetail = vi.fn(async (id: string) => ({
      id,
      name: 'Origins (Deluxe)',
      artist: 'Imagine Dragons',
      tracks: [
        { id: 'a-1', name: 'Natural', artists: ['Imagine Dragons'] },
        { id: 'a-2', name: 'Natural (Instrumental Version)', artists: ['DJ Cover That'] },
        { id: 'a-3', name: 'Bones', artists: ['Imagine Dragons'] }
      ]
    }));
    const ncmClient = ncmClientStub({
      searchAlbums: vi.fn(async () => [
        { id: 'bad-album', name: 'Origins (Instrumental)', artist: 'DJ Cover That' },
        { id: 'good-album', name: 'Origins (Deluxe)', artist: 'Imagine Dragons' }
      ]),
      getAlbumDetail
    });

    const result = await recallFromEntity({
      entity: { type: 'album', title: 'Origins' },
      ncmClient,
      candidatePool: pool,
      context: context(),
      limit: 4,
      searchLimit: 5,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      provenanceKind: 'verified_entity'
    });

    expect(result).toEqual({ added: 2, problems: [] });
    expect(getAlbumDetail).toHaveBeenCalledWith('good-album');
    expect(pool.list().map((candidate) => candidate.name)).toEqual(['Natural', 'Bones']);
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
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}
