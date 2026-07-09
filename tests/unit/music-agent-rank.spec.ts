import { describe, expect, it } from 'vitest';
import {
  buildCandidateScoreTableRows,
  diversifyCandidates,
  rankCandidates,
  scoreCandidate
} from '../../src/server/music-agent/rank.js';
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
      contextFit: 0.5,
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
        contextFit: 0.6,
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
        contextFit: 0,
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
      sources: ['search', 'liked'],
      scores: {
        intentMatch: 0.95,
        tasteMatch: 0.75,
        timeFit: 0.8,
        contextFit: 0.9,
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
        contextFit: 0.1,
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
        contextFit: 0.8,
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

  it('diversifyCandidates spreads repeated title motifs when possible', () => {
    const candidates = [
      candidate({
        id: 'afternoon-1',
        name: '美術館の午後 (Bijutsukan no Gogo) - Museum Afternoon',
        artist: 'Artist A',
        scores: { ...candidate().scores, intentMatch: 1 }
      }),
      candidate({
        id: 'afternoon-2',
        name: 'オリーブの午后',
        artist: 'Artist B',
        scores: { ...candidate().scores, intentMatch: 0.98 }
      }),
      candidate({
        id: 'afternoon-3',
        name: 'Cloudy Afternoon',
        artist: 'Artist C',
        scores: { ...candidate().scores, intentMatch: 0.96 }
      }),
      candidate({
        id: 'home',
        name: '温暖, 安静, 回不去的家',
        artist: 'Artist D',
        scores: { ...candidate().scores, intentMatch: 0.7 }
      }),
      candidate({
        id: 'evening',
        name: 'Evening Walk',
        artist: 'Artist E',
        scores: { ...candidate().scores, intentMatch: 0.6 }
      })
    ];

    expect(diversifyCandidates(candidates, 3).map((item) => item.id)).toEqual(['afternoon-1', 'home', 'evening']);
  });

  it('rankCandidates lowers repeated artist scores when ordering picks', () => {
    const candidates = [
      candidate({ id: 'a1', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'a2', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 0.98 } }),
      candidate({ id: 'b1', artist: 'Artist B', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    expect(rankCandidates(candidates, 3).map((item) => item.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('rankCandidates lowers repeated collaborator scores when ordering picks', () => {
    const candidates = [
      candidate({ id: 'payphone', artist: 'Maroon 5 / Wiz Khalifa', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'girl-next-door', artist: 'mgk / Wiz Khalifa', scores: { ...candidate().scores, intentMatch: 0.98 } }),
      candidate({ id: 'fresh', artist: 'Fresh Artist', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    expect(rankCandidates(candidates, 3).map((item) => item.id)).toEqual(['payphone', 'fresh', 'girl-next-door']);
  });

  it('rankCandidates applies artist recency penalties with distance decay', () => {
    const candidates = [
      candidate({ id: 'near', artist: 'Near Artist', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'far', artist: 'Far Artist', scores: { ...candidate().scores, intentMatch: 0.95 } }),
      candidate({ id: 'fresh', artist: 'Fresh Artist', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    const ranked = rankCandidates(candidates, 3, {
      artistPenalties: new Map([
        ['near artist', 0.36],
        ['far artist', 0.01]
      ])
    });

    expect(ranked.map((item) => item.id)).toEqual(['far', 'fresh', 'near']);
  });

  it('rankCandidates applies artist recency penalties to collaborators', () => {
    const candidates = [
      candidate({ id: 'recent-collab', artist: 'Maroon 5 / Wiz Khalifa', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'fresh', artist: 'Fresh Artist', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    const ranked = rankCandidates(candidates, 2, {
      artistPenalties: new Map([['wiz khalifa', 0.3]])
    });

    expect(ranked.map((item) => item.id)).toEqual(['fresh', 'recent-collab']);
  });

  it('rankCandidates applies long-lived track penalties by normalized song key', () => {
    const candidates = [
      candidate({
        id: 'plastic-love',
        name: 'プラスティック・ラヴ',
        artist: '竹内まりや',
        scores: { ...candidate().scores, intentMatch: 1 }
      }),
      candidate({
        id: 'stay-with-me',
        name: '真夜中のドア〜stay with me',
        artist: '松原みき',
        scores: { ...candidate().scores, intentMatch: 0.92 }
      }),
      candidate({
        id: 'fresh-city-pop',
        name: 'September',
        artist: '竹内まりや',
        scores: { ...candidate().scores, intentMatch: 0.75 }
      })
    ];

    const ranked = rankCandidates(candidates, 3, {
      trackPenalties: new Map([
        ['プラスティックラヴ::竹内まりや', 0.22],
        ['真夜中のドアstaywithme::松原みき', 0.04]
      ])
    });

    expect(ranked.map((item) => item.id)).toEqual(['stay-with-me', 'fresh-city-pop', 'plastic-love']);
  });

  it('diversifyCandidates keeps the penalty-aware ranked order', () => {
    const candidates = [
      candidate({
        id: 'plastic-love',
        name: 'プラスティック・ラヴ',
        artist: '竹内まりや',
        scores: { ...candidate().scores, intentMatch: 1 }
      }),
      candidate({
        id: 'stay-with-me',
        name: '真夜中のドア〜stay with me',
        artist: '松原みき',
        scores: { ...candidate().scores, intentMatch: 0.92 }
      }),
      candidate({
        id: 'fresh-city-pop',
        name: 'September',
        artist: '竹内まりや',
        scores: { ...candidate().scores, intentMatch: 0.75 }
      })
    ];
    const options = {
      trackPenalties: new Map([
        ['プラスティックラヴ::竹内まりや', 0.22],
        ['真夜中のドアstaywithme::松原みき', 0.04]
      ])
    };

    const ranked = rankCandidates(candidates, 3, options);

    expect(diversifyCandidates(ranked, 2).map((item) => item.id)).toEqual(['stay-with-me', 'fresh-city-pop']);
  });

  it('builds console table rows with candidate scores and penalties', () => {
    const rows = buildCandidateScoreTableRows([
      candidate({
        id: 'a1',
        name: 'First',
        artist: 'Artist A',
        sources: ['liked', 'search'],
        provenance: [
          { kind: 'liked', source: 'liked' },
          { kind: 'web_hint_recall', source: 'search' }
        ],
        scores: { ...candidate().scores, intentMatch: 1 }
      }),
      candidate({
        id: 'a2',
        name: 'Second',
        artist: 'Artist A',
        sources: ['search'],
        scores: { ...candidate().scores, intentMatch: 0.9 }
      })
    ], {
      artistPenalties: new Map([['artist a', 0.12]])
    });

    expect(rows).toEqual([
      expect.objectContaining({
        rank: 1,
        id: 'a1',
        song: 'First',
        artist: 'Artist A',
        sources: 'liked,search',
        provenance: 'liked,web_hint_recall',
        baseScore: expect.any(Number),
        artistPenalty: 0.12,
        repeatPenalty: 0,
        adjustedScore: expect.any(Number)
      }),
      expect.objectContaining({
        rank: 2,
        id: 'a2',
        repeatPenalty: 0.16
      })
    ]);
    expect(rows[0].adjustedScore).toBeCloseTo(rows[0].baseScore - 0.12, 5);
    expect(rows[1].adjustedScore).toBeCloseTo(rows[1].baseScore - 0.12 - 0.16, 5);
  });

  it('penalizes weak external quality signals when ranking candidates', () => {
    const clean = candidate({
      id: 'clean',
      artist: 'Fresh Artist',
      sources: ['search'],
      qualitySignals: { popularity: 80, titlePollution: 'none' }
    });
    const lowPopularity = candidate({
      id: 'low-pop',
      artist: 'Low Artist',
      sources: ['search'],
      qualitySignals: { popularity: 30, titlePollution: 'none' },
      scores: { ...candidate().scores, intentMatch: 1 }
    });
    const noCopyright = candidate({
      id: 'no-copyright',
      artist: 'Unavailable Artist',
      sources: ['trend'],
      qualitySignals: { popularity: 70, noCopyrightRcmd: true, titlePollution: 'none' },
      scores: { ...candidate().scores, intentMatch: 1 }
    });

    const ranked = rankCandidates([lowPopularity, noCopyright, clean], 3);
    const rows = buildCandidateScoreTableRows(ranked);

    expect(ranked.map((item) => item.id)).toEqual(['low-pop', 'clean', 'no-copyright']);
    expect(rows.find((row) => row.id === 'low-pop')?.qualityPenalty).toBeGreaterThan(0);
    expect(rows.find((row) => row.id === 'low-pop')?.adjustedScore).toBeLessThan(
      rows.find((row) => row.id === 'low-pop')?.baseScore ?? 0
    );
    expect(rows.find((row) => row.id === 'no-copyright')?.qualityPenalty).toBeGreaterThan(
      rows.find((row) => row.id === 'low-pop')?.qualityPenalty ?? 0
    );
  });

  it('filters strong title pollution with very low popularity only for purely external candidates', () => {
    const pollutedExternal = candidate({
      id: 'polluted-external',
      name: "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix",
      artist: 'Search Artist',
      sources: ['search'],
      qualitySignals: { popularity: 10, titlePollution: 'strong' },
      scores: { ...candidate().scores, intentMatch: 1 }
    });
    const pollutedTrusted = candidate({
      id: 'polluted-trusted',
      name: "90's Chill Lofi Hip Hop｜勉強・集中・睡眠 深夜のローファイ mix",
      artist: 'Liked Artist',
      sources: ['search', 'liked'],
      qualitySignals: { popularity: 10, titlePollution: 'strong' },
      scores: { ...candidate().scores, intentMatch: 0.9 }
    });
    const clean = candidate({
      id: 'clean',
      artist: 'Clean Artist',
      sources: ['search'],
      qualitySignals: { popularity: 70, titlePollution: 'none' }
    });

    const rankedIds = rankCandidates([pollutedExternal, pollutedTrusted, clean], 5).map((item) => item.id);

    expect(rankedIds).not.toContain('polluted-external');
    expect(rankedIds).toHaveLength(2);
    expect(rankedIds).toEqual(expect.arrayContaining(['clean', 'polluted-trusted']));
  });

  it('diversifyCandidates skips repeated artists instead of filling the limit', () => {
    const candidates = [
      candidate({ id: 'a1', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'a2', artist: 'Artist A', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    expect(diversifyCandidates(candidates, 3).map((item) => item.id)).toEqual(['a1']);
    expect(diversifyCandidates(candidates, 0)).toEqual([]);
  });

  it('diversifyCandidates skips repeated collaborators', () => {
    const candidates = [
      candidate({ id: 'payphone', artist: 'Maroon 5 / Wiz Khalifa', scores: { ...candidate().scores, intentMatch: 1 } }),
      candidate({ id: 'girl-next-door', artist: 'mgk / Wiz Khalifa', scores: { ...candidate().scores, intentMatch: 0.98 } }),
      candidate({ id: 'fresh', artist: 'Fresh Artist', scores: { ...candidate().scores, intentMatch: 0.9 } })
    ];

    expect(diversifyCandidates(candidates, 2).map((item) => item.id)).toEqual(['payphone', 'fresh']);
  });

  it('returns cloned quality signals from ranking helpers', () => {
    const original = candidate({
      id: 'quality-clone',
      sources: ['search'],
      qualitySignals: { popularity: 80, titlePollution: 'none' }
    });

    const [ranked] = rankCandidates([original], 1);
    const [diversified] = diversifyCandidates([original], 1);
    ranked.qualitySignals!.popularity = 1;
    diversified.qualitySignals!.titlePollution = 'strong';

    expect(original.qualitySignals).toEqual({ popularity: 80, titlePollution: 'none' });
  });
});
