import type { NcmClient } from '../ncm/client.js';
import type { CandidatePool } from './candidates.js';
import {
  rejectedPoolRecallProblems,
  sourceScores,
  upsertTracks,
  type UpsertTracksResult
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
  CandidateSource,
  MusicAgentContextSummary
} from './schema.js';
import type { NcmTrackLike } from './liked-recall.js';
import type { NcmPlaylistSearchResult } from '../../shared/schema.js';
import type { RetrievalRequestKind } from '../store/retrieval-attempts.js';
import {
  buildSourceReservoirIdentity,
  isSourceReservoirFetchAvailable,
  recordSourceReservoirFetch
} from '../store/source-reservoir.js';

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
  source?: CandidateSource;
  provenanceKind?: CandidateProvenanceKind;
  sourceReservoir?: {
    userId: string;
    runId: string;
    requestKind: RetrievalRequestKind;
    now?: Date;
  };
  signal?: AbortSignal;
};

export type EntityRecallResult = {
  added: number;
  problems: string[];
  fetchedSourceCount?: number;
};

const EXPANDED_TRACK_VARIANT_PATTERN = /翻唱|cover|tribute|karaoke|instrumental|伴奏|ktv|铃声|原唱|男声版|女声版|sped\s*up|slow\s*&\s*reverb|slowed|acapella|a cappella/i;
const COLLECTION_TITLE_VARIANT_PATTERN = /翻唱|cover|tribute|karaoke|instrumental|伴奏|ktv|铃声|睡眠|白噪音|asmr|sped\s*up|slow\s*&\s*reverb|acapella|a cappella/i;
const MALE_VOCAL_QUERY_PATTERN = /男声|男歌手|男生唱|\bmale(?:[\s-]*(?:vocal|vocals|singer|artist))?\b/i;
const FEMALE_VOCAL_QUERY_PATTERN = /女声|女歌手|女生唱|\bfemale(?:[\s-]*(?:vocal|vocals|singer|artist))?\b/i;
const ARTIST_TOP_SONG_RANDOM_WINDOW = 12;
const ARTIST_TOP_SONG_RANDOMIZE_MIN_TRACKS = 3;

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
    const reservoirIdentity = buildSourceReservoirIdentity({
      sourceKind: 'search',
      sourceRef: `track:${explicitId}`
    });
    if (sourceInsideReservoirWindow(options, reservoirIdentity)) {
      return {
        added: 0,
        problems: [`track source ${explicitId} is still inside the 120-minute reservoir window`]
      };
    }
    const tracks = await options.ncmClient.getSongDetails([explicitId]);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    const verifiedTracks = tracks.filter((track) => trackMatchesKnownEntityFields(options.entity, track));
    const source = entityRecallSource(options, 'search');
    const reservoirProblem = recordEntitySource(
      options,
      reservoirIdentity,
      entityLabel(options.entity),
      source,
      verifiedTracks
    );
    if (verifiedTracks.length === 0) {
      return {
        added: 0,
        problems: [
          `track entity rejected: ${entityLabel(options.entity)}`,
          ...(reservoirProblem ? [reservoirProblem] : [])
        ],
        ...fetchedSourceCountProperty(options, reservoirProblem)
      };
    }
    const result = upsertTracks(options.candidatePool, verifiedTracks.slice(0, options.limit), source, {
      evidence: `实体曲目: ${entityLabel(options.entity)}`,
      scores: sourceScores(source, options.context),
      provenanceKind: options.provenanceKind
    });
    return {
      added: result.added,
      problems: [...entityRecallProblems(result), ...(reservoirProblem ? [reservoirProblem] : [])],
      ...fetchedSourceCountProperty(options, reservoirProblem)
    };
  }

  const title = entityTitle(options.entity);
  if (!title) {
    return { added: 0, problems: ['track entity skipped: missing title'] };
  }
  const query = uniqueStrings([title, options.entity.artist ?? '']).join(' ');
  const reservoirIdentity = buildSourceReservoirIdentity({ sourceKind: 'search', sourceRef: query });
  if (sourceInsideReservoirWindow(options, reservoirIdentity)) {
    return {
      added: 0,
      problems: [`search source ${query} is still inside the 120-minute reservoir window`]
    };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }
  const tracks = await options.ncmClient.searchSongs(query, options.limit);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };

  const verifiedTracks = tracks.filter((track) => isVerifiedTrackEntity(options.entity, track));
  const source = entityRecallSource(options, 'search');
  const reservoirProblem = recordEntitySource(
    options,
    reservoirIdentity,
    entityLabel(options.entity),
    source,
    verifiedTracks
  );
  if (verifiedTracks.length === 0) {
    return {
      added: 0,
      problems: [
        `track entity rejected: ${entityLabel(options.entity)}`,
        ...(reservoirProblem ? [reservoirProblem] : [])
      ],
      ...fetchedSourceCountProperty(options, reservoirProblem)
    };
  }

  const result = upsertTracks(options.candidatePool, verifiedTracks, source, {
    evidence: `实体曲目: ${entityLabel(options.entity)}`,
    scores: sourceScores(source, options.context),
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: [...entityRecallProblems(result), ...(reservoirProblem ? [reservoirProblem] : [])],
    ...fetchedSourceCountProperty(options, reservoirProblem)
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
  const reservoirIdentity = buildSourceReservoirIdentity({ sourceKind: 'artist', sourceRef: artistId });
  if (sourceInsideReservoirWindow(options, reservoirIdentity)) {
    return {
      added: 0,
      problems: [`artist source ${artistId} is still inside the 120-minute reservoir window`]
    };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const tracks = await options.ncmClient.getArtistTopSongs(artistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const eligibleTracks = tracks
    .filter((track) => !artistName || trackMatchesArtist(track, artistName))
    .filter(isUsableExpandedTrack);
  const verifiedTracks = sampleArtistTopSongs(eligibleTracks, options.limit);
  const source = entityRecallSource(options, 'search');
  const result = upsertTracks(options.candidatePool, verifiedTracks, source, {
    evidence: `实体艺人: ${artistName}`,
    scores: sourceScores(source, options.context),
    provenanceKind: options.provenanceKind
  });
  const reservoirProblem = recordEntitySource(
    options,
    reservoirIdentity,
    artistName || artistId,
    source,
    eligibleTracks
  );
  return {
    added: result.added,
    problems: [
      ...(eligibleTracks.length === 0 ? [`artist entity rejected: ${artistName}`] : []),
      ...entityRecallProblems(result),
      ...(reservoirProblem ? [reservoirProblem] : [])
    ],
    ...fetchedSourceCountProperty(options, reservoirProblem)
  };
}

function sampleArtistTopSongs(tracks: NcmTrackLike[], limit: number): NcmTrackLike[] {
  if (tracks.length < ARTIST_TOP_SONG_RANDOMIZE_MIN_TRACKS) {
    return tracks.slice(0, limit);
  }
  const windowSize = Math.min(tracks.length, Math.max(limit, ARTIST_TOP_SONG_RANDOM_WINDOW));
  const shuffled = shuffleTracks(tracks.slice(0, windowSize));
  return shuffled.slice(0, limit);
}

function shuffleTracks(tracks: NcmTrackLike[]): NcmTrackLike[] {
  for (let index = tracks.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tracks[index], tracks[swapIndex]] = [tracks[swapIndex], tracks[index]];
  }
  return tracks;
}

async function recallAlbumEntity(options: EntityRecallOptions): Promise<EntityRecallResult> {
  const explicitId = entityId(options.entity);
  if (explicitId) {
    if (!options.ncmClient.getAlbumDetail) {
      return { added: 0, problems: ['album entity skipped: NCM album expansion unavailable'] };
    }
    const reservoirIdentity = buildSourceReservoirIdentity({ sourceKind: 'album', sourceRef: explicitId });
    if (sourceInsideReservoirWindow(options, reservoirIdentity)) {
      return {
        added: 0,
        problems: [`album source ${explicitId} is still inside the 120-minute reservoir window`]
      };
    }
    const detail = await options.ncmClient.getAlbumDetail(explicitId);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    const source = entityRecallSource(options, 'search');
    const detailAccepted = Boolean(detail && albumMatchesKnownEntityFields(options.entity, detail));
    const expandedTracks = detailAccepted
      ? detail!.tracks.filter(isUsableExpandedTrack)
      : [];
    const reservoirProblem = recordEntitySource(
      options,
      reservoirIdentity,
      detail?.name ?? entityLabel(options.entity),
      source,
      expandedTracks
    );
    if (!detailAccepted || !detail) {
      return {
        added: 0,
        problems: [
          `album entity rejected: ${entityLabel(options.entity)}`,
          ...(reservoirProblem ? [reservoirProblem] : [])
        ],
        ...fetchedSourceCountProperty(options, reservoirProblem)
      };
    }
    const tracks = expandedTracks.slice(0, options.limit);
    const result = upsertTracks(options.candidatePool, tracks, source, {
      evidence: `实体专辑: ${detail.name}`,
      scores: sourceScores(source, options.context),
      provenanceKind: options.provenanceKind
    });
    return {
      added: result.added,
      problems: [...entityRecallProblems(result), ...(reservoirProblem ? [reservoirProblem] : [])],
      ...fetchedSourceCountProperty(options, reservoirProblem)
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
  const album = findVerifiedAlbum(
    options.entity,
    albums.filter((item) => isUsableCollectionTitle(item.name))
  );
  if (!album) {
    return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
  }
  const reservoirIdentity = buildSourceReservoirIdentity({
    sourceKind: 'album',
    sourceRef: String(album.id)
  });
  if (sourceInsideReservoirWindow(options, reservoirIdentity)) {
    return {
      added: 0,
      problems: [`album source ${String(album.id)} is still inside the 120-minute reservoir window`]
    };
  }
  if (!options.consumeNcmSearch()) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const detail = await options.ncmClient.getAlbumDetail(String(album.id));
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const source = entityRecallSource(options, 'search');
  const detailAccepted = Boolean(detail && albumMatchesEntity(options.entity, detail));
  const expandedTracks = detailAccepted
    ? detail!.tracks.filter(isUsableExpandedTrack)
    : [];
  const reservoirProblem = recordEntitySource(
    options,
    reservoirIdentity,
    detail?.name ?? entityLabel(options.entity),
    source,
    expandedTracks
  );
  if (!detailAccepted || !detail) {
    return {
      added: 0,
      problems: [
        `album entity rejected: ${entityLabel(options.entity)}`,
        ...(reservoirProblem ? [reservoirProblem] : [])
      ],
      ...fetchedSourceCountProperty(options, reservoirProblem)
    };
  }

  const tracks = expandedTracks.slice(0, options.limit);
  const result = upsertTracks(options.candidatePool, tracks, source, {
    evidence: `实体专辑: ${detail.name}`,
    scores: sourceScores(source, options.context),
    provenanceKind: options.provenanceKind
  });
  return {
    added: result.added,
    problems: [...entityRecallProblems(result), ...(reservoirProblem ? [reservoirProblem] : [])],
    ...fetchedSourceCountProperty(options, reservoirProblem)
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
    const playlist = findVerifiedPlaylist(name, playlists ?? [], (candidate) => {
      if (!options.sourceReservoir) return true;
      return isSourceReservoirFetchAvailable({
        userId: options.sourceReservoir.userId,
        identity: buildSourceReservoirIdentity({
          sourceKind: 'playlist',
          sourceRef: String(candidate.id)
        }),
        requestKind: options.sourceReservoir.requestKind,
        now: options.sourceReservoir.now
      });
    });
    playlistId = String(playlist?.id ?? '');
  }
  if (!playlistId) {
    return { added: 0, problems: [`playlist entity rejected: ${name}`] };
  }
  const reservoirIdentity = buildSourceReservoirIdentity({
    sourceKind: 'playlist',
    sourceRef: playlistId
  });
  if (options.sourceReservoir && !isSourceReservoirFetchAvailable({
    userId: options.sourceReservoir.userId,
    identity: reservoirIdentity,
    requestKind: options.sourceReservoir.requestKind,
    now: options.sourceReservoir.now
  })) {
    return {
      added: 0,
      problems: [`playlist source ${playlistId} is still inside the 120-minute reservoir window`]
    };
  }
  if (!options.consumePlaylistFetch()) {
    return { added: 0, problems: ['playlist fetch budget exhausted'] };
  }

  const detail = await options.ncmClient.getPlaylistDetail(playlistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const source = entityRecallSource(options, 'playlist');
  if (!detail) {
    const reservoirProblem = recordEntitySource(
      options,
      reservoirIdentity,
      name || playlistId,
      source,
      []
    );
    return {
      added: 0,
      problems: [
        `playlist entity rejected: ${name}`,
        ...(reservoirProblem ? [reservoirProblem] : [])
      ],
      ...fetchedSourceCountProperty(options, reservoirProblem)
    };
  }

  if (name && !playlistTitleMatchesQuery(name, detail.name)) {
    const reservoirProblem = recordEntitySource(
      options,
      reservoirIdentity,
      detail.name,
      source,
      []
    );
    return {
      added: 0,
      problems: [
        `playlist entity rejected: ${name}`,
        ...(reservoirProblem ? [reservoirProblem] : [])
      ],
      ...fetchedSourceCountProperty(options, reservoirProblem)
    };
  }

  const expandedTracks = detail.tracks.filter(isUsableExpandedTrack);
  const tracks = expandedTracks.slice(0, options.limit);
  const result = upsertTracks(options.candidatePool, tracks, source, {
    evidence: `实体歌单: ${detail.name}`,
    scores: sourceScores(source, options.context),
    provenanceKind: options.provenanceKind
  });
  const reservoirProblem = recordEntitySource(
    options,
    reservoirIdentity,
    detail.name,
    source,
    expandedTracks
  );
  return {
    added: result.added,
    problems: [...entityRecallProblems(result), ...(reservoirProblem ? [reservoirProblem] : [])],
    ...fetchedSourceCountProperty(options, reservoirProblem)
  };
}

function sourceInsideReservoirWindow(
  options: EntityRecallOptions,
  identity: ReturnType<typeof buildSourceReservoirIdentity>
): boolean {
  return Boolean(options.sourceReservoir && !isSourceReservoirFetchAvailable({
    userId: options.sourceReservoir.userId,
    identity,
    requestKind: options.sourceReservoir.requestKind,
    now: options.sourceReservoir.now
  }));
}

function recordEntitySource(
  options: EntityRecallOptions,
  identity: ReturnType<typeof buildSourceReservoirIdentity>,
  displayName: string,
  candidateSource: CandidateSource,
  tracks: NcmTrackLike[]
): string | null {
  if (!options.sourceReservoir) return null;
  try {
    recordSourceReservoirFetch({
      userId: options.sourceReservoir.userId,
      runId: options.sourceReservoir.runId,
      identity,
      displayName,
      candidateSource,
      provenanceKind: options.provenanceKind ?? 'verified_entity',
      tracks,
      fetchedAt: options.sourceReservoir.now
    });
    return null;
  } catch (error) {
    return `source reservoir write failed: ${formatError(error)}`;
  }
}

function fetchedSourceCountProperty(
  options: EntityRecallOptions,
  reservoirProblem: string | null
): { fetchedSourceCount?: number } {
  return options.sourceReservoir
    ? { fetchedSourceCount: reservoirProblem ? 0 : 1 }
    : {};
}

function entityRecallProblems(result: UpsertTracksResult): string[] {
  return rejectedPoolRecallProblems(result);
}

function findVerifiedPlaylist(
  query: string,
  playlists: NcmPlaylistSearchResult[],
  accept: (playlist: NcmPlaylistSearchResult) => boolean = () => true
): NcmPlaylistSearchResult | null {
  return playlists.find((playlist) => (
    playlist.trackCount > 0 &&
    isUsableCollectionTitle(playlist.name) &&
    playlistTitleMatchesQuery(query, playlist.name) &&
    accept(playlist)
  )) ?? null;
}

function playlistTitleMatchesQuery(query: string, title: string): boolean {
  const required = playlistRequiredPatterns(query);
  if (required.length === 0) return true;
  return required.every((pattern) => pattern.test(title));
}

function playlistRequiredPatterns(query: string): RegExp[] {
  const normalized = query.toLowerCase();
  const patterns: RegExp[] = [];
  if (/粤语|港乐|广东歌|cantopop/.test(normalized)) patterns.push(/粤语|港乐|广东|cantopop/i);
  if (/华语|中文|国语|mandarin|c[-\s]*pop/.test(normalized)) patterns.push(/华语|中文|国语|mandarin|c[-\s]*pop/i);
  if (/city\s*pop|citypop|城市流行/.test(normalized)) patterns.push(/city\s*pop|citypop|城市流行/i);
  if (/indie\s*pop|独立流行/.test(normalized)) patterns.push(/indie\s*pop|独立流行/i);
  if (/dream\s*pop|梦幻流行/.test(normalized)) patterns.push(/dream\s*pop|梦幻流行/i);
  if (/synth[-\s]*pop|合成器/.test(normalized)) patterns.push(/synth[-\s]*pop|合成器/i);
  if (/rock|摇滚/.test(normalized)) patterns.push(/rock|摇滚/i);
  if (/j[-\s]*pop|日语|日系/.test(normalized)) patterns.push(/j[-\s]*pop|日语|日系/i);
  if (/k[-\s]*pop|韩语|韩系/.test(normalized)) patterns.push(/k[-\s]*pop|韩语|韩系/i);
  if (MALE_VOCAL_QUERY_PATTERN.test(normalized)) patterns.push(MALE_VOCAL_QUERY_PATTERN);
  if (FEMALE_VOCAL_QUERY_PATTERN.test(normalized)) patterns.push(FEMALE_VOCAL_QUERY_PATTERN);
  return patterns;
}

function isUsableCollectionTitle(title: string): boolean {
  return !COLLECTION_TITLE_VARIANT_PATTERN.test(title);
}

function isUsableExpandedTrack(track: { name?: string | null }): boolean {
  return !EXPANDED_TRACK_VARIANT_PATTERN.test(track.name ?? '');
}

function entityRecallSource(options: EntityRecallOptions, fallback: CandidateSource): CandidateSource {
  return options.source ?? fallback;
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
