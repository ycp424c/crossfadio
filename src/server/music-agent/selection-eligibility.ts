import { resolveTitlePollution } from './rank.js';
import type { MusicAgentContextSummary, MusicCandidate } from './schema.js';
import type { TrackAssessment } from './track-understanding.js';

export type TrackCompatibilityDecision = {
  status: 'compatible' | 'uncertain' | 'conflict';
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
};

export type CandidateQualityFacts = {
  lyricStatus: 'available' | 'missing' | 'unknown';
  creditRoleCount: number;
  wikiTags: string[];
  albumName?: string | null;
};

export type CandidateQualityDecision = {
  tier: 'trusted' | 'acceptable' | 'suspicious';
  strongNegativeSignals: string[];
  supportingNegativeSignals: string[];
  positiveSignals: string[];
};

const AGGRESSIVE_GENRE_PATTERN = /\b(?:death metal|hardcore|grindcore|metalcore|deathcore)\b/i;
const CALM_CONSTRAINT_PATTERN = /(?:\bcalm\b|\bquiet\b|\bsoothing\b|\bgentle\b|\bsoft\b|\blow[- ]energy\b|安静|舒缓|轻柔|平静|放松|助眠|低能量|不吵|不要太吵)/i;
const INSTRUMENTAL_CONSTRAINT_PATTERN = /(?:\binstrumental\b|\bno vocals?\b|\bwithout vocals?\b|纯音乐|无人声|不要人声|无歌词)/i;
const INSTRUMENTAL_EVIDENCE_PATTERN = /(?:\binstrumental(?: version)?\b|\bno vocals?\b|纯音乐|无人声|伴奏版)/i;
const PLACEHOLDER_ARTIST_PATTERN = /^(?:unknown artist|unknown|various artists?|网络歌手|未知艺人|佚名|群星|群星合辑|v\.?\s*a\.?)$/i;
const GENERIC_IDENTITY_PATTERN = /^(?:unknown|untitled|track\s*\d*|song\s*\d*|音频\s*\d*|歌曲\s*\d*)$/i;
const SUSPICIOUS_TITLE_PATTERN = /(?:抖音热歌|网络热歌|车载(?:dj|音乐)?|(?:dj|舞曲)串烧|热歌合集|无损合集|karaoke|tribute|sped\s*up|slowed(?:\s*&\s*reverb)?)/i;

