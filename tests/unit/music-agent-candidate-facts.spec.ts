import { describe, expect, it } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import type { MusicCandidate } from '../../src/server/music-agent/schema';

describe('MusicAgent candidate fact merge', () => {
  it('preserves copyright unavailability regardless of candidate merge order', () => {
    const unavailableFirst = mergedCopyright(0, 1);
    const unavailableLast = mergedCopyright(1, 0);

    expect(unavailableFirst.qualitySignals?.copyright).toBe(0);
    expect(unavailableLast.qualitySignals?.copyright).toBe(0);
  });
});

function mergedCopyright(first: number, second: number): MusicCandidate {
  const pool = new CandidatePool();
  pool.upsert(candidate(first, 'search'));
  pool.upsert(candidate(second, 'liked'));
  return pool.get('same')!;
}

function candidate(copyright: number, source: 'search' | 'liked'): MusicCandidate {
  return {
    id: 'same',
    name: 'Valid Song',
    artist: 'Valid Artist',
    sources: [source],
    evidence: [source],
    scores: {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      contextFit: 0.5,
      novelty: 0.5,
      sourceConfidence: 0.5
    },
    qualitySignals: { copyright }
  };
}
