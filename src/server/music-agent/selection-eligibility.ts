import type { MusicAgentContextSummary } from './schema.js';
import type { TrackAssessment } from './track-understanding.js';
export {
  evaluateCandidateQuality,
  type CandidateQualityDecision,
  type CandidateQualityFacts
} from './candidate-quality.js';

export type TrackCompatibilityDecision = {
  status: 'compatible' | 'uncertain' | 'conflict';
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
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
const CANONICAL_INSTRUMENTAL_EVIDENCE_PATTERN = /^(?:(?:genre|version|type)\s*[:=]\s*)?(?:instrumental(?: version)?|纯音乐|无人声|伴奏版|インストゥルメンタル)$/i;

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

function decisionConfidence(confidence: number): TrackCompatibilityDecision['confidence'] {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.8) return 'medium';
  return 'low';
}

function clean(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? '';
}