export function evaluateTrackCompatibility({
  context,
  assessment,
  listeningConstraints = []
}: {
  context: MusicAgentContextSummary;
  assessment: TrackAssessment;
  listeningConstraints?: string[];
}): TrackCompatibilityDecision {
  const constraints = collectConstraintText(context, listeningConstraints);
  const wantsCalm = CALM_CONSTRAINT_PATTERN.test(constraints);
  const wantsInstrumental = context.personalDjContext?.musicGuidance.vocalPreference === 'instrumental'
    || INSTRUMENTAL_CONSTRAINT_PATTERN.test(constraints);

  if (!wantsCalm && !wantsInstrumental) {
    return {
      status: 'compatible',
      confidence: 'high',
      reasons: ['no_restrictive_listening_constraint']
    };
  }

  const authoritativeGenre = assessment.profile.genres.find((genre) =>
    AGGRESSIVE_GENRE_PATTERN.test(genre)
    && assessment.confidence.genres >= 0.85
    && assessment.evidence.some((evidence) =>
      evidence.source === 'wiki_tag'
      && (evidence.claim.toLocaleLowerCase().includes(genre.toLocaleLowerCase())
        || AGGRESSIVE_GENRE_PATTERN.test(evidence.claim))
    )
  );
  if (wantsCalm && authoritativeGenre) {
    return {
      status: 'conflict',
      confidence: 'high',
      reasons: [`calm_constraint_conflicts_with_aggressive_genre:${authoritativeGenre.toLocaleLowerCase()}`]
    };
  }

  const conflictSignals: Array<{ reason: string; confidence: number }> = [];
  const positiveSignals: Array<{ reason: string; confidence: number }> = [];

  if (wantsCalm) {
    const aggressiveGenre = assessment.profile.genres.find((genre) => AGGRESSIVE_GENRE_PATTERN.test(genre));
    if (aggressiveGenre && assessment.confidence.genres >= 0.8) {
      conflictSignals.push({
        reason: `calm_constraint_conflicts_with_aggressive_genre:${aggressiveGenre.toLocaleLowerCase()}`,
        confidence: assessment.confidence.genres
      });
    }
    addLevelSignal(
      assessment.profile.energy,
      assessment.confidence.energy,
      'calm_constraint_conflicts_with_high_energy',
      'calm_constraint_supported_by_low_energy',
      conflictSignals,
      positiveSignals
    );
    addLevelSignal(
      assessment.profile.aggression,
      assessment.confidence.aggression,
      'calm_constraint_conflicts_with_high_aggression',
      'calm_constraint_supported_by_low_aggression',
      conflictSignals,
      positiveSignals
    );
  }

  if (wantsInstrumental) {
    const instrumentalEvidence = hasInstrumentalEvidence(assessment);
    if (instrumentalEvidence) {
      positiveSignals.push({
        reason: 'instrumental_version_evidence_overrides_vocal_conflict',
        confidence: Math.max(assessment.confidence.genres, assessment.confidence.vocalIntensity, 0.8)
      });
    } else if (
      assessment.profile.vocalIntensity === 'high'
      && assessment.confidence.vocalIntensity >= 0.8
    ) {
      conflictSignals.push({
        reason: 'instrumental_constraint_conflicts_with_high_vocal_intensity',
        confidence: assessment.confidence.vocalIntensity
      });
    } else if (
      assessment.profile.vocalIntensity === 'low'
      && assessment.confidence.vocalIntensity >= 0.8
    ) {
      positiveSignals.push({
        reason: 'instrumental_constraint_supported_by_low_vocal_intensity',
        confidence: assessment.confidence.vocalIntensity
      });
    }
  }

  const vocalConflict = conflictSignals.find((signal) =>
    signal.reason === 'instrumental_constraint_conflicts_with_high_vocal_intensity'
  );
  if (vocalConflict) {
    return {
      status: 'conflict',
      confidence: decisionConfidence(vocalConflict.confidence),
      reasons: [vocalConflict.reason]
    };
  }

  const calmConflictSignals = conflictSignals.filter((signal) => signal.reason.startsWith('calm_'));
  if (calmConflictSignals.length >= 2) {
    return {
      status: 'conflict',
      confidence: decisionConfidence(Math.min(...calmConflictSignals.map((signal) => signal.confidence))),
      reasons: calmConflictSignals.map((signal) => signal.reason)
    };
  }

  const requiredPositiveCount = Number(wantsCalm) + Number(wantsInstrumental);
  if (positiveSignals.length >= requiredPositiveCount) {
    return {
      status: 'compatible',
      confidence: decisionConfidence(Math.min(...positiveSignals.map((signal) => signal.confidence))),
      reasons: positiveSignals.map((signal) => signal.reason)
    };
  }

  return {
    status: 'uncertain',
    confidence: 'low',
    reasons: ['insufficient_relevant_semantic_evidence']
  };
}

