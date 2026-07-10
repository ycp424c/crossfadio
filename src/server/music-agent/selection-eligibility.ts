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

const AGGRESSIVE_GENRE_ALIASES = [
  { canonical: 'death metal', pattern: /(?:\bdeath\s*metal\b|死亡金属|デスメタル)/i },
  { canonical: 'deathcore', pattern: /(?:\bdeathcore\b|死核|デスコア)/i },
  { canonical: 'grindcore', pattern: /(?:\bgrindcore\b|碾核|グラインドコア)/i },
  { canonical: 'hardcore', pattern: /(?:\bhardcore\b|硬核|ハードコア)/i },
  { canonical: 'metalcore', pattern: /(?:\bmetalcore\b|金属核|メタルコア)/i }
] as const;
const CALM_CONSTRAINT_PATTERNS = [
  /\bcalm\b/i,
  /\bquiet\b/i,
  /\bsoothing\b/i,
  /\bgentle\b/i,
  /\bsoft\b/i,
  /\blow[- ]energy\b/i,
  /不要太吵|不吵/i,
  /安静|舒缓|轻柔|平静|放松|助眠|低能量/i
];
const INSTRUMENTAL_CONSTRAINT_PATTERNS = [
  /\bno vocals?\b/i,
  /\bwithout vocals?\b/i,
  /不要人声|无人声|无歌词/i,
  /\binstrumental\b/i,
  /纯音乐/i
];
const INSTRUMENTAL_EVIDENCE_PATTERN = /(?:\binstrumental(?: version)?\b|\bno vocals?\b|纯音乐|无人声|伴奏版)/i;
const CANONICAL_INSTRUMENTAL_EVIDENCE_PATTERN = /^(?:(?:genre|version|type)\s*[:=]\s*)?(?:instrumental(?: version)?|纯音乐|无人声|伴奏版|インストゥルメンタル)$/i;
const PLACEHOLDER_ARTIST_PATTERN = /^(?:unknown artist|unknown|various artists?|网络歌手|未知艺人|佚名|群星|群星合辑|v\.?\s*a\.?)$/i;
const GENERIC_IDENTITY_PATTERN = /^(?:unknown|untitled|track\s*\d*|song\s*\d*|音频\s*\d*|歌曲\s*\d*)$/i;
const SUSPICIOUS_TITLE_PATTERN = /(?:抖音热歌|网络热歌|车载(?:dj|音乐)?|(?:dj|舞曲)串烧|热歌合集|无损合集|karaoke|tribute|sped\s*up|slowed(?:\s*&\s*reverb)?)/i;

