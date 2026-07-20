import type {
  CandidateScoreTableRow,
  MusicAgentRuntimeContext,
  MusicCandidate,
  MusicCandidateQualitySignals
} from './schema.js';
import { areMusicTrackDedupeKeysSimilar, buildMusicTrackDedupeKey } from './dedupe.js';
import { artistKeys } from './artists.js';
import { evaluatePlaybackEligibility } from './playback-eligibility.js';
import {
  candidateProvenanceLabels,
  cloneCandidateProvenance
} from './candidate-provenance.js';
import {
  candidateTitleMotifKeys as policyCandidateTitleMotifKeys,
  selectDiverseBatch
} from './selection-policy/batch.js';
import { evaluateRanking } from './selection-policy/ranking.js';
import {
  toSelectionPolicyCandidate,
  type SelectionExclusions,
  type SelectionPhaseDecision,
  type SelectionPolicyContext,
  type SelectionPolicyMode,
  type SelectionPressureContribution
} from './selection-policy/types.js';

const LOW_POPULARITY_THRESHOLD = 40;
const VERY_LOW_POPULARITY_THRESHOLD = 15;
const LOW_POPULARITY_PENALTY = 0.08;
const VERY_LOW_POPULARITY_PENALTY = 0.22;
const NO_COPYRIGHT_RECOMMENDATION_PENALTY = 0.28;
const MILD_TITLE_POLLUTION_PENALTY = 0.06;
const STRONG_TITLE_POLLUTION_PENALTY = 0.16;
const EXTERNAL_SOURCES = new Set(['search', 'style_expansion', 'trend']);
const TITLE_POLLUTION_TERMS = [
  'lofi',
  'chill',
  'study',
  'sleep',
  'playlist',
  'mix',
  'music',
  'bgm',
  '勉強',
  '集中',
  '睡眠',
  '作業用',
  '深夜',
  'ローファイ'
];
export type RankCandidatesOptions = {
  artistPenalties?: ReadonlyMap<string, number>;
  trackPenalties?: ReadonlyMap<string, number>;
  pressureForCandidate?: (candidate: MusicCandidate) => SelectionPressureContribution[];
  mode?: SelectionPolicyMode;
  explicitlyRequested?: boolean;
  explicitRequest?: SelectionExclusions;
  recordDecision?: (candidate: MusicCandidate, decision: SelectionPhaseDecision) => void;
};

export type DiversifyCandidatesOptions = {
  blockedTitleMotifs?: ReadonlySet<string>;
  recordDecision?: (candidate: MusicCandidate, decision: SelectionPhaseDecision) => void;
};

export function rankOptionsFromContext(
  context: Pick<MusicAgentRuntimeContext, 'request' | 'recentArtistPenalties' | 'recentTrackPenalties' | 'rankingTrackPenalties'>,
  overrides: Pick<RankCandidatesOptions, 'pressureForCandidate' | 'recordDecision'> & {
    selectionPolicyContext?: SelectionPolicyContext;
  } = {}
): RankCandidatesOptions {
  const trackPenalties = context.rankingTrackPenalties ?? context.recentTrackPenalties ?? [];
  const { selectionPolicyContext, ...rankOverrides } = overrides;
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty])),
    trackPenalties: new Map(trackPenalties.map((item) => [item.trackKey, item.penalty])),
    mode: selectionPolicyContext?.mode ?? 'autonomous',
    explicitlyRequested: selectionPolicyContext?.explicitlyRequested ?? false,
    ...(selectionPolicyContext?.explicitRequest
      ? { explicitRequest: selectionPolicyContext.explicitRequest }
      : {}),
    ...rankOverrides
  };
}

export function scoreCandidate(candidate: MusicCandidate): number {
  const { scores } = candidate;

  const score = (
    scores.intentMatch * 0.3 +
    scores.tasteMatch * 0.2 +
    scores.timeFit * 0.15 +
    scores.contextFit * 0.1 +
    scores.sourceConfidence * 0.1 +
    scores.novelty * 0.15
  );

  return Math.max(0, score);
}