export function evaluateCandidateQuality(
  candidate: MusicCandidate,
  facts: CandidateQualityFacts
): CandidateQualityDecision {
  const strongNegativeSignals: string[] = [];
  const supportingNegativeSignals: string[] = [];
  const positiveSignals: string[] = [];
  const quality = candidate.qualitySignals;
  const albumName = clean(facts.albumName) || clean(quality?.albumName);
  const instrumental = hasInstrumentalQualityEvidence(candidate, facts);

  if (quality?.privilegeSt !== undefined && quality.privilegeSt < 0) {
    strongNegativeSignals.push('unplayable_privilege');
  }
  if (quality?.privilegeToast === true) {
    strongNegativeSignals.push('unplayable_privilege_notice');
  }
  if (quality?.copyright === 0) {
    strongNegativeSignals.push('copyright_unavailable');
  }
  if (quality?.noCopyrightRcmd === true) {
    strongNegativeSignals.push('copyright_recommendation_blocked');
  }
  if (resolveTitlePollution(candidate) === 'strong') {
    strongNegativeSignals.push('strong_title_pollution');
  }
  if (PLACEHOLDER_ARTIST_PATTERN.test(clean(candidate.artist))) {
    strongNegativeSignals.push('placeholder_or_collection_artist');
  }
  if (hasMalformedIdentity(candidate)) {
    strongNegativeSignals.push('malformed_track_identity');
  }

  if (quality?.popularity !== undefined && quality.popularity < 15) {
    supportingNegativeSignals.push('very_low_popularity');
  }
  if (!albumName) {
    supportingNegativeSignals.push('missing_album');
  }
  if (SUSPICIOUS_TITLE_PATTERN.test(candidate.name)) {
    supportingNegativeSignals.push('suspicious_title_pattern');
  }
  if (facts.lyricStatus === 'missing' && !instrumental) {
    supportingNegativeSignals.push('missing_lyrics_for_vocal_track');
  }
  if (facts.creditRoleCount <= 0) {
    supportingNegativeSignals.push('missing_credits');
  }
  if (!quality || (quality.popularity === undefined && quality.copyright === undefined)) {
    supportingNegativeSignals.push('metadata_incomplete');
  }

  if (albumName) positiveSignals.push('normal_album');
  if (!PLACEHOLDER_ARTIST_PATTERN.test(clean(candidate.artist)) && !hasMalformedIdentity(candidate)) {
    positiveSignals.push('normal_artist');
  }
  if (quality?.copyright !== undefined && quality.copyright > 0) {
    positiveSignals.push('copyright_available');
  }
  if (quality?.popularity !== undefined && quality.popularity >= 15) {
    positiveSignals.push('established_popularity');
  }
  if (facts.creditRoleCount > 0) positiveSignals.push('credits_available');
  if (facts.wikiTags.length > 0) positiveSignals.push('wiki_evidence');
  if (facts.lyricStatus === 'available') positiveSignals.push('lyrics_available');
  if (candidate.sources.includes('liked')) positiveSignals.push('liked_source');
  if (instrumental) positiveSignals.push('instrumental_evidence');

  const hasUnplayableSignal = strongNegativeSignals.some((signal) =>
    signal === 'unplayable_privilege'
    || signal === 'unplayable_privilege_notice'
    || signal === 'copyright_unavailable'
  );
  const independentNegativeCount = strongNegativeSignals.length + supportingNegativeSignals.length;
  const tier = hasUnplayableSignal
    || (strongNegativeSignals.length > 0 && independentNegativeCount >= 2)
    ? 'suspicious'
    : supportingNegativeSignals.length === 0 && positiveSignals.length >= 3
      ? 'trusted'
      : 'acceptable';

  return {
    tier,
    strongNegativeSignals,
    supportingNegativeSignals,
    positiveSignals
  };
}

function collectConstraintText(
  context: MusicAgentContextSummary,
  listeningConstraints: string[]
): string {
  const personal = context.personalDjContext;
  return [
    ...listeningConstraints,
    context.activeDirective,
    context.currentUserText,
    personal?.summary,
    personal?.currentState?.mood,
    ...(personal?.musicGuidance.preferredTextures ?? []),
    ...(personal?.musicGuidance.avoidTextures ?? [])
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}

function addLevelSignal(
  level: TrackAssessment['profile']['energy'],
  confidence: number,
  conflictReason: string,
  positiveReason: string,
  conflictSignals: Array<{ reason: string; confidence: number }>,
  positiveSignals: Array<{ reason: string; confidence: number }>
): void {
  if (confidence < 0.8) return;
  if (level === 'high') conflictSignals.push({ reason: conflictReason, confidence });
  if (level === 'low') positiveSignals.push({ reason: positiveReason, confidence });
}

function hasInstrumentalEvidence(assessment: TrackAssessment): boolean {
  return assessment.profile.genres.some((genre) => INSTRUMENTAL_EVIDENCE_PATTERN.test(genre))
    || assessment.evidence.some((evidence) => INSTRUMENTAL_EVIDENCE_PATTERN.test(evidence.claim));
}

function hasInstrumentalQualityEvidence(
  candidate: MusicCandidate,
  facts: CandidateQualityFacts
): boolean {
  return INSTRUMENTAL_EVIDENCE_PATTERN.test(candidate.name)
    || facts.wikiTags.some((tag) => INSTRUMENTAL_EVIDENCE_PATTERN.test(tag));
}

function hasMalformedIdentity(candidate: MusicCandidate): boolean {
  const name = clean(candidate.name);
  const artist = clean(candidate.artist);
  if (!name || !artist || name.length > 180 || artist.length > 180) return true;
  if (GENERIC_IDENTITY_PATTERN.test(name) || GENERIC_IDENTITY_PATTERN.test(artist)) return true;
  if (!/[\p{L}\p{N}]/u.test(name) || !/[\p{L}\p{N}]/u.test(artist)) return true;
  return name.toLocaleLowerCase() === artist.toLocaleLowerCase();
}

function decisionConfidence(confidence: number): TrackCompatibilityDecision['confidence'] {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.8) return 'medium';
  return 'low';
}

function clean(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? '';
}
