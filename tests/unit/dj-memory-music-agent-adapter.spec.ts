import { describe, expect, it } from 'vitest';
import { createMusicAgentSelectionAdapter } from '../../src/server/dj-memory/music-agent-adapter.js';
import {
  DJ_MEMORY_SELECTION_PRESSURE_LIMIT,
  djMemorySnapshotSchema
} from '../../src/server/dj-memory/schema.js';
import { matchesExclusion, toSelectionPolicyCandidate } from '../../src/server/music-agent/selection-policy/types.js';
import { evaluateRanking } from '../../src/server/music-agent/selection-policy/ranking.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

const snapshot = djMemorySnapshotSchema.parse({
  metadata: {
    schemaVersion: 1,
    snapshotId: 'snapshot-adapter',
    userId: 'user-adapter',
    assembledAt: '2026-07-17T04:00:00.000Z',
    sources: []
  },
  queue: {
    currentTrack: { id: 'current', name: 'Current Song', artists: ['Current Artist'] },
    upcoming: [{ id: 'next', name: 'Next Song', artists: ['Next Artist'] }]
  },
  listeningEpisodes: [
    {
      id: 'episode-skip', trackId: 'candidate-1', trackName: 'Candidate Song', primaryArtist: 'Candidate Artist',
      listenedMs: 20_000, durationMs: 100_000, outcome: 'skipped', startedAt: '2026-07-17T03:00:00.000Z'
    },
    {
      id: 'episode-complete', trackId: 'old-track', trackName: 'Old Song', primaryArtist: 'Old Artist',
      listenedMs: 180_000, durationMs: 180_000, outcome: 'completed', startedAt: '2026-07-16T03:00:00.000Z'
    }
  ],
  preferences: [{
    id: 'preference-1', kind: 'expressed', subjectType: 'track', subjectKey: 'candidate-1',
    polarity: 'positive', score: 0.8, observedAt: '2026-07-17T02:00:00.000Z'
  }],
  tasteProfile: null,
  activeDirective: null,
  explicitExclusions: [
    { id: 'explicit-1', entityType: 'artist', entityKey: 'blocked artist', displayName: 'Blocked Artist' },
    {
      id: 'explicit-2', entityType: 'track', entityKey: 'ncm:provider-track',
      provider: 'ncm', providerId: 'provider-track', displayName: 'Hello'
    },
    {
      id: 'explicit-3', entityType: 'track', entityKey: 'creep___radiohead',
      displayName: 'Creep'
    },
    {
      id: 'explicit-4', entityType: 'track', entityKey: 'hello',
      displayName: 'Hello'
    }
  ],
  temporaryExclusions: [{
    id: 'temporary-track', name: 'Temporary Song', artists: ['Temporary Artist'], expiresAt: '2026-07-18T04:00:00.000Z'
  }],
  personalContext: null,
  retrievalHistory: [],
  configuration: [],
  sessionLog: [],
  currentMoment: { iso: '2026-07-17T04:00:00.000Z', localTime: '12:00', daypart: '中午' },
  weather: null
});