export type CandidateScoreBreakdown = {
  baseScore: number;
  artistPenalty: number;
  trackPenalty: number;
  repeatPenalty: number;
  qualityPenalty: number;
  titlePollutionPenalty: number;
  adjustedScore: number;
  pressureContributions: SelectionPressureContribution[];
};

export function scoreCandidateForRanking(
  candidate: MusicCandidate,
  options: RankCandidatesOptions = {}
): CandidateScoreBreakdown {
  const baseScore = scoreCandidate(candidate);
  const artistPenalty = resolveArtistPenalty(candidate, options.artistPenalties);
  const trackPenalty = resolveTrackPenalty(candidate, options.trackPenalties);
  const repeatPenalty = 0;
  const qualityPenalty = qualitySignalPenalty(candidate);
  const titlePollutionPenalty = titlePollutionSignalPenalty(candidate);
  const pressureContributions: SelectionPressureContribution[] = [
    ...(artistPenalty > 0 ? [{
      source: 'exposure' as const,
      reasonCode: 'exposure_artist' as const,
      direction: 'penalty' as const,
      amount: artistPenalty
    }] : []),
    ...(trackPenalty > 0 ? [{
      source: 'exposure' as const,
      reasonCode: 'exposure_track' as const,
      direction: 'penalty' as const,
      amount: trackPenalty
    }] : []),
    ...(qualityPenalty > 0 ? [{
      source: 'candidate_quality' as const,
      reasonCode: 'candidate_quality' as const,
      direction: 'penalty' as const,
      amount: qualityPenalty
    }] : []),
    ...(titlePollutionPenalty > 0 ? [{
      source: 'candidate_quality' as const,
      reasonCode: 'candidate_quality' as const,
      direction: 'penalty' as const,
      amount: titlePollutionPenalty
    }] : []),
    ...(options.pressureForCandidate?.(candidate) ?? [])
  ];
  const decision = evaluateRanking({
    candidate: toSelectionPolicyCandidate(candidate),
    context: {
      mode: options.mode ?? 'autonomous',
      explicitlyRequested: options.explicitlyRequested ?? false,
      ...(options.explicitRequest ? { explicitRequest: options.explicitRequest } : {})
    },
    baseScore,
    pressure: pressureContributions
  });
  options.recordDecision?.(candidate, decision);
  return {
    baseScore,
    artistPenalty,
    trackPenalty,
    repeatPenalty,
    qualityPenalty,
    titlePollutionPenalty,
    adjustedScore: decision.adjustedScore,
    pressureContributions: decision.contributions
  };
}

export function rankCandidates(candidates: MusicCandidate[], limit: number, options: RankCandidatesOptions = {}): MusicCandidate[] {
  const target = Math.max(0, limit);
  return candidates
    .filter((candidate) => !isHardFilteredCandidate(candidate))
    .map((candidate, index) => ({ candidate, index, score: scoreCandidateForRanking(candidate, options).adjustedScore }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, target)
    .map(({ candidate }) => cloneCandidate(candidate));
}

export function buildCandidateScoreTableRows(
  candidates: MusicCandidate[],
  options: RankCandidatesOptions = {}
): CandidateScoreTableRow[] {
  return candidates.map((candidate, index) => {
    const breakdown = scoreCandidateForRanking(candidate, options);
    return {
      rank: index + 1,
      id: candidate.id,
      song: candidate.name,
      artist: candidate.artist,
      sources: candidate.sources.join(','),
      provenance: candidateProvenanceLabels(candidate).join(','),
      baseScore: roundScore(breakdown.baseScore),
      artistPenalty: roundScore(breakdown.artistPenalty),
      trackPenalty: roundScore(breakdown.trackPenalty),
      repeatPenalty: roundScore(breakdown.repeatPenalty),
      qualityPenalty: roundScore(breakdown.qualityPenalty),
      titlePollutionPenalty: roundScore(breakdown.titlePollutionPenalty),
      adjustedScore: roundScore(breakdown.adjustedScore)
    };
  });
}

export function diversifyCandidates(
  candidates: MusicCandidate[],
  limit: number,
  options: DiversifyCandidatesOptions = {}
): MusicCandidate[] {
  return selectDiverseBatch(
    candidates.filter((candidate) => !isHardFilteredCandidate(candidate)),
    limit,
    {
      blockedTitleMotifs: options.blockedTitleMotifs,
      recordDecision: options.recordDecision
    }
  );
}

export function candidateTitleMotifKeys(candidate: Pick<MusicCandidate, 'name'>): string[] {
  return policyCandidateTitleMotifKeys(candidate);
}

function cloneCandidate(candidate: MusicCandidate): MusicCandidate {
  return {
    ...candidate,
    sources: [...candidate.sources],
    ...(candidate.provenance ? { provenance: cloneCandidateProvenance(candidate.provenance) } : {}),
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores },
    ...(candidate.qualitySignals ? { qualitySignals: { ...candidate.qualitySignals } } : {})
  };
}

