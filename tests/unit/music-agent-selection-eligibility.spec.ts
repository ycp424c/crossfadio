import { describe, expect, it } from 'vitest';
import {
  evaluateCandidateQuality,
  evaluateTrackCompatibility,
  type CandidateQualityFacts
} from '../../src/server/music-agent/selection-eligibility';
import type { MusicAgentContextSummary, MusicCandidate } from '../../src/server/music-agent/schema';
import type { TrackAssessment } from '../../src/server/music-agent/track-understanding';

describe('track compatibility eligibility', () => {
  it('rejects authoritative death metal wiki evidence for a calm request', () => {
    const decision = evaluateTrackCompatibility({
      context: context({ currentUserText: '来点安静舒缓的歌' }),
      assessment: assessment({
        genres: ['death metal'],
        confidence: { genres: 0.9 },
        evidence: [{ claim: 'genre=death metal', source: 'wiki_tag' }]
      })
    });

    expect(decision).toEqual({
      status: 'conflict',
      confidence: 'high',
      reasons: ['calm_constraint_conflicts_with_aggressive_genre:death metal']
    });
  });

  it('requires high-confidence energy and aggression together to reject a calm request', () => {
    const decision = evaluateTrackCompatibility({
      context: context({ activeDirective: '今天只放轻柔安静的音乐' }),
      assessment: assessment({
        energy: 'high',
        aggression: 'high',
        confidence: { energy: 0.84, aggression: 0.88 }
      })
    });

    expect(decision).toEqual({
      status: 'conflict',
      confidence: 'medium',
      reasons: [
        'calm_constraint_conflicts_with_high_energy',
        'calm_constraint_conflicts_with_high_aggression'
      ]
    });
  });

  it('keeps low-confidence and unknown semantic signals uncertain', () => {
    const lowConfidence = evaluateTrackCompatibility({
      context: context(),
      listeningConstraints: ['calm'],
      assessment: assessment({
        energy: 'high',
        aggression: 'high',
        confidence: { energy: 0.7, aggression: 0.79 }
      })
    });
    const unknown = evaluateTrackCompatibility({
      context: context(),
      listeningConstraints: ['calm'],
      assessment: assessment({ energy: 'unknown', aggression: 'unknown' })
    });

    expect(lowConfidence.status).toBe('uncertain');
    expect(lowConfidence.confidence).toBe('low');
    expect(unknown).toEqual({
      status: 'uncertain',
      confidence: 'low',
      reasons: ['insufficient_relevant_semantic_evidence']
    });
  });

  it('rejects high vocal intensity for instrumental listening unless evidence names an instrumental version', () => {
    const vocal = evaluateTrackCompatibility({
      context: context({
        personalDjContext: personalContext({ vocalPreference: 'instrumental' })
      }),
      assessment: assessment({
        vocalIntensity: 'high',
        confidence: { vocalIntensity: 0.92 }
      })
    });
    const instrumentalVersion = evaluateTrackCompatibility({
      context: context(),
      listeningConstraints: ['no vocals'],
      assessment: assessment({
        genres: ['ambient'],
        vocalIntensity: 'high',
        confidence: { genres: 0.9, vocalIntensity: 0.92 },
        evidence: [{ claim: 'instrumental version', source: 'platform_metadata' }]
      })
    });

    expect(vocal).toEqual({
      status: 'conflict',
      confidence: 'high',
      reasons: ['instrumental_constraint_conflicts_with_high_vocal_intensity']
    });
    expect(instrumentalVersion.status).not.toBe('conflict');
    expect(instrumentalVersion.reasons).toContain('instrumental_version_evidence_overrides_vocal_conflict');
  });
});