export function evaluateTrackCompatibility({
  context,
  assessment,
  listeningConstraints
}: {
  context: MusicAgentContextSummary;
  assessment: TrackAssessment;
  listeningConstraints?: string[];
}): TrackCompatibilityDecision {
  const explicitConstraints = (listeningConstraints ?? [])
    .filter((constraint) => clean(constraint).length > 0);
  const usesExplicitConstraints = listeningConstraints !== undefined;
  const constraints = usesExplicitConstraints
    ? explicitConstraints.join(' ')
    : collectFallbackConstraintText(context);
  const wantsCalm = hasPositiveConstraint(constraints, CALM_CONSTRAINT_PATTERNS);
  const wantsInstrumental = (!usesExplicitConstraints
    && context.personalDjContext?.musicGuidance.vocalPreference === 'instrumental')
    || hasPositiveConstraint(constraints, INSTRUMENTAL_CONSTRAINT_PATTERNS);

  if (!wantsCalm && !wantsInstrumental) {
    return {
      status: 'compatible',
      confidence: 'high',
      reasons: ['no_restrictive_listening_constraint']
    };
  }

  const aggressiveGenres = canonicalAggressiveGenres(assessment.profile.genres);
  const authoritativeGenres = assessment.confidence.genres >= 0.85
    ? intersectSortedGenres(
        aggressiveGenres,
        canonicalAggressiveGenres(assessment.evidence
          .filter((evidence) => evidence.source === 'wiki_tag')
          .map((evidence) => evidence.claim))
      )
    : [];
  if (wantsCalm && authoritativeGenres.length > 0) {
    return {
      status: 'conflict',
      confidence: 'high',
      reasons: authoritativeGenres.map((genre) =>
        `calm_constraint_conflicts_with_aggressive_genre:${genre}`
      )
    };
  }

  const conflictSignals: Array<{ reason: string; confidence: number }> = [];
  const calmPositiveSignals: Array<{ reason: string; confidence: number }> = [];
  const instrumentalPositiveSignals: Array<{ reason: string; confidence: number }> = [];

  if (wantsCalm) {
    if (aggressiveGenres.length > 0 && assessment.confidence.genres >= 0.8) {
      conflictSignals.push({
        reason: `calm_constraint_conflicts_with_aggressive_genre:${aggressiveGenres[0]}`,
        confidence: assessment.confidence.genres
      });
    }
    addLevelSignal(
      assessment.profile.energy,
      assessment.confidence.energy,
      'calm_constraint_conflicts_with_high_energy',
      'calm_constraint_supported_by_low_energy',
      conflictSignals,
      calmPositiveSignals
    );
    addLevelSignal(
      assessment.profile.aggression,
      assessment.confidence.aggression,
      'calm_constraint_conflicts_with_high_aggression',
      'calm_constraint_supported_by_low_aggression',
      conflictSignals,
      calmPositiveSignals
    );
  }

  if (wantsInstrumental) {
    const instrumentalEvidenceConfidence = getInstrumentalEvidenceConfidence(assessment);
    if (instrumentalEvidenceConfidence !== null) {
      instrumentalPositiveSignals.push({
        reason: 'instrumental_version_evidence_overrides_vocal_conflict',
        confidence: instrumentalEvidenceConfidence
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
      instrumentalPositiveSignals.push({
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

  const calmSupported = !wantsCalm || calmPositiveSignals.length > 0;
  const instrumentalSupported = !wantsInstrumental || instrumentalPositiveSignals.length > 0;
  if (calmSupported && instrumentalSupported) {
    const positiveSignals = [...calmPositiveSignals, ...instrumentalPositiveSignals];
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
  const strongNegativeCategories = new Set<string>();
  const negativeCategories = new Set<string>();
  const quality = candidate.qualitySignals;
  const albumName = clean(facts.albumName) || clean(quality?.albumName);
  const instrumental = hasInstrumentalQualityEvidence(candidate, facts);
  const addStrongNegative = (signal: string, category: string): void => {
    strongNegativeSignals.push(signal);
    strongNegativeCategories.add(category);
    negativeCategories.add(category);
  };
  const addSupportingNegative = (signal: string, category: string): void => {
    supportingNegativeSignals.push(signal);
    negativeCategories.add(category);
  };

  if (quality?.privilegeSt !== undefined && quality.privilegeSt < 0) {
    addStrongNegative('unplayable_privilege', 'availability');
  }
  if (quality?.privilegeToast === true) {
    addStrongNegative('unplayable_privilege_notice', 'availability');
  }
  if (quality?.copyright === 0) {
    addStrongNegative('copyright_unavailable', 'availability');
  }
  if (quality?.noCopyrightRcmd === true) {
    addStrongNegative('copyright_recommendation_blocked', 'availability');
  }
  if (resolveTitlePollution(candidate) === 'strong') {
    addStrongNegative('strong_title_pollution', 'title');
  }
  if (PLACEHOLDER_ARTIST_PATTERN.test(clean(candidate.artist))) {
    addStrongNegative('placeholder_or_collection_artist', 'identity');
  }
  if (hasMalformedIdentity(candidate)) {
    addStrongNegative('malformed_track_identity', 'identity');
  }

  if (quality?.popularity !== undefined && quality.popularity < 15) {
    addSupportingNegative('very_low_popularity', 'popularity');
  }
  if (!albumName) {
    addSupportingNegative('missing_album', 'album');
  }
  if (SUSPICIOUS_TITLE_PATTERN.test(candidate.name)) {
    addSupportingNegative('suspicious_title_pattern', 'title');
  }
  if (facts.lyricStatus === 'missing' && !instrumental) {
    addSupportingNegative('missing_lyrics_for_vocal_track', 'lyrics');
  }
  if (facts.creditRoleCount <= 0) {
    addSupportingNegative('missing_credits', 'credits');
  }
  if (!quality || (quality.popularity === undefined && quality.copyright === undefined)) {
    addSupportingNegative('metadata_incomplete', 'metadata');
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
  const independentNegativeCount = negativeCategories.size;
  const tier = hasUnplayableSignal
    || (strongNegativeCategories.size > 0 && independentNegativeCount >= 2)
    ? 'suspicious'
    : strongNegativeCategories.size === 0
      && supportingNegativeSignals.length === 0
      && positiveSignals.length >= 3
      ? 'trusted'
      : 'acceptable';

  return {
    tier,
    strongNegativeSignals,
    supportingNegativeSignals,
    positiveSignals
  };
}

function collectFallbackConstraintText(context: MusicAgentContextSummary): string {
  const personal = context.personalDjContext;
  return [
    context.activeDirective,
    context.currentUserText,
    ...(personal?.musicGuidance.preferredTextures ?? [])
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}

function hasPositiveConstraint(text: string, patterns: RegExp[]): boolean {
  const clauses = text.split(/[,，;；.!！？]|\b(?:but|instead|rather)\b|(?:但是|而是)/iu);
  return clauses.some((clause) => patterns.some((pattern) =>
    constraintMatches(clause, pattern).some((match) => !hasPrecedingNegation(clause, match.index))
  ));
}

function constraintMatches(text: string, pattern: RegExp): Array<{ index: number }> {
  const flags = Array.from(new Set(`${pattern.flags}g`.split(''))).join('');
  const matcher = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(matcher), (match) => ({ index: match.index }));
}

function hasPrecedingNegation(clause: string, matchIndex: number): boolean {
  const prefix = clause.slice(Math.max(0, matchIndex - 48), matchIndex);
  return /(?:不想(?:听)?|不喜欢|不是|不要|别|避免|排除)[^,，;；.!！？]{0,24}$/u.test(prefix)
    || /(?:\b(?:do\s+not|never|dislike|not\s+want|not|no|without|avoid|exclude)\b|\bdon['’]t\b)[^,;.!?]{0,40}$/iu.test(prefix);
}

function canonicalAggressiveGenres(values: string[]): string[] {
  const genres = new Set<string>();
  for (const value of values) {
    for (const alias of AGGRESSIVE_GENRE_ALIASES) {
      if (alias.pattern.test(clean(value))) genres.add(alias.canonical);
    }
  }
  return [...genres].sort((left, right) => left.localeCompare(right, 'en'));
}

function intersectSortedGenres(left: string[], right: string[]): string[] {
  const rightGenres = new Set(right);
  return left.filter((genre) => rightGenres.has(genre));
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

function getInstrumentalEvidenceConfidence(assessment: TrackAssessment): number | null {
  if (assessment.confidence.genres < 0.8) return null;
  const hasCanonicalGenre = assessment.profile.genres.some((genre) =>
    CANONICAL_INSTRUMENTAL_EVIDENCE_PATTERN.test(clean(genre))
  );
  const hasCanonicalEvidence = assessment.evidence.some((evidence) =>
    CANONICAL_INSTRUMENTAL_EVIDENCE_PATTERN.test(clean(evidence.claim))
  );
  return hasCanonicalGenre || hasCanonicalEvidence ? assessment.confidence.genres : null;
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
