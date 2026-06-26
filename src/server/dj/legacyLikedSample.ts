import type { Track } from '../agent/schema.js';

type LegacySongDetail = {
  id: string | number;
  name?: string;
  artists: string[];
};

export type LegacyLikedSampleInput = {
  allLikedIds: string[];
  excludeIds: Set<string>;
  excludeDedupeKeys: Set<string>;
  likedSampleSize: number;
  sampleIds: (ids: string[], target: number) => string[];
  fetchSongDetails: (ids: string[]) => Promise<LegacySongDetail[]>;
  buildTrackDedupeKey: (track: Track) => string;
  isTrackDedupeKeyExcluded: (dedupeKey: string, excludedDedupeKeys: Set<string>) => boolean;
};

export type LegacyLikedSample = {
  likedSample: Track[];
  candidateCount: number;
  likedSampleTarget: number;
};

export async function loadLegacyLikedSample(input: LegacyLikedSampleInput): Promise<LegacyLikedSample> {
  const candidateIds = input.allLikedIds.filter((id) => !input.excludeIds.has(id));
  const sampledIds = input.sampleIds(candidateIds, input.likedSampleSize);
  const sampledDetails = await input.fetchSongDetails(sampledIds);
  const likedSample: Track[] = sampledDetails
    .filter((track) => track.artists.length > 0)
    .map((track) => ({
      id: String(track.id),
      name: track.name,
      artist: track.artists.join(' / ') || undefined
    }))
    .filter((track) => !input.isTrackDedupeKeyExcluded(
      input.buildTrackDedupeKey(track),
      input.excludeDedupeKeys
    ));

  return {
    likedSample,
    candidateCount: candidateIds.length,
    likedSampleTarget: input.likedSampleSize
  };
}
