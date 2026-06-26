import type { NcmClient } from '../ncm/client.js';
import type { CandidatePool } from './candidates.js';
import {
  skippedRecallProblems,
  sourceScores,
  upsertTracks
} from './candidate-admission.js';
import {
  albumMatchesEntity,
  albumMatchesKnownEntityFields,
  entityArtistName,
  entityId,
  entityLabel,
  entityTitle,
  findVerifiedAlbum,
  isVerifiedTrackEntity,
  tokenMatches,
  trackMatchesArtist,
  trackMatchesKnownEntityFields,
  type MusicEntityHypothesis
} from './entity-hypotheses.js';
import type {
  CandidateProvenanceKind,
  MusicAgentContextSummary
} from './schema.js';

export type EntityRecallNcmClient = Pick<
  NcmClient,
  'getLikedSongIds' | 'getSongDetails' | 'searchSongs' | 'getPlaylistDetail'
> & Partial<Pick<
  NcmClient,
  'searchArtists'
  | 'getArtistTopSongs'
  | 'searchAlbums'
  | 'getArtistAlbums'
  | 'getAlbumDetail'
  | 'searchPlaylists'
>>;

export type EntityRecallOptions = {
  entity: MusicEntityHypothesis;
  ncmClient: EntityRecallNcmClient;
  candidatePool: CandidatePool;
  context: MusicAgentContextSummary;
  limit: number;
  searchLimit: number;
  consumeNcmSearch: () => boolean;
  consumePlaylistFetch: () => boolean;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  provenanceKind?: CandidateProvenanceKind;
  signal?: AbortSignal;
};

export type EntityRecallResult = {
  added: number;
  problems: string[];
};

export async function recallFromEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  try {
    if (options.entity.type === 'track') return recallTrackEntity(options);
    if (options.entity.type === 'artist') return recallArtistEntity(options);
    if (options.entity.type === 'album') return recallAlbumEntity(options);
    return recallPlaylistEntity(options);
  } catch (error) {
    return {
      added: 0,
      problems: [`${options.entity.type} entity ${entityLabel(options.entity)}: ${formatError(error)}`]
    };
  }
}