describe('candidate quality eligibility', () => {
  it('marks polluted network collections suspicious only with multiple independent negatives', () => {
    const decision = evaluateCandidateQuality(candidate({
      name: '2026抖音热歌合集｜车载DJ版｜无损串烧',
      artist: '网络歌手',
      qualitySignals: { popularity: 8, titlePollution: 'strong' }
    }), facts({ lyricStatus: 'missing', creditRoleCount: 0, albumName: null }));

    expect(decision.tier).toBe('suspicious');
    expect(decision.strongNegativeSignals).toEqual(expect.arrayContaining([
      'strong_title_pollution',
      'placeholder_or_collection_artist'
    ]));
    expect(decision.supportingNegativeSignals).toEqual(expect.arrayContaining([
      'very_low_popularity',
      'missing_album',
      'missing_lyrics_for_vocal_track'
    ]));
  });

  it('does not treat an unknown but legitimate indie track as suspicious', () => {
    const decision = evaluateCandidateQuality(candidate({
      name: 'Small Hours',
      artist: 'June Window',
      qualitySignals: { popularity: 6, titlePollution: 'none' }
    }), facts({ lyricStatus: 'unknown', creditRoleCount: 0, albumName: null }));

    expect(decision.tier).toBe('acceptable');
    expect(decision.strongNegativeSignals).toEqual([]);
  });

  it('does not reject instrumental tracks merely because lyrics and credits are missing', () => {
    const decision = evaluateCandidateQuality(candidate({
      name: 'Night Walk (Instrumental)',
      artist: 'Quiet Maps'
    }), facts({
      lyricStatus: 'missing',
      creditRoleCount: 0,
      wikiTags: ['instrumental'],
      albumName: 'Night Walk'
    }));

    expect(decision.tier).not.toBe('suspicious');
    expect(decision.supportingNegativeSignals).not.toContain('missing_lyrics_for_vocal_track');
    expect(decision.positiveSignals).toContain('instrumental_evidence');
  });

  it('does not reject a normal candidate for missing credits alone', () => {
    const decision = evaluateCandidateQuality(candidate({
      qualitySignals: { popularity: 55, copyright: 2, albumName: 'Real Album' }
    }), facts({ lyricStatus: 'available', creditRoleCount: 0, albumName: 'Real Album' }));

    expect(decision.tier).not.toBe('suspicious');
    expect(decision.supportingNegativeSignals).toContain('missing_credits');
  });

  it('records liked provenance as a positive quality signal', () => {
    const decision = evaluateCandidateQuality(candidate({
      sources: ['liked'],
      qualitySignals: { popularity: 60, copyright: 2, albumName: 'Real Album' }
    }), facts({
      lyricStatus: 'available',
      creditRoleCount: 2,
      wikiTags: ['dream pop'],
      albumName: 'Real Album'
    }));

    expect(decision.tier).toBe('trusted');
    expect(decision.positiveSignals).toContain('liked_source');
  });
});

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Ordinary Song',
    artist: 'Ordinary Artist',
    sources: ['search'],
    evidence: [],
    scores: {
      intentMatch: 0.8,
      tasteMatch: 0.7,
      timeFit: 0.6,
      contextFit: 0.8,
      novelty: 0.7,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.8
    },
    ...overrides
  };
}

function facts(overrides: Partial<CandidateQualityFacts> = {}): CandidateQualityFacts {
  return {
    lyricStatus: 'available',
    creditRoleCount: 1,
    wikiTags: [],
    albumName: 'Ordinary Album',
    ...overrides
  };
}

function context(overrides: Partial<MusicAgentContextSummary> = {}): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
    discoveryMode: 'explore',
    currentUserText: '',
    currentMoment: {
      localTime: '2026-07-10T18:00:00+08:00',
      daypart: 'evening',
      weather: null
    },
    activeDirective: '',
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}

function personalContext(
  musicGuidance: Partial<NonNullable<MusicAgentContextSummary['personalDjContext']>['musicGuidance']>
): NonNullable<MusicAgentContextSummary['personalDjContext']> {
  return {
    summary: '专注时偏好纯音乐',
    musicGuidance: {
      preferredTextures: [],
      avoidTextures: [],
      ...musicGuidance
    },
    musicHints: [],
    segueGuidance: {},
    trend: []
  };
}

function assessment(overrides: {
  genres?: string[];
  energy?: TrackAssessment['profile']['energy'];
  aggression?: TrackAssessment['profile']['aggression'];
  vocalIntensity?: TrackAssessment['profile']['vocalIntensity'];
  confidence?: Partial<TrackAssessment['confidence']>;
  evidence?: TrackAssessment['evidence'];
} = {}): TrackAssessment {
  return {
    id: 'track-1',
    profile: {
      genres: overrides.genres ?? [],
      moods: [],
      energy: overrides.energy ?? 'unknown',
      aggression: overrides.aggression ?? 'unknown',
      vocalIntensity: overrides.vocalIntensity ?? 'unknown',
      lyricThemes: [],
      language: 'unknown'
    },
    confidence: {
      genres: 0,
      moods: 0,
      energy: 0,
      aggression: 0,
      vocalIntensity: 0,
      lyricThemes: 0,
      language: 0,
      ...overrides.confidence
    },
    evidence: overrides.evidence ?? []
  };
}
