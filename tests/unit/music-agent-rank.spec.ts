import { describe, expect, it } from 'vitest';
import { diversifyCandidates, scoreCandidate } from '../../src/server/music-agent/rank.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Song',
    artist: 'Artist',
    sources: ['liked'],
    evidence: [],
    scores: {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      planFit: 0.5,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.5
    },
    ...overrides
  };
}

describe('music-agent ranking', () => {
  it('uses the planned score weights exactly and floors negative scores', () => {
    expect(scoreCandidate(candidate({
      scores: {
        intentMatch: 0.9,
        tasteMatch: 0.8,
        timeFit: 0.7,
        planFit: 0.6,
        sourceConfidence: 0.5,
        novelty: 0.4,
        recentPenalty: 0.2,
        skipPenalty: 0.1
      }
    }))).toBeCloseTo(0.405, 5);

    expect(scoreCandidate(candidate({
      scores: {
        intentMatch: 0,
        tasteMatch: 0,
        timeFit: 0,
        planFit: 0,
        sourceConfidence: 0,
        novelty: 0,
        recentPenalty: 0.2,
        skipPenalty: 0.3
      }
    }))).toBe(0);
  });

  it('scores active-directive high intent candidate higher than trend-only novelty', () => {
    const directiveMatch = candidate({
      id: 'directive',
      sources: ['plan', 'liked'],
      scores: {
        intentMatch: 0.95,
        tasteMatch: 0.75,
        timeFit: 0.8,
        planFit: 0.9,
        novelty: 0.2,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 0.9
      }
    });
    const trendOnlyNovelty = candidate({
      id: 'trend',
      sources: ['trend'],
      scores: {
        intentMatch: 0.25,
        tasteMatch: 0.35,
        timeFit: 0.45,
        planFit: 0.1,
        novelty: 1,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 0.5
      }
    });

    expect(scoreCandidate(directiveMatch)).toBeGreaterThan(scoreCandidate(trendOnlyNovelty));
  });

  it('subtracts recent and skip penalties', () => {
    const base = candidate({
      scores: {
        intentMatch: 0.8,
        tasteMatch: 0.8,
        timeFit: 0.8,
        planFit: 0.8,
        novelty: 0.8,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 0.8
      }
    });
    const penalized = candidate({
      id: 'penalized',
      scores: {
        ...base.scores,
        recentPenalty: 0.4,
        skipPenalty: 0.3
      }
    });

    expect(scoreCandidate(penalized)).toBeLessThan(scoreCandidate(base));
    expect(scoreCandidate(base) - scoreCandidate(penalized)).toBeCloseTo(0.7, 5);
  });

  it('diversifyCandidates spreads artists when possible', () => {
    const candidates = [
      candidate({ id: 'a1', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'a2', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 0.95 } }),
      candidate({ id: 'b1', artist: 'Artist B', scores: { ...candidate().scores, intentMatch: 0.8 } }),
      candidate({ id: 'c1', artist: 'Artist C', scores: { ...candidate().scores, intentMatch: 0.7 } })
    ];

    expect(diversifyCandidates(candidates, 3).map((item) => item.id)).toEqual(['a1', 'b1', 'c1']);
  });

  it('diversifyCandidates skips repeated artists instead of filling the limit', () => {
    const candidates = [
      candidate({ id: 'a1', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'a2', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    expect(diversifyCandidates(candidates, 3).map((item) => item.id)).toEqual(['a1']);
    expect(diversifyCandidates(candidates, 0)).toEqual([]);
  });
});
