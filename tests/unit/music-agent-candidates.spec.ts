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

    expect(pool.upsert(candidate({
      id: 'same',
      sources: ['liked'],
      provenance: [{ kind: 'liked', source: 'liked' }],
      evidence: ['liked evidence'],
      scores: { ...candidate().scores, intentMatch: 0.4, recentPenalty: 0.1 }
    }))).toEqual({ status: 'inserted' });
    expect(pool.upsert(candidate({
      id: 'same',
      sources: ['trend', 'liked'],
      provenance: [
        { kind: 'trend_recall', source: 'trend' },
        { kind: 'liked', source: 'liked' }
      ],
      evidence: ['trend evidence', 'liked evidence'],
      scores: { ...candidate().scores, intentMatch: 0.9, tasteMatch: 0.8, recentPenalty: 0.3 }
    }))).toEqual({ status: 'merged_by_id' });

    const merged = pool.get('same');

    expect(pool.count()).toBe(1);
    expect(merged?.sources).toEqual(['liked', 'trend']);
    expect(merged?.provenance).toEqual([
      { kind: 'liked', source: 'liked' },
      { kind: 'trend_recall', source: 'trend' }
    ]);
    expect(merged?.evidence).toEqual(['liked evidence', 'trend evidence']);
    expect(merged?.scores.intentMatch).toBe(0.9);
    expect(merged?.scores.tasteMatch).toBe(0.8);
    expect(merged?.scores.recentPenalty).toBe(0.3);
  });

  it('merges candidate quality signals through dedupe aliases without weakening strong flags', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({
      id: 'canonical',
      name: 'Same Song',
      artist: 'Artist',
      sources: ['search'],
      qualitySignals: { popularity: 80, privilegeSt: -200, titlePollution: 'mild' }
    }));
    pool.upsert(candidate({
      id: 'duplicate',
      name: 'Same Song',
      artist: 'Artist / Guest',
      sources: ['trend'],
      qualitySignals: { noCopyrightRcmd: true, titlePollution: 'strong' }
    }));

    pool.mergeQualitySignals('duplicate', {
      popularity: 12,
      privilegeSt: 0,
      privilegeToast: true,
      titlePollution: 'none'
    });

    expect(pool.get('canonical')?.qualitySignals).toEqual(expect.objectContaining({
      popularity: 12,
      noCopyrightRcmd: true,
      privilegeSt: -200,
      privilegeToast: true,
      titlePollution: 'strong'
    }));
    expect(pool.get('duplicate')?.qualitySignals).toEqual(pool.get('canonical')?.qualitySignals);
  });

  it('deduplicates same title and primary artist across different ids', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'track-1', name: 'Song', artist: 'Artist / Other', sources: ['liked'] }));
    expect(pool.upsert(candidate({ id: 'track-2', name: 'Song', artist: 'Artist', sources: ['search'], evidence: ['search hit'] }))).toEqual({
      status: 'merged_by_dedupe'
    });

    expect(pool.count()).toBe(1);
    expect(pool.has('track-1')).toBe(true);
    expect(pool.has('track-2')).toBe(true);
    expect(pool.get('track-1')?.sources).toEqual(['liked', 'search']);
    expect(pool.get('track-2')?.id).toBe('track-1');
    expect(pool.get('track-1')?.evidence).toEqual(['liked by user', 'search hit']);
  });

  it('deduplicates source-prefixed live variants of the same song', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'track-1', name: '感应 + 给自己的信 (Live)', artist: '钟舒漫', sources: ['search'] }));
    pool.upsert(candidate({ id: 'track-2', name: '给自己的信(Live)', artist: '钟舒漫', sources: ['liked'] }));

    expect(pool.count()).toBe(1);
    expect(pool.has('track-1')).toBe(true);
    expect(pool.has('track-2')).toBe(true);
    expect(pool.get('track-2')?.id).toBe('track-1');
  });

  it('deduplicates high-overlap title variants that are not exact substrings', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'track-1', name: '慢慢喜欢你', artist: '莫文蔚', sources: ['search'] }));
    pool.upsert(candidate({ id: 'track-2', name: '慢慢地喜欢你', artist: '莫文蔚', sources: ['liked'] }));

    expect(pool.count()).toBe(1);
    expect(pool.has('track-2')).toBe(true);
  });

  it('builds normalized dedupe key from title and primary artist', () => {
    expect(buildCandidateDedupeKey(candidate({
      name: '  Song (Live) ',
      artist: ' Artist / Other '
    }))).toBe('song::artist');
  });

  it('deduplicates exact normalized titles even when artists differ', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'track-1', name: '关于小熊（Cover 蛋堡）', artist: '', sources: ['search'] }));
    pool.upsert(candidate({ id: 'track-2', name: '关于小熊（Cover 蛋堡）', artist: '雅雅Celia', sources: ['liked'] }));

    expect(buildCandidateDedupeKey(candidate({
      name: '关于小熊（Cover 蛋堡）',
      artist: ''
    }))).toBe('关于小熊::');
    expect(pool.count()).toBe(1);
    expect(pool.has('track-2')).toBe(true);
  });

  it('filters banned artists and banned tracks by normalized track key', () => {
    const pool = new CandidatePool({
      bannedArtists: new Set(['Blocked Artist']),
      bannedTrackKeys: new Set([buildCandidateDedupeKey({ name: 'Blocked', artist: 'Other' })])
    });

    expect(pool.upsert(candidate({ id: 'different-id', name: 'Blocked', artist: 'Other / Guest' }))).toEqual({
      status: 'rejected',
      reason: 'banned_dedupe'
    });
    expect(pool.upsert(candidate({ id: 'artist-track', artist: 'Blocked Artist / Guest' }))).toEqual({
      status: 'rejected',
      reason: 'banned_artist'
    });
    expect(pool.upsert(candidate({ id: 'allowed-track', artist: 'Allowed Artist' }))).toEqual({ status: 'inserted' });

    expect(pool.list().map((item) => item.id)).toEqual(['allowed-track']);
  });

  it('merges id and dedupe conflicts into the existing id entry', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({
      id: 'canonical',
      name: 'First Song',
      artist: 'Artist',
      sources: ['liked'],
      evidence: ['canonical evidence']
    }));
    pool.upsert(candidate({
      id: 'duplicate',
      name: 'Second Song',
      artist: 'Artist',
      sources: ['trend'],
      evidence: ['duplicate evidence']
    }));
    pool.upsert(candidate({
      id: 'canonical',
      name: 'Second Song',
      artist: 'Artist / Guest',
      sources: ['search'],
      evidence: ['conflict evidence']
    }));
    pool.upsert(candidate({
      id: 'later-duplicate',
      name: 'Second Song',
      artist: 'Artist',
      sources: ['plan'],
      evidence: ['later evidence']
    }));

    expect(pool.count()).toBe(1);
    expect(pool.has('canonical')).toBe(true);
    expect(pool.has('duplicate')).toBe(true);
    expect(pool.has('later-duplicate')).toBe(true);
    expect(pool.get('canonical')?.sources).toEqual(['liked', 'trend', 'search', 'plan']);
    expect(pool.get('canonical')?.evidence).toEqual([
      'canonical evidence',
      'duplicate evidence',
      'conflict evidence',
      'later evidence'
    ]);
  });

  it('keeps alias id attached when a deduped id later arrives with a new title', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({
      id: 'canonical',
      name: 'Song',
      artist: 'Artist',
      sources: ['liked'],
      evidence: ['canonical evidence']
    }));
    pool.upsert(candidate({
      id: 'duplicate',
      name: 'Song (Live)',
      artist: 'Artist / Other',
      sources: ['search'],
      evidence: ['dedupe evidence']
    }));
    pool.upsert(candidate({
      id: 'duplicate',
      name: 'Alternate Title',
      artist: 'Artist',
      sources: ['trend'],
      evidence: ['alias evidence']
    }));

    expect(pool.count()).toBe(1);
    expect(pool.has('duplicate')).toBe(true);
    expect(pool.get('duplicate')).toEqual(pool.get('canonical'));
    expect(pool.get('duplicate')?.id).toBe('canonical');
    expect(pool.get('duplicate')?.sources).toEqual(['liked', 'search', 'trend']);
    expect(pool.get('duplicate')?.evidence).toEqual([
      'canonical evidence',
      'dedupe evidence',
      'alias evidence'
    ]);
  });

  it('validateFinalPicks rejects picks not in pool and accepts valid picks from candidate source', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'known', sources: ['liked', 'trend'] }));

    expect(validateFinalPicks([{ id: 'known', reason: 'fits', source: 'trend' }], pool))
      .toEqual([{ id: 'known', name: 'Song', artist: 'Artist', reason: 'fits', source: 'trend' }]);
    expect(() => validateFinalPicks([{ id: 'missing', reason: 'fits', source: 'trend' }], pool))
      .toThrow(/not in candidate pool/i);
  });

  it('validateFinalPicks rejects source mismatch if final pick source is not present in candidate.sources', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'known', sources: ['liked'] }));

    expect(() => pool.validateFinalPicks([{ id: 'known', reason: 'fits', source: 'trend' }]))
      .toThrow(/source mismatch/i);
  });

  it('validateFinalPicks remains source-compatible when provenance is more specific', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({
      id: 'known',
      sources: ['search'],
      provenance: [{ kind: 'web_hint_recall', source: 'search' }]
    }));

    expect(pool.validateFinalPicks([{ id: 'known', reason: 'fits', source: 'search' }]))
      .toEqual([{ id: 'known', name: 'Song', artist: 'Artist', reason: 'fits', source: 'search' }]);
  });

  it('validateFinalPicks resolves alias ids to canonical ids', () => {
    const pool = new CandidatePool();

    pool.upsert(candidate({ id: 'canonical', name: 'Song', artist: 'Artist', sources: ['liked'] }));
    pool.upsert(candidate({ id: 'duplicate', name: 'Song (Live)', artist: 'Artist / Other', sources: ['trend'] }));

    expect(pool.validateFinalPicks([{ id: 'duplicate', reason: 'fits', source: 'trend' }]))
      .toEqual([{ id: 'canonical', name: 'Song', artist: 'Artist', reason: 'fits', source: 'trend' }]);
  });

  it('validateFinalPicks rejects blank reason', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'known', sources: ['liked'] }));

    expect(() => pool.validateFinalPicks([{ id: 'known', reason: '   ', source: 'liked' }]))
      .toThrow(/reason/i);
  });

  it('returns cloned list entries and respects maxCandidates for new candidates', () => {
    const pool = new CandidatePool({ maxCandidates: 1 });
    expect(pool.upsert(candidate({ id: 'one' }))).toEqual({ status: 'inserted' });
    expect(pool.upsert(candidate({ id: 'two', name: 'Other Song', artist: 'Other Artist' }))).toEqual({
      status: 'rejected',
      reason: 'pool_full'
    });

    const [first] = pool.list();
    first.sources.push('trend');
    first.provenance?.push({ kind: 'trend_recall', source: 'trend' });

    expect(pool.count()).toBe(1);
    expect(pool.get('one')?.sources).toEqual(['liked']);
    expect(pool.get('one')?.provenance).toBeUndefined();
  });
});
