import { describe, expect, it } from 'vitest';
import {
  candidateFromTrack,
  countCandidateArtistKeys,
  emptyUpsertTracksResult,
  mergeUpsertTracksResult,
  skippedRecallProblems,
  sourceScores,
  summarizeCandidateAdmission,
  upsertTracks,
  usesExternalQuality
} from '../../src/server/music-agent/candidate-admission';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import type { MusicAgentContextSummary, MusicCandidate, MusicCandidateScores } from '../../src/server/music-agent/schema';

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
      provenance: [{ kind: 'exact_recall', source: 'search' }],
      evidence: ['网易云搜索: City Light Fresh Artist'],
      scores,
      qualitySignals: { popularity: 72, titlePollution: 'none' }
    });
    expect(candidate?.scores).not.toBe(scores);
    expect(candidate?.qualitySignals).not.toBe(qualitySignals);
    expect(candidate?.provenance).toEqual([{ kind: 'exact_recall', source: 'search' }]);
    expect(candidateFromTrack({ id: '', name: 'No Id', artists: ['Artist'] }, 'search', { evidence: '', scores })).toBeNull();
    expect(candidateFromTrack({ id: 'missing-artist', name: 'Song', artists: [] }, 'search', { evidence: '', scores })).toBeNull();
  });

  it('accepts explicit provenance and clones it when converting tracks', () => {
    const scores = baseScores();
    const provenance = { kind: 'web_hint_recall', source: 'search', detail: 'web hint: Fresh Artist' } as const;
    const candidate = candidateFromTrack({
      id: 'web-1',
      name: 'Web Song',
      artists: ['Fresh Artist']
    }, 'search', {
      evidence: 'web hint recall',
      scores,
      provenance
    });

    expect(candidate?.provenance).toEqual([provenance]);
    expect(candidate?.provenance?.[0]).not.toBe(provenance);
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

  it('upserts tracks through the candidate pool and reports admission outcomes', () => {
    const pool = new CandidatePool({ bannedIds: ['banned'], maxCandidates: 2 });
    const artistCounts = new Map([['cap artist', 2]]);
    const result = upsertTracks(pool, [
      { id: 'inserted', name: 'First Song', artists: ['Fresh Artist'] },
      { id: 'second', name: 'Second Song', artists: ['Second Artist'] },
      { id: 'missing-artist', name: 'No Artist', artists: [] },
      { id: 'avoided', name: 'Avoided Song', artists: ['Avoid Artist'] },
      { id: 'capped', name: 'Capped Song', artists: ['Cap Artist'] },
      { id: 'banned', name: 'Banned Song', artists: ['Banned Artist'] },
      { id: 'overflow', name: 'Overflow Song', artists: ['Overflow Artist'] }
    ], 'search', {
      evidence: '网易云搜索',
      scores: baseScores(),
      avoidArtists: new Set(['avoid artist']),
      artistCounts
    });

    expect(result).toMatchObject({
      added: 2,
      inserted: 2,
      mergedById: 0,
      mergedByDedupe: 0,
      invalid: 1,
      rejectedByPool: 2,
      rejectedReasons: { banned_id: 1, pool_full: 1 },
      skippedAvoidedArtists: 1,
      skippedArtistCap: 1
    });
    expect(pool.count()).toBe(2);
    expect(pool.get('inserted')?.sources).toEqual(['search']);
    expect(pool.get('inserted')?.provenance).toEqual([{ kind: 'exact_recall', source: 'search' }]);
    expect(artistCounts.get('fresh artist')).toBe(1);
    expect(artistCounts.get('second artist')).toBe(1);
    expect(artistCounts.get('cap artist')).toBe(2);
  });

  it('reports candidate pool id and dedupe merges as accepted admissions', () => {
    const pool = new CandidatePool();
    const result = upsertTracks(pool, [
      { id: 'same-id', name: 'Same Id Original', artists: ['Same Id Artist'] },
      { id: 'same-id', name: 'Same Id Alternate', artists: ['Same Id Guest'] },
      { id: 'dedupe-a', name: 'Dedupe Song', artists: ['Dedupe Artist'] },
      { id: 'dedupe-b', name: 'Dedupe Song', artists: ['Dedupe Artist'] }
    ], 'playlist', {
      evidence: '歌单召回',
      scores: baseScores()
    });

    expect(result).toMatchObject({
      added: 4,
      inserted: 2,
      mergedById: 1,
      mergedByDedupe: 1,
      skippedArtistCap: 0,
      rejectedByPool: 0
    });
    expect(pool.count()).toBe(2);
    expect(pool.get('same-id')?.artist).toBe('Same Id Artist');
    expect(pool.get('dedupe-a')?.sources).toEqual(['playlist']);
  });

  it('applies the per-artist cap to collaborator artist keys', () => {
    const pool = new CandidatePool();
    const result = upsertTracks(pool, [
      { id: 'collab', name: 'Collab Song', artists: ['Lead Artist', 'Guest Artist'] }
    ], 'style_expansion', {
      evidence: '风格扩展',
      scores: baseScores(),
      artistCounts: new Map([['guest artist', 2]])
    });

    expect(result).toMatchObject({
      added: 0,
      inserted: 0,
      skippedArtistCap: 1
    });
    expect(pool.count()).toBe(0);
  });

  it('counts candidate artist keys and formats skipped recall problems', () => {
    expect(Object.fromEntries(countCandidateArtistKeys([
      candidate({ id: 'lead', artist: 'Lead Artist / Guest Artist' }),
      candidate({ id: 'guest', artist: 'Guest Artist' })
    ]))).toEqual({
      'lead artist': 1,
      'guest artist': 2
    });

    expect(skippedRecallProblems({
      skippedAvoidedArtists: 2,
      skippedArtistCap: 1
    })).toEqual([
      'skipped 2 tracks from recently repeated artists',
      'skipped 1 tracks after per-artist recall cap'
    ]);
    expect(skippedRecallProblems(emptyUpsertTracksResult())).toEqual([]);
  });

  it('stops upserting after the max accepted admission count', () => {
    const pool = new CandidatePool();
    const result = upsertTracks(pool, [
      { id: 'invalid', name: 'Invalid', artists: [] },
      { id: 'one', name: 'One', artists: ['Artist One'] },
      { id: 'two', name: 'Two', artists: ['Artist Two'] }
    ], 'trend', {
      evidence: '趋势召回',
      scores: baseScores(),
      maxAccepted: 1
    });

    expect(result).toMatchObject({ added: 1, inserted: 1, invalid: 1 });
    expect(pool.count()).toBe(1);
    expect(pool.get('two')).toBeUndefined();
  });

  it('can adjust scores per admitted track without mutating the base score object', () => {
    const pool = new CandidatePool();
    const base = baseScores();
    const result = upsertTracks(pool, [
      { id: 'liked-artist', name: 'Known Artist Search', artists: ['Known Artist'] },
      { id: 'fresh', name: 'Fresh Search', artists: ['Fresh Artist'] }
    ], 'search', {
      evidence: '网易云搜索',
      scores: base,
      scoreForTrack: (track) => track.id === 'liked-artist'
        ? { ...base, recentPenalty: base.recentPenalty + 0.04 }
        : base
    });

    expect(result).toMatchObject({ added: 2, inserted: 2 });
    expect(pool.get('liked-artist')?.scores.recentPenalty).toBe(0.04);
    expect(pool.get('fresh')?.scores.recentPenalty).toBe(0);
    expect(base.recentPenalty).toBe(0);
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

function candidate(overrides: Partial<MusicCandidate>): MusicCandidate {
  return {
    id: 'candidate',
    name: 'Song',
    artist: 'Artist',
    sources: ['search'],
    evidence: [],
    scores: baseScores(),
    ...overrides
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
