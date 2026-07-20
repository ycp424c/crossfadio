import { describe, expect, it, vi } from 'vitest';
import {
  evaluateWebMusicDiscoveryGate,
  runWebMusicDiscovery
} from '../../src/server/music-agent/web-discovery-run';
import type {
  MusicAgentContextSummary,
  MusicCandidate,
  MusicCandidateScores,
  MusicEntityHint,
  QueryFunnelEntry
} from '../../src/server/music-agent/schema';

describe('MusicAgent web discovery runner', () => {
  it('runs provider discovery with bounded hints and parsed sourced hints', async () => {
    const provider = {
      discover: vi.fn(async () => [
        sourcedHint({ kind: 'artist', name: 'Fresh Artist' }),
        { kind: 'artist', name: 'Missing Source' }
      ])
    };

    const result = await runWebMusicDiscovery({
      toolInput: {
        intent: '探索一些类似 city pop 的歌手',
        anchors: [{ type: 'style', name: 'city pop' }],
        maxHints: 99
      },
      userId: 'user-1',
      context: context({ currentUserText: '探索一些类似 city pop 的歌手' }),
      candidates: [],
      queryFunnel: [],
      webDiscoveryProvider: provider,
      webDiscoveryCalled: false,
      ncmSearches: 0,
      targetExternalCandidateCount: 2,
      maxWebDiscoveryHints: 4
    });

    expect(provider.discover).toHaveBeenCalledTimes(1);
    expect(provider.discover.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      intent: '探索一些类似 city pop 的歌手',
      focus: 'similar_tracks',
      maxHints: 4
    }));
    expect(result.called).toBe(true);
    expect(result.summary).toBe('web discovery returned 1 hints from 2 raw hints.');
    expect(result.problems).toEqual(['web hint skipped: invalid sourced hint']);
    expect(result.data).toEqual(expect.objectContaining({
      allowed: true,
      hints: [expect.objectContaining({ name: 'Fresh Artist' })]
    }));
    expect(result.data.signals).toEqual(expect.arrayContaining(['explicit_explore_intent']));
  });

  it('denies discovery without calling the provider when comfort mode is active', async () => {
    const provider = { discover: vi.fn(async () => [sourcedHint({ kind: 'artist', name: 'Ignored' })]) };

    const result = await runWebMusicDiscovery({
      toolInput: { intent: '探索新歌' },
      userId: 'user-1',
      context: context({ currentUserText: '探索新歌', discoveryMode: 'comfort' }),
      candidates: [],
      queryFunnel: [],
      webDiscoveryProvider: provider,
      webDiscoveryCalled: false,
      ncmSearches: 0,
      targetExternalCandidateCount: 2
    });

    expect(provider.discover).not.toHaveBeenCalled();
    expect(result.called).toBe(false);
    expect(result.summary).toBe('web discovery skipped: discovery mode is comfort.');
    expect(result.problems).toEqual(['web discovery denied: discovery mode is comfort']);
    expect(result.data).toEqual(expect.objectContaining({ allowed: false }));
  });

  it('allows non-explicit discovery when candidate and query-funnel gap signals are strong', () => {
    const gate = evaluateWebMusicDiscoveryGate({
      discoveryInput: {
        intent: 'regular background music',
        focus: 'scene_overview',
        anchors: [],
        locale: 'global',
        freshness: 'durable',
        maxHints: 6
      },
      context: context({ currentUserText: 'regular background music' }),
      userId: 'user-1',
      candidates: [
        candidate({ id: 'liked-1', artist: 'Artist A', sources: ['liked'] }),
        candidate({ id: 'liked-2', artist: 'Artist B', sources: ['liked'] })
      ],
      queryFunnel: [queryFunnelEntry({ resultCount: 6, addedCount: 0 })],
      webDiscoveryCalled: false,
      ncmSearches: 1,
      targetExternalCandidateCount: 2
    });

    expect(gate.allowed).toBe(true);
    expect(gate.signals).toEqual(expect.arrayContaining([
      'sparse_external_candidates',
      'low_source_diversity',
      'query_funnel_low_yield',
      'semantic_or_exact_discovery_empty'
    ]));
  });
});

function sourcedHint(overrides: Partial<MusicEntityHint> & { kind: MusicEntityHint['kind']; name: string }): MusicEntityHint {
  return {
    kind: overrides.kind,
    name: overrides.name,
    styles: [],
    sourceUrl: 'https://example.com/source',
    sourceTitle: 'source title',
    snippet: 'source snippet',
    confidence: 0.8,
    freshness: 'durable',
    observedAt: '2026-06-26T00:00:00.000Z',
    ...overrides
  } as MusicEntityHint;
}

function candidate(overrides: Partial<MusicCandidate>): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Song',
    artist: 'Artist',
    sources: ['search'],
    evidence: [],
    scores: scores(),
    ...overrides
  };
}

function scores(): MusicCandidateScores {
  return {
    intentMatch: 0.7,
    tasteMatch: 0.7,
    timeFit: 0.7,
    contextFit: 0.5,
    novelty: 0.5,
    sourceConfidence: 0.7
  };
}

function queryFunnelEntry(overrides: Partial<QueryFunnelEntry>): QueryFunnelEntry {
  return {
    query: 'city pop',
    normalizedQuery: 'city pop',
    source: 'search',
    searchedCount: 1,
    resultCount: 0,
    addedCount: 0,
    selectedCount: 0,
    scoreMultiplier: 1,
    repeatPenalty: 0,
    selectionRate: 0,
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
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}
