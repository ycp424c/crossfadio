import { describe, expect, it, vi } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import {
  recallFromSemanticEntities,
  type MusicAgentEmbeddingClient
} from '../../src/server/music-agent/semantic-recall';
import type { EntityRecallNcmClient } from '../../src/server/music-agent/entity-recall';
import type { MusicAgentContextSummary, QueryPlan } from '../../src/server/music-agent/schema';

describe('MusicAgent semantic recall', () => {
  it('does not attempt semantic discovery when embedding runtime is unavailable', async () => {
    const result = await recallFromSemanticEntities({
      semanticQueries: ['city pop'],
      userId: 'user-1',
      ncmClient: ncmClientStub(),
      candidatePool: new CandidatePool(),
      context: context({ currentUserText: '找点 city pop' }),
      queryPlan: plan({ styleHints: ['city pop'] }),
      embeddingClient: null,
      embeddingModel: null,
      avoidArtists: new Set(),
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 3
    });

    expect(result).toEqual({
      attempted: false,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery unavailable: embedding client is not configured']
    });
  });

  it('builds semantic intent text from queries, plan, and context before vector lookup', async () => {
    const embeddingClient: MusicAgentEmbeddingClient = {
      embed: vi.fn(async () => ({
        vectors: [new Float32Array()],
        model: 'test-embedding',
        dimensions: 0
      }))
    };

    const result = await recallFromSemanticEntities({
      semanticQueries: ['city pop 女声'],
      userId: 'user-1',
      ncmClient: ncmClientStub(),
      candidatePool: new CandidatePool(),
      context: context({
        currentUserText: '下午想听轻一点',
        activeDirective: '不要太吵',
        tasteSummary: '偏好 city pop'
      }),
      queryPlan: plan({
        styleHints: ['city pop'],
        listeningConstraints: ['低能量']
      }),
      embeddingClient,
      embeddingModel: 'test-embedding',
      avoidArtists: new Set(),
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      limit: 3
    });

    expect(embeddingClient.embed).toHaveBeenCalledTimes(1);
    expect(embeddingClient.embed).toHaveBeenCalledWith(
      expect.stringContaining('city pop 女声'),
      { signal: undefined }
    );
    const text = vi.mocked(embeddingClient.embed).mock.calls[0]?.[0];
    expect(text).toEqual(expect.stringContaining('低能量'));
    expect(text).toEqual(expect.stringContaining('不要太吵'));
    expect(result).toEqual({
      attempted: true,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery returned no embedding vector']
    });
  });
});

function ncmClientStub(): EntityRecallNcmClient {
  return {
    getLikedSongIds: vi.fn(async () => []),
    getSongDetails: vi.fn(async () => []),
    searchSongs: vi.fn(async () => []),
    getPlaylistDetail: vi.fn(async () => null)
  };
}

function context(overrides: Partial<MusicAgentContextSummary>): MusicAgentContextSummary {
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
    bannedSummary: '',
    ...overrides
  };
}

function plan(overrides: Partial<QueryPlan>): QueryPlan {
  return {
    exactTrackQueries: [],
    artistAnchors: [],
    albumAnchors: [],
    playlistQueries: [],
    intentQueries: [],
    tasteAnchorQueries: [],
    trendQueries: [],
    explorationQueries: [],
    styleHints: [],
    listeningConstraints: [],
    avoidArtists: [],
    negativeTerms: [],
    rationale: '',
    ...overrides
  };
}
