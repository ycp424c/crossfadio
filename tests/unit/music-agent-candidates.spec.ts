import { describe, expect, it } from 'vitest';
import {
  buildCandidateDedupeKey,
  CandidatePool,
  validateFinalPicks
} from '../../src/server/music-agent/candidates.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Song',
    artist: 'Artist',
    sources: ['liked'],
    evidence: ['liked by user'],
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

describe('CandidatePool', () => {
  it('merges candidates by id and keeps all sources/evidence', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({
      id: 'same',
      sources: ['liked'],
      evidence: ['liked evidence'],
      scores: { ...candidate().scores, intentMatch: 0.4, recentPenalty: 0.1 }
    }));
    pool.upsert(candidate({
      id: 'same',
      sources: ['trend', 'liked'],
      evidence: ['trend evidence', 'liked evidence'],
      scores: { ...candidate().scores, intentMatch: 0.9, tasteMatch: 0.8, recentPenalty: 0.3 }
    }));

    const merged = pool.get('same');

    expect(pool.count()).toBe(1);
    expect(merged?.sources).toEqual(['liked', 'trend']);
    expect(merged?.evidence).toEqual(['liked evidence', 'trend evidence']);
    expect(merged?.scores.intentMatch).toBe(0.9);
    expect(merged?.scores.tasteMatch).toBe(0.8);
    expect(merged?.scores.recentPenalty).toBe(0.3);
  });

  it('deduplicates same title and primary artist across different ids', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'track-1', name: 'Song', artist: 'Artist / Other', sources: ['liked'] }));
    pool.upsert(candidate({ id: 'track-2', name: 'Song', artist: 'Artist', sources: ['search'], evidence: ['search hit'] }));

    expect(pool.count()).toBe(1);
    expect(pool.has('track-1')).toBe(true);
    expect(pool.has('track-2')).toBe(false);
    expect(pool.get('track-1')?.sources).toEqual(['liked', 'search']);
    expect(pool.get('track-1')?.evidence).toEqual(['liked by user', 'search hit']);
  });

  it('builds normalized dedupe key from title and primary artist', () => {
    expect(buildCandidateDedupeKey(candidate({
      name: '  Song (Live) ',
      artist: ' Artist / Other '
    }))).toBe('song::artist');
  });

  it('filters banned artists and banned tracks', () => {
    const pool = new CandidatePool({
      bannedArtists: ['Blocked Artist'],
      bannedTrackIds: ['blocked-track']
    });

    pool.upsert(candidate({ id: 'blocked-track' }));
    pool.upsert(candidate({ id: 'artist-track', artist: 'Blocked Artist / Guest' }));
    pool.upsert(candidate({ id: 'allowed-track', artist: 'Allowed Artist' }));

    expect(pool.list().map((item) => item.id)).toEqual(['allowed-track']);
  });

  it('validateFinalPicks rejects picks not in pool and accepts valid picks from candidate source', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'known', sources: ['liked', 'trend'] }));

    expect(validateFinalPicks([{ id: 'known', reason: 'fits', source: 'trend' }], pool))
      .toEqual([{ id: 'known', reason: 'fits', source: 'trend' }]);
    expect(() => validateFinalPicks([{ id: 'missing', reason: 'fits', source: 'trend' }], pool))
      .toThrow(/not in candidate pool/i);
  });

  it('validateFinalPicks rejects source mismatch if final pick source is not present in candidate.sources', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'known', sources: ['liked'] }));

    expect(() => pool.validateFinalPicks([{ id: 'known', reason: 'fits', source: 'trend' }]))
      .toThrow(/source mismatch/i);
  });

  it('returns cloned list entries and respects maxCandidates for new candidates', () => {
    const pool = new CandidatePool({ maxCandidates: 1 });
    pool.upsert(candidate({ id: 'one' }));
    pool.upsert(candidate({ id: 'two' }));

    const [first] = pool.list();
    first.sources.push('trend');

    expect(pool.count()).toBe(1);
    expect(pool.get('one')?.sources).toEqual(['liked']);
  });
});
