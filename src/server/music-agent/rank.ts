import type {
  CandidateScoreTableRow,
  MusicAgentRuntimeContext,
  MusicCandidate,
  MusicCandidateQualitySignals
} from './schema.js';
import { areMusicTrackDedupeKeysSimilar, buildMusicTrackDedupeKey } from './dedupe.js';
import { artistKeys } from './artists.js';
import {
  candidateProvenanceLabels,
  cloneCandidateProvenance
} from './candidate-provenance.js';

const REPEATED_ARTIST_PENALTY = 0.16;
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
const TITLE_DIVERSITY_MOTIFS = [
  { key: 'afternoon', pattern: /(?:午後|午后|下午|\bafternoon\b|\bno\s+gogo\b)/i }
] as const;

export type RankCandidatesOptions = {
  artistPenalties?: ReadonlyMap<string, number>;
  trackPenalties?: ReadonlyMap<string, number>;
};

export type DiversifyCandidatesOptions = {
  blockedTitleMotifs?: ReadonlySet<string>;
};

export function rankOptionsFromContext(
  context: Pick<MusicAgentRuntimeContext, 'recentArtistPenalties' | 'recentTrackPenalties' | 'rankingTrackPenalties'>
): RankCandidatesOptions {
  const trackPenalties = context.rankingTrackPenalties ?? context.recentTrackPenalties ?? [];
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty])),
    trackPenalties: new Map(trackPenalties.map((item) => [item.trackKey, item.penalty]))
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
    scores.novelty * 0.15 -
    scores.recentPenalty -
    scores.skipPenalty
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
};

export function scoreCandidateForRanking(
  candidate: MusicCandidate,
  options: RankCandidatesOptions = {},
  repeatCount = 0
): CandidateScoreBreakdown {
  const baseScore = scoreCandidate(candidate);
  const artistPenalty = resolveArtistPenalty(candidate, options.artistPenalties);
  const trackPenalty = resolveTrackPenalty(candidate, options.trackPenalties);
  const repeatPenalty = repeatCount * REPEATED_ARTIST_PENALTY;
  const qualityPenalty = qualitySignalPenalty(candidate);
  const titlePollutionPenalty = titlePollutionSignalPenalty(candidate);
  return {
    baseScore,
    artistPenalty,
    trackPenalty,
    repeatPenalty,
    qualityPenalty,
    titlePollutionPenalty,
    adjustedScore: Math.max(0, baseScore - artistPenalty - trackPenalty - repeatPenalty - qualityPenalty - titlePollutionPenalty)
  };
}

export function rankCandidates(candidates: MusicCandidate[], limit: number, options: RankCandidatesOptions = {}): MusicCandidate[] {
  const target = Math.max(0, limit);
  const remaining = candidates.filter((candidate) => !isHardFilteredCandidate(candidate));
  const selected: MusicCandidate[] = [];
  const artistCounts = new Map<string, number>();

  while (selected.length < target && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = repeatedArtistAdjustedScore(remaining[0], artistCounts, options);

    for (let index = 1; index < remaining.length; index += 1) {
      const score = repeatedArtistAdjustedScore(remaining[index], artistCounts, options);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    selected.push(cloneCandidate(picked));
    incrementArtistCounts(artistCounts, picked);
  }

  return selected;
}

export function buildCandidateScoreTableRows(
  candidates: MusicCandidate[],
  options: RankCandidatesOptions = {}
): CandidateScoreTableRow[] {
  const artistCounts = new Map<string, number>();
  return candidates.map((candidate, index) => {
    const repeatCount = repeatedArtistCount(candidate, artistCounts);
    const breakdown = scoreCandidateForRanking(candidate, options, repeatCount);
    incrementArtistCounts(artistCounts, candidate);
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
  const sorted = candidates
    .filter((candidate) => !isHardFilteredCandidate(candidate));
  const selected: MusicCandidate[] = [];
  const usedArtists = new Set<string>();
  const usedTitleMotifs = new Set(options.blockedTitleMotifs ?? []);
  const target = Math.max(0, limit);

  for (const candidate of sorted) {
    if (selected.length >= target) {
      break;
    }

    const artists = artistKeys(candidate.artist);
    const titleMotifs = candidateTitleMotifKeys(candidate);

    if (artists.some((artist) => usedArtists.has(artist))) {
      continue;
    }

    if (titleMotifs.some((motif) => usedTitleMotifs.has(motif))) {
      continue;
    }

    selected.push(cloneCandidate(candidate));
    for (const artist of artists) {
      usedArtists.add(artist);
    }
    for (const motif of titleMotifs) {
      usedTitleMotifs.add(motif);
    }
  }

  return selected;
}

export function candidateTitleMotifKeys(candidate: Pick<MusicCandidate, 'name'>): string[] {
  const normalized = candidate.name.normalize('NFKC').toLowerCase();
  return TITLE_DIVERSITY_MOTIFS
    .filter((motif) => motif.pattern.test(normalized))
    .map((motif) => motif.key);
}

function repeatedArtistAdjustedScore(
  candidate: MusicCandidate,
  artistCounts: Map<string, number>,
  options: RankCandidatesOptions = {}
): number {
  const repeatCount = repeatedArtistCount(candidate, artistCounts);
  return scoreCandidateForRanking(candidate, options, repeatCount).adjustedScore;
}

function repeatedArtistCount(candidate: MusicCandidate, artistCounts: ReadonlyMap<string, number>): number {
  return Math.max(0, ...artistKeys(candidate.artist).map((artist) => artistCounts.get(artist) ?? 0));
}

function incrementArtistCounts(artistCounts: Map<string, number>, candidate: MusicCandidate): void {
  for (const artist of artistKeys(candidate.artist)) {
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
  }
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
  if (!usesExternalQuality(candidate)) return false;
  const signals = candidate.qualitySignals;
  if (signals?.privilegeSt !== undefined && signals.privilegeSt < 0) return true;
  if (signals?.privilegeToast === true) return true;
  return resolveTitlePollution(candidate) === 'strong'
    && signals?.popularity !== undefined
    && signals.popularity < VERY_LOW_POPULARITY_THRESHOLD;
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
