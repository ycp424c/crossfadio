import type { Track } from '../agent/schema.js';

type LegacyCandidateExcludeState = {
  ids: Set<string>;
  dedupeKeys: Set<string>;
};

export type LegacyCandidateScoreRow = {
  rank: number;
  id: string;
  song: string;
  artist: string;
  sources: string;
  baseScore: number;
  artistPenalty: number;
  trackPenalty: number;
  repeatPenalty: number;
  qualityPenalty: number;
  titlePollutionPenalty: number;
  adjustedScore: number;
};

export type LegacyPhase3Debug = {
  likedSample: Array<{ id: string; name?: string; artist?: string }>;
  sqRaw: string;
  searchQueries: string[];
  searchedTracks: Array<{ id: string; name?: string; artist?: string }>;
  excludedIds: string[];
  excludedDedupeKeys: string[];
  totalCandidates: number;
  candidateScoreTable: LegacyCandidateScoreRow[];
};

export type LegacyCandidatePoolInput = {
  likedSample: Track[];
  searchedTracks: Track[];
  preferSearchCandidates: boolean;
  sqRawSay: string;
  searchQueries: string[];
  excludeState: LegacyCandidateExcludeState;
};

export type LegacyCandidatePool = {
  allCandidates: Track[];
  phase3Debug: LegacyPhase3Debug;
};

export function createLegacyCandidatePool(input: LegacyCandidatePoolInput): LegacyCandidatePool {
  const likedSampleIds = new Set(input.likedSample.map((track) => track.id));
  const searchedOnlyTracks = input.searchedTracks.filter((track) => !likedSampleIds.has(track.id));
  const allCandidates = input.preferSearchCandidates
    ? [...searchedOnlyTracks, ...input.likedSample]
    : [...input.likedSample, ...searchedOnlyTracks];

  return {
    allCandidates,
    phase3Debug: {
      likedSample: input.likedSample.map((track) => ({ id: track.id, name: track.name, artist: track.artist })),
      sqRaw: input.sqRawSay,
      searchQueries: input.searchQueries,
      searchedTracks: input.searchedTracks.map((track) => ({ id: track.id, name: track.name, artist: track.artist })),
      excludedIds: Array.from(input.excludeState.ids),
      excludedDedupeKeys: Array.from(input.excludeState.dedupeKeys),
      totalCandidates: allCandidates.length,
      candidateScoreTable: createLegacyCandidateScoreTable(allCandidates, likedSampleIds)
    }
  };
}

export function createLegacyCandidateScoreTable(
  candidates: Track[],
  likedSampleIds: Set<string>
): LegacyCandidateScoreRow[] {
  const denominator = Math.max(1, candidates.length - 1);
  return candidates.map((track, index) => {
    const rankScore = candidates.length === 1 ? 1 : 1 - (index / denominator);
    const score = Number(rankScore.toFixed(4));
    return {
      rank: index + 1,
      id: track.id,
      song: track.name ?? track.id,
      artist: track.artist ?? '未知艺人',
      sources: likedSampleIds.has(track.id) ? 'liked' : 'search',
      baseScore: score,
      artistPenalty: 0,
      trackPenalty: 0,
      repeatPenalty: 0,
      qualityPenalty: 0,
      titlePollutionPenalty: 0,
      adjustedScore: score
    };
  });
}
