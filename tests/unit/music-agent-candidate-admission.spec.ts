import { describe, expect, it } from 'vitest';
import {
  candidateFromTrack,
  emptyUpsertTracksResult,
  mergeUpsertTracksResult,
  sourceScores,
  summarizeCandidateAdmission,
  usesExternalQuality
} from '../../src/server/music-agent/candidate-admission';
import type { MusicAgentContextSummary, MusicCandidateScores } from '../../src/server/music-agent/schema';

describe('MusicAgent candidate admission helpers', () => {
  it('converts NCM tracks into candidates and clones score and quality signal objects', () => {
    const scores = baseScores();
    const qualitySignals = { popularity: 72, titlePollution: 'none' } as const;
    const candidate = candidateFromTrack({
      id: 101,
      name: '  City Light  ',
      artists: [' Fresh Artist ', '', 'Guest Artist'],
      qualitySignals
    }, 'search', {
      evidence: '网易云搜索: City Light Fresh Artist',
      scores
    });

    expect(candidate).toEqual({
      id: '101',
      name: 'City Light',
      artist: 'Fresh Artist / Guest Artist',
      sources: ['search'],
      evidence: ['网易云搜索: City Light Fresh Artist'],
      scores,
      qualitySignals: { popularity: 72, titlePollution: 'none' }
    });
    expect(candidate?.scores).not.toBe(scores);
    expect(candidate?.qualitySignals).not.toBe(qualitySignals);
    expect(candidateFromTrack({ id: '', name: 'No Id', artists: ['Artist'] }, 'search', { evidence: '', scores })).toBeNull();
    expect(candidateFromTrack({ id: 'missing-artist', name: 'Song', artists: [] }, 'search', { evidence: '', scores })).toBeNull();
  });

  it('merges admission counters and keeps the summary labels stable', () => {
    const result = emptyUpsertTracksResult();
    mergeUpsertTracksResult(result, {
      ...emptyUpsertTracksResult(),
      added: 2,
      inserted: 1,
      mergedById: 1,
      rejectedByPool: 2,
      rejectedReasons: { banned_id: 1, pool_full: 1 },
      skippedAvoidedArtists: 1
    });
    mergeUpsertTracksResult(result, {
      ...emptyUpsertTracksResult(),
      added: 1,
      mergedByDedupe: 1,
      mergedByIdAndDedupe: 1,
      invalid: 1,
      rejectedByPool: 1,
      rejectedReasons: { banned_id: 1 },
      skippedArtistCap: 1
    });

    expect(result).toMatchObject({
      added: 3,
      inserted: 1,
      mergedById: 1,
      mergedByDedupe: 1,
      mergedByIdAndDedupe: 1,
      invalid: 1,
      rejectedByPool: 3,
      rejectedReasons: { banned_id: 2, pool_full: 1 },
      skippedAvoidedArtists: 1,
      skippedArtistCap: 1
    });
    expect(summarizeCandidateAdmission(result)).toBe(
      'candidate admission: inserted=1; mergedById=1; mergedByDedupe=1; mergedByIdAndDedupe=1; invalid=1; rejectedByPool=3 (banned_id=2, pool_full=1); skippedAvoidedArtists=1; skippedArtistCap=1'
    );
    expect(summarizeCandidateAdmission(emptyUpsertTracksResult())).toBeNull();
  });

  it('keeps source score mapping and external quality eligibility stable', () => {
    expect(sourceScores('liked', context({ discoveryMode: 'comfort' }))).toMatchObject({ tasteMatch: 0.94, sourceConfidence: 0.88, novelty: 0.35 });
    const exploreExpectations = [
      ['liked', { tasteMatch: 0.72, sourceConfidence: 0.68, novelty: 0.32 }],
      ['playlist', { tasteMatch: 0.66, sourceConfidence: 0.62, novelty: 0.48 }],
      ['plan', { intentMatch: 0.72, planFit: 0.76, sourceConfidence: 0.62 }],
      ['search', { intentMatch: 0.76, tasteMatch: 0.64, novelty: 0.78, sourceConfidence: 0.72 }],
      ['style_expansion', { intentMatch: 0.78, novelty: 0.8, sourceConfidence: 0.72 }],
      ['trend', { intentMatch: 0.66, tasteMatch: 0.52, novelty: 0.82, sourceConfidence: 0.7 }]
    ] as const;
    for (const [source, expected] of exploreExpectations) {
      expect(sourceScores(source, context({ discoveryMode: 'explore' }))).toMatchObject(expected);
    }
    expect(usesExternalQuality({
      id: 'external',
      name: 'External Song',
      artist: 'External Artist',
      sources: ['search', 'trend'],
      evidence: [],
      scores: baseScores()
    })).toBe(true);
    expect(usesExternalQuality({
      id: 'mixed',
      name: 'Mixed Song',
      artist: 'Mixed Artist',
      sources: ['liked', 'search'],
      evidence: [],
      scores: baseScores()
    })).toBe(false);
  });
});

function baseScores(): MusicCandidateScores {
  return {
    intentMatch: 0.5,
    tasteMatch: 0.5,
    timeFit: 0.5,
    planFit: 0.5,
    novelty: 0.5,
    recentPenalty: 0,
    skipPenalty: 0,
    sourceConfidence: 0.5
  };
}

function context(overrides: Partial<MusicAgentContextSummary>): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
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
