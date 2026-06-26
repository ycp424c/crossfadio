import { describe, expect, it, vi } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import type { EntityRecallNcmClient } from '../../src/server/music-agent/entity-recall';
import { recallFromWebDiscoveryHints } from '../../src/server/music-agent/web-hint-recall';
import type { MusicAgentContextSummary, MusicEntityHint } from '../../src/server/music-agent/schema';

describe('MusicAgent web hint recall', () => {
  it('recalls sourced artist hints through entity recall with web-hint provenance', async () => {
    const pool = new CandidatePool();
    const consumeNcmSearch = vi.fn(() => true);
    const ncmClient = ncmClientStub({
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Fresh Artist' }]),
      getArtistTopSongs: vi.fn(async () => [{
        id: 'web-track-1',
        name: 'Fresh Song',
        artists: ['Fresh Artist']
      }])
    });

    const result = await recallFromWebDiscoveryHints({
      hints: [sourcedHint({ kind: 'artist', name: 'Fresh Artist' })],
      ncmClient,
      candidatePool: pool,
      context: context({ currentUserText: '探索 city pop' }),
      queryPlan: null,
      avoidArtists: new Set(),
      consumeNcmSearch,
      consumePlaylistFetch: vi.fn(() => true),
      limit: 2
    });

    expect(result).toEqual({ summary: 'web hint entity recall added 1 candidates from 1 entities.', problems: [] });
    expect(consumeNcmSearch).toHaveBeenCalledTimes(2);
    expect(pool.list()).toEqual([
      expect.objectContaining({
        id: 'web-track-1',
        sources: ['search'],
        provenance: [{ kind: 'web_hint_recall', source: 'search' }]
      })
    ]);
  });

  it('filters avoided artists before entity recall', async () => {
    const ncmClient = ncmClientStub({
      searchArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Repeated Artist' }])
    });

    const result = await recallFromWebDiscoveryHints({
      hints: [sourcedHint({ kind: 'artist', name: 'Repeated Artist' })],
      ncmClient,
      candidatePool: new CandidatePool(),
      context: context({ currentUserText: '探索 city pop' }),
      queryPlan: null,
      avoidArtists: new Set(['repeated artist']),
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 2
    });

    expect(result).toEqual({
      summary: 'web hint entity recall added 0 candidates from 0 entities.',
      problems: ['web hint skipped: recently repeated artist Repeated Artist']
    });
    expect(ncmClient.searchArtists).not.toHaveBeenCalled();
  });
});

function sourcedHint(overrides: Partial<MusicEntityHint> & { kind: MusicEntityHint['kind']; name: string }): MusicEntityHint {
  return {
    kind: overrides.kind,
    name: overrides.name,
    styles: ['city pop'],
    sourceUrl: 'https://example.com/source',
    sourceTitle: 'source title',
    snippet: 'source snippet',
    confidence: 0.8,
    freshness: 'durable',
    observedAt: '2026-06-26T00:00:00.000Z',
    ...overrides
  } as MusicEntityHint;
}

function ncmClientStub(overrides: Partial<EntityRecallNcmClient> = {}): EntityRecallNcmClient {
  return {
    getLikedSongIds: vi.fn(async () => []),
    getSongDetails: vi.fn(async () => []),
    searchSongs: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null),
    ...overrides
  };
}

function context(overrides: Partial<MusicAgentContextSummary>): MusicAgentContextSummary {
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
    bannedSummary: '',
    ...overrides
  };
}