async function recallTrackEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  const explicitId = entityId(options.entity);
  if (explicitId) {
    const tracks = await options.ncmClient.getSongDetails([explicitId]);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    const verifiedTracks = tracks.filter((track) => trackMatchesKnownEntityFields(options.entity, track));
    if (verifiedTracks.length === 0) {
      return { added: 0, problems: [`track entity rejected: ${entityLabel(options.entity)}`] };
    }
    const result = upsertTracks(options.candidatePool, verifiedTracks.slice(0, options.limit), 'search', {
      evidence: `实体曲目: ${entityLabel(options.entity)}`,
      scores: sourceScores('search', options.context),
      avoidArtists: options.avoidArtists,
      artistCounts: options.artistCounts,
      provenanceKind: options.provenanceKind
    });
    return {
      added: result.added,
      problems: skippedRecallProblems(result)
    };
  }

  const title = entityTitle(options.entity);
  if (!title) {
    return { added: 0, problems: ['track entity skipped: missing title'] };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const query = uniqueStrings([title, options.entity.artist ?? '']).join(' ');
  const tracks = await options.ncmClient.searchSongs(query, options.limit);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };

  const verifiedTracks = tracks.filter((track) => isVerifiedTrackEntity(options.entity, track));
  if (verifiedTracks.length === 0) {
    return { added: 0, problems: [`track entity rejected: ${entityLabel(options.entity)}`] };
  }

  const result = upsertTracks(options.candidatePool, verifiedTracks, 'search', {
    evidence: `实体曲目: ${entityLabel(options.entity)}`,
    scores: sourceScores('search', options.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts,
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function recallArtistEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  const artistName = entityArtistName(options.entity);
  if (!artistName && !entityId(options.entity)) {
    return { added: 0, problems: ['artist entity skipped: missing name'] };
  }
  if (!options.ncmClient.getArtistTopSongs || (!entityId(options.entity) && !options.ncmClient.searchArtists)) {
    return { added: 0, problems: ['artist entity skipped: NCM artist expansion unavailable'] };
  }

  const artistId = await resolveArtistEntity(options);
  if (!artistId) {
    return { added: 0, problems: [`artist entity rejected: ${artistName}`] };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const tracks = await options.ncmClient.getArtistTopSongs(artistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const verifiedTracks = tracks
    .filter((track) => !artistName || trackMatchesArtist(track, artistName))
    .slice(0, options.limit);
  const result = upsertTracks(options.candidatePool, verifiedTracks, 'search', {
    evidence: `实体艺人: ${artistName}`,
    scores: sourceScores('search', options.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts,
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: [
      ...(verifiedTracks.length === 0 ? [`artist entity rejected: ${artistName}`] : []),
      ...skippedRecallProblems(result)
    ]
  };
}

async function recallAlbumEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  const explicitId = entityId(options.entity);
  if (explicitId) {
    if (!options.ncmClient.getAlbumDetail) {
      return { added: 0, problems: ['album entity skipped: NCM album expansion unavailable'] };
    }
    const detail = await options.ncmClient.getAlbumDetail(explicitId);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    if (!detail || !albumMatchesKnownEntityFields(options.entity, detail)) {
      return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
    }
    const result = upsertTracks(options.candidatePool, detail.tracks.slice(0, options.limit), 'search', {
      evidence: `实体专辑: ${detail.name}`,
      scores: sourceScores('search', options.context),
      avoidArtists: options.avoidArtists,
      artistCounts: options.artistCounts,
      provenanceKind: options.provenanceKind
    });
    return {
      added: result.added,
      problems: skippedRecallProblems(result)
    };
  }

  const title = entityTitle(options.entity);
  if (!title) {
    return { added: 0, problems: ['album entity skipped: missing title'] };
  }
  if (!options.ncmClient.searchAlbums || !options.ncmClient.getAlbumDetail) {
    return { added: 0, problems: ['album entity skipped: NCM album expansion unavailable'] };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const query = uniqueStrings([title, options.entity.artist ?? '']).join(' ');
  const albums = await options.ncmClient.searchAlbums(query, options.searchLimit);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const album = findVerifiedAlbum(options.entity, albums);
  if (!album) {
    return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const detail = await options.ncmClient.getAlbumDetail(String(album.id));
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  if (!detail || !albumMatchesEntity(options.entity, detail)) {
    return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
  }

  const result = upsertTracks(options.candidatePool, detail.tracks.slice(0, options.limit), 'search', {
    evidence: `实体专辑: ${detail.name}`,
    scores: sourceScores('search', options.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts,
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function recallPlaylistEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  const name = entityTitle(options.entity) || options.entity.query;
  const explicitId = entityId(options.entity);
  if (!name && !explicitId) {
    return { added: 0, problems: ['playlist entity skipped: missing name'] };
  }
  if (!explicitId && !options.ncmClient.searchPlaylists) {
    return { added: 0, problems: ['playlist entity skipped: NCM playlist search unavailable'] };
  }

  let playlistId = explicitId;
  if (!playlistId) {
    if (!name) {
      return { added: 0, problems: ['playlist entity skipped: missing name'] };
    }
    if (!options.consumeNcmSearch()) {
      return { added: 0, problems: ['NCM search budget exhausted'] };
    }
    const playlists = await options.ncmClient.searchPlaylists?.(name, options.searchLimit);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    playlistId = String(playlists?.[0]?.id ?? '');
  }
  if (!playlistId) {
    return { added: 0, problems: [`playlist entity rejected: ${name}`] };
  }
  if (!options.consumePlaylistFetch()) {
    return { added: 0, problems: ['playlist fetch budget exhausted'] };
  }

  const detail = await options.ncmClient.getPlaylistDetail(playlistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  if (!detail) {
    return { added: 0, problems: [`playlist entity rejected: ${name}`] };
  }

  const result = upsertTracks(options.candidatePool, detail.tracks.slice(0, options.limit), 'playlist', {
    evidence: `实体歌单: ${detail.name}`,
    scores: sourceScores('playlist', options.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts,
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function resolveArtistEntity(options: EntityRecallOptions): Promise<string | null> {
  const explicitId = entityId(options.entity);
  if (explicitId) return explicitId;
  const name = entityArtistName(options.entity);
  if (!name || !options.ncmClient.searchArtists) return null;
  if (!options.consumeNcmSearch()) return null;

  const artists = await options.ncmClient.searchArtists(name, options.searchLimit);
  if (options.signal?.aborted) return null;
  const verified = artists.find((artist) => tokenMatches(name, artist.name));
  return verified ? String(verified.id) : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