export function isHardFilteredCandidate(candidate: MusicCandidate): boolean {
  return !evaluatePlaybackEligibility(candidate).eligible;
}

export function resolveTitlePollution(candidate: MusicCandidate): NonNullable<MusicCandidateQualitySignals['titlePollution']> {
  return candidate.qualitySignals?.titlePollution ?? detectTitlePollution(candidate.name);
}

function qualitySignalPenalty(candidate: MusicCandidate): number {
  if (!usesExternalQuality(candidate)) return 0;
  const signals = candidate.qualitySignals;
  if (!signals) return 0;

  let penalty = 0;
  if (signals.popularity !== undefined) {
    if (signals.popularity < VERY_LOW_POPULARITY_THRESHOLD) penalty += VERY_LOW_POPULARITY_PENALTY;
    else if (signals.popularity < LOW_POPULARITY_THRESHOLD) penalty += LOW_POPULARITY_PENALTY;
  }
  if (signals.noCopyrightRcmd) penalty += NO_COPYRIGHT_RECOMMENDATION_PENALTY;
  return penalty;
}

function titlePollutionSignalPenalty(candidate: MusicCandidate): number {
  if (!usesExternalQuality(candidate)) return 0;
  const pollution = resolveTitlePollution(candidate);
  if (pollution === 'strong') return STRONG_TITLE_POLLUTION_PENALTY;
  if (pollution === 'mild') return MILD_TITLE_POLLUTION_PENALTY;
  return 0;
}

function usesExternalQuality(candidate: MusicCandidate): boolean {
  return candidate.sources.every((source) => EXTERNAL_SOURCES.has(source));
}

function resolveTrackPenalty(candidate: MusicCandidate, penalties: ReadonlyMap<string, number> | undefined): number {
  if (!penalties || penalties.size === 0) return 0;
  const dedupeKey = buildMusicTrackDedupeKey({ name: candidate.name, artist: candidate.artist });
  if (!dedupeKey) return 0;
  const exactPenalty = penalties.get(dedupeKey);
  if (exactPenalty !== undefined) return exactPenalty;

  let penalty = 0;
  for (const [penalizedKey, value] of penalties.entries()) {
    if (areMusicTrackDedupeKeysSimilar(dedupeKey, penalizedKey)) {
      penalty = Math.max(penalty, value);
    }
  }
  return penalty;
}

function resolveArtistPenalty(candidate: MusicCandidate, penalties: ReadonlyMap<string, number> | undefined): number {
  if (!penalties || penalties.size === 0) return 0;
  return Math.max(0, ...artistKeys(candidate.artist).map((artist) => penalties.get(artist) ?? 0));
}

function detectTitlePollution(title: string): NonNullable<MusicCandidateQualitySignals['titlePollution']> {
  const normalized = title.normalize('NFKC').toLowerCase();
  const compact = normalized.replace(/\s+/g, '');
  const termCount = TITLE_POLLUTION_TERMS.filter((term) => normalized.includes(term)).length;
  const separatorCount = (title.match(/[|｜×/・_-]/g) ?? []).length;

  if ((compact.length >= 42 && termCount >= 2) || (termCount >= 3 && separatorCount >= 2)) {
    return 'strong';
  }
  if ((compact.length >= 32 && termCount >= 1) || termCount >= 2 || separatorCount >= 4) {
    return 'mild';
  }
  return 'none';
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}