describe('DJ Memory MusicAgent adapter', () => {
  it('rejects pressure projections above the accepted 60-day cardinality bound', () => {
    const pressure = {
      trackKey: 'song___artist',
      primaryArtist: 'artist',
      earlySkipObservationCount: 0,
      earlySkipEffectiveCount: 0,
      latestEarlySkipAt: null,
      exposureEffective: 1
    };
    const parsed = djMemorySnapshotSchema.safeParse({
      ...snapshot,
      selectionPressure: {
        tracks: Array.from({ length: DJ_MEMORY_SELECTION_PRESSURE_LIMIT + 1 }, () => pressure),
        artists: []
      }
    });

    expect(parsed.success).toBe(false);
  });

  it('builds runtime context and policy state from one snapshot without hard-blocking historical episodes', () => {
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'auto-fill',
      playedTrackIds: new Set(['run-local-played'])
    });

    expect(adapter.snapshotId).toBe('snapshot-adapter');
    expect(adapter.runtimeContext).toMatchObject({ request: 'auto-fill' });
    expect(adapter.runtimeContext.queueStateSummary).toContain('current');
    expect(adapter.policyContext.queue).toMatchObject({ currentIndex: 0 });
    expect(adapter.policyContext.queue?.tracks.map((track) => track.id)).toEqual(['current', 'next']);
    expect(adapter.policyContext.explicitExclusions?.artistKeys?.has('blocked artist')).toBe(true);
    expect(adapter.policyContext.temporaryExclusions?.trackIds?.has('temporary-track')).toBe(true);
    expect(adapter.policyContext.playedTrackIds).toEqual(new Set(['run-local-played']));
    expect(adapter.policyContext.playedTrackIds?.has('candidate-1')).toBe(false);
  });

  it('turns episodes and matching evidence into source-preserving candidate pressure', () => {
    const adapter = createMusicAgentSelectionAdapter({ snapshot, request: 'auto-fill' });
    const pressure = adapter.pressureForCandidate(candidate());

    expect(pressure).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'early_skip', reasonCode: 'early_skip_track', direction: 'penalty' }),
      expect.objectContaining({ source: 'exposure', reasonCode: 'exposure_track', direction: 'penalty' }),
      expect.objectContaining({ source: 'fresh_preference', reasonCode: 'expressed_preference_match', direction: 'boost' })
    ]));
  });

  it('preserves exact lookup behavior for a high-cardinality accepted pressure projection', () => {
    const tracks = Array.from({ length: 10_000 }, (_, index) => ({
      trackKey: `other${index}::artist${index}`,
      primaryArtist: `artist-${index}`,
      earlySkipObservationCount: 0,
      earlySkipEffectiveCount: 0,
      latestEarlySkipAt: null,
      exposureEffective: 0
    }));
    tracks.push({
      trackKey: 'targetsong::targetartist',
      primaryArtist: 'targetartist',
      earlySkipObservationCount: 2,
      earlySkipEffectiveCount: 2,
      latestEarlySkipAt: '2026-07-17T03:00:00.000Z',
      exposureEffective: 1
    });
    const highCardinalitySnapshot = djMemorySnapshotSchema.parse({
      ...snapshot,
      listeningEpisodes: [],
      selectionPressure: { tracks, artists: [] }
    });

    const pressure = createMusicAgentSelectionAdapter({
      snapshot: highCardinalitySnapshot,
      request: 'auto-fill'
    }).pressureForCandidate(candidate({
      id: 'target', name: 'Target Song', artist: 'Target Artist'
    }));

    expect(pressure).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'early_skip_track', severity: 'suppress' }),
      expect.objectContaining({ reasonCode: 'exposure_track' })
    ]));
  });

  it('projects canonical track exclusions without treating a title as a global hard token', () => {
    const exclusions = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'auto-fill'
    }).policyContext.explicitExclusions;

    expect(matchesExclusion(toSelectionPolicyCandidate(candidate({
      id: 'provider-track', name: 'Hello', artist: 'Adele'
    })), exclusions)).toBe('track');
    expect(matchesExclusion(toSelectionPolicyCandidate(candidate({
      id: 'other-creep', name: 'Creep', artist: 'Radiohead'
    })), exclusions)).toBe('track');
    expect(matchesExclusion(toSelectionPolicyCandidate(candidate({
      id: 'other-hello', name: 'Hello', artist: 'Lionel Richie'
    })), exclusions)).toBeNull();
  });

  it('uses migrated legacy exposure overrides instead of treating them as zero exposure', () => {
    const legacySnapshot = djMemorySnapshotSchema.parse({
      ...snapshot,
      listeningEpisodes: [{
        id: 'legacy-episode',
        trackId: 'legacy-track',
        trackName: 'Legacy Song',
        primaryArtist: 'Legacy Artist',
        positionMs: 0,
        listenedMs: 0,
        durationMs: null,
        outcome: 'interrupted',
        startedAt: '2026-07-17T03:00:00.000Z',
        legacyExposureOverride: 0.25
      }]
    });
    const pressure = createMusicAgentSelectionAdapter({
      snapshot: legacySnapshot,
      request: 'auto-fill'
    }).pressureForCandidate(candidate({
      id: 'legacy-track', name: 'Legacy Song', artist: 'Legacy Artist'
    }));

    expect(pressure.find((item) => item.reasonCode === 'exposure_track')?.amount).toBeGreaterThan(0);
  });

  it('keeps punctuation-bearing band identities distinct from prefix solo artists', () => {
    const bandSnapshot = djMemorySnapshotSchema.parse({
      ...snapshot,
      listeningEpisodes: [
        {
          id: 'band-skip-1', trackId: 'band-track-1', trackName: 'September',
          primaryArtist: 'Earth, Wind & Fire', listenedMs: 10_000, durationMs: 100_000,
          outcome: 'skipped', startedAt: '2026-07-17T03:00:00.000Z'
        },
        {
          id: 'band-skip-2', trackId: 'band-track-2', trackName: 'Fantasy',
          primaryArtist: 'Earth, Wind & Fire', listenedMs: 10_000, durationMs: 100_000,
          outcome: 'skipped', startedAt: '2026-07-17T03:10:00.000Z'
        }
      ],
      preferences: [{
        id: 'band-preference', kind: 'expressed', subjectType: 'artist',
        subjectKey: 'Earth, Wind & Fire', polarity: 'negative', score: 0.8,
        observedAt: '2026-07-17T02:00:00.000Z'
      }]
    });
    const adapter = createMusicAgentSelectionAdapter({ snapshot: bandSnapshot, request: 'auto-fill' });

    expect(adapter.pressureForCandidate(candidate({
      id: 'band-new', name: 'Boogie Wonderland', artist: 'Earth, Wind & Fire'
    })).map((item) => item.reasonCode)).toEqual(expect.arrayContaining([
      'early_skip_artist', 'exposure_artist', 'expressed_preference_match'
    ]));
    expect(adapter.pressureForCandidate(candidate({
      id: 'earth-solo', name: 'Solo Song', artist: 'Earth'
    }))).toEqual([]);
  });

  it('grants explicit-request pressure bypass only to candidates matching the requested entity', () => {
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'explicit_request',
        subject: { type: 'artist', key: 'candidate artist', label: 'Candidate Artist' },
        revokeMatchingExclusion: true
      }
    });
    const penalty = [{
      source: 'exposure' as const,
      reasonCode: 'exposure_track' as const,
      direction: 'penalty' as const,
      amount: 0.2
    }];
    const requested = evaluateRanking({
      candidate: toSelectionPolicyCandidate(candidate()),
      context: adapter.policyContext,
      baseScore: 0.5,
      pressure: penalty
    });
    const unrelated = evaluateRanking({
      candidate: toSelectionPolicyCandidate(candidate({
        id: 'other-track', name: 'Other Song', artist: 'Other Artist'
      })),
      context: adapter.policyContext,
      baseScore: 0.5,
      pressure: penalty
    });

    expect(adapter.selectionModeForCandidate(candidate())).toBe('explicit_request');
    expect(adapter.selectionModeForCandidate(candidate({
      id: 'other-track', name: 'Other Song', artist: 'Other Artist'
    }))).toBe('autonomous');
    expect(requested.adjustedScore).toBe(0.5);
    expect(requested.contributions[0]?.bypassed).toBe(true);
    expect(unrelated.adjustedScore).toBe(0.3);
    expect(unrelated.contributions[0]?.bypassed).not.toBe(true);
  });

  it('keeps artist-qualified track requests exact while allowing an unqualified title request', () => {
    const adele = candidate({ id: 'adele-hello', name: 'Hello', artist: 'Adele' });
    const lionel = candidate({ id: 'lionel-hello', name: 'Hello', artist: 'Lionel Richie' });
    const qualified = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'explicit_request',
        subject: { type: 'track', key: 'hello___adele', label: 'Hello', artist: 'Adele' },
        revokeMatchingExclusion: true
      }
    });
    const titleOnly = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'explicit_request',
        subject: { type: 'track', key: 'hello', label: 'Hello' },
        revokeMatchingExclusion: true
      }
    });

    expect(qualified.selectionModeForCandidate(adele)).toBe('explicit_request');
    expect(qualified.selectionModeForCandidate(lionel)).toBe('autonomous');
    expect(titleOnly.selectionModeForCandidate(lionel)).toBe('explicit_request');
  });

  it('keeps a generalized style directive under ordinary pressure while adding directive evidence', () => {
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'active_directive',
        text: '来点爵士',
        revokeMatchingExclusion: false
      }
    });
    const jazzCandidate = candidate({
      id: 'jazz-track', name: 'Jazz Song', artist: 'Jazz Artist',
      evidence: ['爵士', '当前聊天推荐']
    });
    const unrelatedCandidate = candidate({
      id: 'rock-track', name: 'Rock Song', artist: 'Rock Artist',
      evidence: ['摇滚', '无关候选']
    });
    const decision = evaluateRanking({
      candidate: toSelectionPolicyCandidate(jazzCandidate),
      context: adapter.policyContext,
      baseScore: 0.5,
      pressure: [
        {
          source: 'exposure', reasonCode: 'exposure_track', direction: 'penalty', amount: 0.2
        },
        ...adapter.pressureForCandidate(jazzCandidate)
      ]
    });

    expect(adapter.policyContext).toMatchObject({ mode: 'autonomous', explicitlyRequested: false });
    expect(adapter.selectionModeForCandidate(jazzCandidate)).toBe('autonomous');
    expect(decision.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'active_directive', reasonCode: 'active_directive_match', direction: 'boost'
      }),
      expect.objectContaining({
        source: 'exposure', reasonCode: 'exposure_track'
      })
    ]));
    expect(decision.contributions.find((item) => item.reasonCode === 'exposure_track'))
      .not.toHaveProperty('bypassed');
    expect(decision.adjustedScore).toBeLessThan(0.5);
    expect(adapter.pressureForCandidate(unrelatedCandidate).map((item) => item.reasonCode))
      .not.toContain('active_directive_match');
  });

  it('matches a persisted long-form Active Directive during later auto-fill', () => {
    const directiveSnapshot = djMemorySnapshotSchema.parse({
      ...snapshot,
      activeDirective: {
        text: '接下来的自动选歌优先选择女声、女歌手或女性主唱作品；除非候选池明显不足，否则保持这个方向。',
        expiresAt: '2026-07-18T04:00:00.000Z'
      }
    });
    const adapter = createMusicAgentSelectionAdapter({
      snapshot: directiveSnapshot,
      request: 'auto-fill'
    });
    const jazzCandidate = candidate({
      id: 'female-vocal', name: 'Female Vocal Song', artist: 'Female Artist',
      evidence: ['女性主唱作品']
    });
    const unrelatedCandidate = candidate({
      id: 'later-rock', name: 'Later Rock', artist: 'Rock Artist',
      evidence: ['摇滚候选']
    });

    expect(adapter.pressureForCandidate(jazzCandidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'active_directive', reasonCode: 'active_directive_match', direction: 'boost'
      })
    ]));
    expect(adapter.pressureForCandidate(unrelatedCandidate).map((item) => item.reasonCode))
      .not.toContain('active_directive_match');
  });

  it('applies an explicit negative Active Directive as ranking pressure', () => {
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'active_directive',
        text: '今天不想听摇滚',
        revokeMatchingExclusion: false
      }
    });
    const rockCandidate = candidate({
      id: 'rock-track', name: 'Rock Song', artist: 'Rock Artist',
      evidence: ['摇滚候选']
    });

    expect(adapter.pressureForCandidate(rockCandidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'active_directive', reasonCode: 'active_directive_match', direction: 'penalty'
      })
    ]));
  });

  it('uses matching directive evidence even when intentMatch is zero', () => {
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      selectionIntent: {
        type: 'active_directive',
        text: '来点爵士',
        revokeMatchingExclusion: false
      }
    });
    const jazzCandidate = candidate({
      id: 'jazz-zero-intent', name: 'Jazz Song', artist: 'Jazz Artist',
      evidence: ['爵士候选'],
      scores: { ...candidate().scores, intentMatch: 0 }
    });

    expect(adapter.pressureForCandidate(jazzCandidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'active_directive', reasonCode: 'active_directive_match', amount: 0.06
      })
    ]));
  });
});

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'candidate-1', name: 'Candidate Song', artist: 'Candidate Artist', sources: ['search'], evidence: [],
    scores: { intentMatch: 0.5, tasteMatch: 0.5, timeFit: 0.5, contextFit: 0.5, novelty: 0.5, sourceConfidence: 0.5 },
    ...overrides
  };
}
