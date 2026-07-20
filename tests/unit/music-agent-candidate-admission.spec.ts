import { describe, expect, it } from 'vitest';
import {
  candidateFromTrack,
  countCandidateArtistKeys,
  emptyUpsertTracksResult,
  mergeUpsertTracksResult,
  sourceScores,
  summarizeCandidateAdmission,
  upsertTracks,
  usesExternalQuality
} from '../../src/server/music-agent/candidate-admission';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import type { MusicAgentContextSummary, MusicCandidate, MusicCandidateScores } from '../../src/server/music-agent/schema';
import { createSelectionDecisionRecorder } from '../../src/server/music-agent/selection-policy/decision-trace';
import { buildSelectionPolicyReplayCases } from '../../src/server/music-agent/selection-policy/replay-case';

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
      rejectedReasons: { pool_full: 2 }
    });
    mergeUpsertTracksResult(result, {
      ...emptyUpsertTracksResult(),
      added: 1,
      mergedByDedupe: 1,
      mergedByIdAndDedupe: 1,
      invalid: 1,
      rejectedByPool: 1,
      rejectedReasons: { pool_full: 1 }
    });

    expect(result).toMatchObject({
      added: 3,
      inserted: 1,
      mergedById: 1,
      mergedByDedupe: 1,
      mergedByIdAndDedupe: 1,
      invalid: 1,
      rejectedByPool: 3,
      rejectedReasons: { pool_full: 3 }
    });
    expect(summarizeCandidateAdmission(result)).toBe(
      'candidate admission: inserted=1; mergedById=1; mergedByDedupe=1; mergedByIdAndDedupe=1; invalid=1; rejectedByPool=3 (pool_full=3)'
    );
    expect(summarizeCandidateAdmission(emptyUpsertTracksResult())).toBeNull();
  });

  it('upserts tracks through the candidate pool and reports admission outcomes', () => {
    const pool = new CandidatePool({ maxCandidates: 3 });
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
      scores: baseScores()
    });

    expect(result).toMatchObject({
      added: 3,
      inserted: 3,
      mergedById: 0,
      mergedByDedupe: 0,
      invalid: 1,
      rejectedByPool: 3,
      rejectedReasons: { pool_full: 3 }
    });
    expect(pool.count()).toBe(3);
    expect(pool.get('avoided')?.artist).toBe('Avoid Artist');
    expect(pool.get('inserted')?.sources).toEqual(['search']);
    expect(pool.get('inserted')?.provenance).toEqual([{ kind: 'exact_recall', source: 'search' }]);
  });

  it('rejects hard-ineligible tracks before admission regardless of liked provenance', () => {
    const pool = new CandidatePool();
    const result = upsertTracks(pool, [{
      id: 'unplayable-liked',
      name: 'Unavailable Song',
      artists: ['Valid Artist'],
      qualitySignals: { copyright: 0 }
    }], 'liked', {
      evidence: 'liked recall',
      scores: baseScores()
    });

    expect(result).toMatchObject({
      added: 0,
      ineligible: 1,
      ineligibleReasons: { copyright_unavailable: 1 }
    });
    expect(pool.count()).toBe(0);
  });

  it('drops unsolicited DJ versions before they enter the autonomous candidate pool', () => {
    const recorder = createSelectionDecisionRecorder();
    const pool = new CandidatePool({ selectionDecisionRecorder: recorder });
    const result = upsertTracks(pool, [{
      id: 'playlist-dj-version',
      name: '秒针 (Dj版)',
      artists: ['阿梨粤', 'DJR7'],
      qualitySignals: { popularity: 100, copyright: 2 }
    }], 'playlist', {
      evidence: 'playlist recall',
      scores: baseScores()
    });

    expect(result).toMatchObject({
      added: 0,
      ineligible: 1,
      ineligibleReasons: { candidate_quality: 1 }
    });
    expect(pool.count()).toBe(0);
    expect(recorder.snapshot()).toContainEqual(expect.objectContaining({
      stage: 'admission',
      action: 'rejected',
      reasonCode: 'candidate_quality',
      candidateId: 'playlist-dj-version'
    }));
  });

  it('applies the configured explicit exclusion during admission and records the real decision', () => {
    const recorder = createSelectionDecisionRecorder();
    const pool = new CandidatePool({
      selectionPolicyContext: {
        mode: 'explicit_request',
        explicitlyRequested: true,
        explicitExclusions: { primaryArtists: new Set(['blocked artist']) }
      },
      selectionDecisionRecorder: recorder
    });

    const result = upsertTracks(pool, [{
      id: 'blocked-track', name: 'Blocked Song', artists: ['Blocked Artist']
    }], 'search', { evidence: 'chat recall', scores: baseScores() });

    expect(result).toMatchObject({ added: 0, ineligible: 1 });
    expect(pool.count()).toBe(0);
    expect(recorder.snapshot()).toEqual([expect.objectContaining({
      stage: 'admission',
      action: 'rejected',
      reasonCode: 'explicit_artist_exclusion',
      candidateId: 'blocked-track'
    })]);
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
      rejectedByPool: 0
    });
    expect(pool.count()).toBe(2);
    expect(pool.get('same-id')?.artist).toBe('Same Id Artist');
    expect(pool.get('dedupe-a')?.sources).toEqual(['playlist']);
  });

  it('keeps collaborator candidates for Batch diversity instead of silently capping Recall', () => {
    const pool = new CandidatePool();
    const result = upsertTracks(pool, [
      { id: 'collab', name: 'Collab Song', artists: ['Lead Artist', 'Guest Artist'] }
    ], 'style_expansion', {
      evidence: '风格扩展',
      scores: baseScores()
    });

    expect(result).toMatchObject({
      added: 1,
      inserted: 1
    });
    expect(pool.count()).toBe(1);
  });

  it('counts candidate artist keys for discovery-gap diagnostics', () => {
    expect(Object.fromEntries(countCandidateArtistKeys([
      candidate({ id: 'lead', artist: 'Lead Artist / Guest Artist' }),
      candidate({ id: 'guest', artist: 'Guest Artist' })
    ]))).toEqual({
      'lead artist': 1,
      'guest artist': 2
    });
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

  it('records malformed NCM identities as unique admission-rejected replay cases', () => {
    const context = { mode: 'autonomous' as const, explicitlyRequested: false };
    const recorder = createSelectionDecisionRecorder();
    const pool = new CandidatePool({
      selectionPolicyContext: context,
      selectionDecisionRecorder: recorder
    });

    const result = upsertTracks(pool, [
      { id: 'malformed', name: 'Missing Artist', artists: [] },
      { id: 'malformed', name: '', artists: ['Missing Name Artist'] }
    ], 'search', {
      evidence: 'search recall',
      scores: baseScores()
    });
    const replayCandidates = pool.replayCandidates();
    const replayCases = buildSelectionPolicyReplayCases({
      candidates: replayCandidates,
      context,
      batchLimit: 1
    });

    expect(result).toMatchObject({ invalid: 2, added: 0 });
    expect(replayCandidates.map((candidate) => candidate.id)).toHaveLength(2);
    expect(new Set(replayCandidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(replayCases).toHaveLength(2);
    expect(replayCases.map((item) => item.expected)).toEqual([
      expect.objectContaining({
        admission: { action: 'reject', reasonCodes: ['invalid_track_identity'] },
        recall: null,
        ranking: null,
        batch: null,
        final: null,
        finalContext: null
      }),
      expect.objectContaining({
        admission: { action: 'reject', reasonCodes: ['invalid_track_identity'] },
        final: null,
        finalContext: null
      })
    ]);
    expect(recorder.snapshot().filter((decision) => (
      decision.stage === 'admission' && decision.reasonCode === 'invalid_track_identity'
    ))).toHaveLength(2);
  });

  it('can adjust positive scores per admitted track without mutating the base score object', () => {
    const pool = new CandidatePool();
    const base = baseScores();
    const result = upsertTracks(pool, [
      { id: 'liked-artist', name: 'Known Artist Search', artists: ['Known Artist'] },
      { id: 'fresh', name: 'Fresh Search', artists: ['Fresh Artist'] }
    ], 'search', {
      evidence: '网易云搜索',
      scores: base,
      scoreForTrack: (track) => track.id === 'liked-artist'
        ? { ...base, contextFit: base.contextFit + 0.04 }
        : base
    });

    expect(result).toMatchObject({ added: 2, inserted: 2 });
    expect(pool.get('liked-artist')?.scores.contextFit).toBeCloseTo(base.contextFit + 0.04, 5);
    expect(pool.get('fresh')?.scores.contextFit).toBe(base.contextFit);
    expect(base.contextFit).toBe(0.5);
  });

  it('keeps source score mapping and external quality eligibility stable', () => {
    expect(sourceScores('liked', context({ discoveryMode: 'comfort' }))).toMatchObject({ tasteMatch: 0.94, sourceConfidence: 0.88, novelty: 0.35 });
    const exploreExpectations = [
      ['liked', { tasteMatch: 0.72, sourceConfidence: 0.68, novelty: 0.32 }],
      ['playlist', { tasteMatch: 0.66, sourceConfidence: 0.62, novelty: 0.48 }],
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
      id: 'playlist-external',
      name: 'Playlist Song',
      artist: 'Playlist Artist',
      sources: ['playlist'],
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
    contextFit: 0.5,
    novelty: 0.5,
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
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}
