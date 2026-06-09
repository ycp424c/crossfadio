import type { CandidateScoreTableRow, MusicCandidate } from './schema.js';

const REPEATED_ARTIST_PENALTY = 0.16;

export type RankCandidatesOptions = {
  artistPenalties?: ReadonlyMap<string, number>;
};

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase();
}

export function scoreCandidate(candidate: MusicCandidate): number {
  const { scores } = candidate;

  const score = (
    scores.intentMatch * 0.3 +
    scores.tasteMatch * 0.2 +
    scores.timeFit * 0.15 +
    scores.planFit * 0.1 +
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
  repeatPenalty: number;
  adjustedScore: number;
};

export function scoreCandidateForRanking(
  candidate: MusicCandidate,
  options: RankCandidatesOptions = {},
  repeatCount = 0
): CandidateScoreBreakdown {
  const artist = primaryArtist(candidate.artist);
  const baseScore = scoreCandidate(candidate);
  const artistPenalty = options.artistPenalties?.get(artist) ?? 0;
  const repeatPenalty = repeatCount * REPEATED_ARTIST_PENALTY;
  return {
    baseScore,
    artistPenalty,
    repeatPenalty,
    adjustedScore: Math.max(0, baseScore - artistPenalty - repeatPenalty)
  };
}

export function rankCandidates(candidates: MusicCandidate[], limit: number, options: RankCandidatesOptions = {}): MusicCandidate[] {
  const target = Math.max(0, limit);
  const remaining = [...candidates];
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
    selected.push({
      ...picked,
      sources: [...picked.sources],
      evidence: [...picked.evidence],
      scores: { ...picked.scores }
    });

    const artist = primaryArtist(picked.artist);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
  }

  return selected;
}

export function buildCandidateScoreTableRows(
  candidates: MusicCandidate[],
  options: RankCandidatesOptions = {}
): CandidateScoreTableRow[] {
  const artistCounts = new Map<string, number>();
  return candidates.map((candidate, index) => {
    const artist = primaryArtist(candidate.artist);
    const repeatCount = artistCounts.get(artist) ?? 0;
    const breakdown = scoreCandidateForRanking(candidate, options, repeatCount);
    artistCounts.set(artist, repeatCount + 1);
    return {
      rank: index + 1,
      id: candidate.id,
      song: candidate.name,
      artist: candidate.artist,
      sources: candidate.sources.join(','),
      baseScore: roundScore(breakdown.baseScore),
      artistPenalty: roundScore(breakdown.artistPenalty),
      repeatPenalty: roundScore(breakdown.repeatPenalty),
      adjustedScore: roundScore(breakdown.adjustedScore)
    };
  });
}

export function diversifyCandidates(candidates: MusicCandidate[], limit: number): MusicCandidate[] {
  const sorted = [...candidates].sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
  const selected: MusicCandidate[] = [];
  const usedArtists = new Set<string>();
  const target = Math.max(0, limit);

  for (const candidate of sorted) {
    if (selected.length >= target) {
      break;
    }

    const artist = primaryArtist(candidate.artist);

    if (usedArtists.has(artist)) {
      continue;
    }

    selected.push({
      ...candidate,
      sources: [...candidate.sources],
      evidence: [...candidate.evidence],
      scores: { ...candidate.scores }
    });
    usedArtists.add(artist);
  }

  return selected;
}

function repeatedArtistAdjustedScore(
  candidate: MusicCandidate,
  artistCounts: Map<string, number>,
  options: RankCandidatesOptions = {}
): number {
  const artist = primaryArtist(candidate.artist);
  const repeatCount = artistCounts.get(artist) ?? 0;
  return scoreCandidateForRanking(candidate, options, repeatCount).adjustedScore;
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}
