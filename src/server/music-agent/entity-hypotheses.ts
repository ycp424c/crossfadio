import type { MusicEntityRecord as StoredMusicEntityRecord } from '../store/music-entities.js';
import { artistKeys, primaryArtistKey } from './artists.js';
import { normalizeMusicTrackToken } from './dedupe.js';
import type { NcmTrackLike } from './liked-recall.js';
import {
  musicEntityHintSchema,
  type MusicEntityHint
} from './schema.js';

const WEB_HINT_MIN_CONFIDENCE = 0.45;

export type NcmAlbumLike = {
  id: number | string;
  name: string;
  artist?: string | null;
};

export type MusicEntityType = 'track' | 'artist' | 'album' | 'playlist';

export type MusicEntityHypothesis = {
  type: MusicEntityType;
  title?: string;
  name?: string;
  artist?: string;
  id?: string;
  providerId?: string;
  query?: string;
};

export function parseEntityHypotheses(input: Record<string, unknown>): MusicEntityHypothesis[] {
  return [
    ...objectArrayValue(input.entities).map(parseEntityHypothesis),
    ...objectArrayValue(input.tracks).map((item) => parseEntityHypothesis({ ...item, type: 'track' })),
    ...objectArrayValue(input.artists).map((item) => parseEntityHypothesis({ ...item, type: 'artist' })),
    ...objectArrayValue(input.albums).map((item) => parseEntityHypothesis({ ...item, type: 'album' })),
    ...objectArrayValue(input.playlists).map((item) => parseEntityHypothesis({ ...item, type: 'playlist' }))
  ].filter((entity): entity is MusicEntityHypothesis => Boolean(entity));
}

export function parseEntityRecallInput(input: Record<string, unknown>): {
  entities: MusicEntityHypothesis[];
  problems: string[];
} {
  const hintResult = parseEntityHypothesesFromHints(input.hints);
  return {
    entities: [
      ...parseEntityHypotheses(input),
      ...hintResult.entities
    ],
    problems: hintResult.problems
  };
}

export function parseEntityHypothesesFromHints(value: unknown): {
  entities: MusicEntityHypothesis[];
  problems: string[];
} {
  const entities: MusicEntityHypothesis[] = [];
  const problems: string[] = [];
  for (const rawHint of objectArrayValue(value)) {
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      problems.push('web hint skipped: invalid sourced hint');
      continue;
    }
    const hint = parsed.data;
    if (hint.confidence < WEB_HINT_MIN_CONFIDENCE) {
      problems.push(`web hint skipped: low confidence for ${hint.name}`);
      continue;
    }
    const entity = entityFromMusicEntityHint(hint);
    if (entity) {
      entities.push(entity);
      continue;
    }
    if (hint.kind === 'track' || hint.kind === 'chart_item') {
      problems.push(`web track hint skipped: missing artist for ${hint.name}`);
    } else if (hint.kind === 'relationship') {
      problems.push(`web relationship hint skipped: ${hint.name}`);
    } else {
      problems.push(`web hint skipped: unsupported ${hint.kind} ${hint.name}`);
    }
  }
  return { entities, problems };
}

export function entityFromMusicEntityHint(hint: MusicEntityHint): MusicEntityHypothesis | null {
  if (hint.kind === 'track' || hint.kind === 'chart_item') {
    if (!hint.artist) return null;
    return { type: 'track', title: hint.name, artist: hint.artist };
  }
  if (hint.kind === 'artist') {
    return { type: 'artist', name: hint.name };
  }
  if (hint.kind === 'album') {
    return {
      type: 'album',
      title: hint.name,
      ...(hint.artist ? { artist: hint.artist } : {})
    };
  }
  if (hint.kind === 'playlist') {
    return { type: 'playlist', name: hint.name };
  }
  if (hint.kind === 'relationship' && hint.relatedName) {
    return { type: 'artist', name: hint.relatedName };
  }
  return null;
}

export function parseEntityHypothesis(input: Record<string, unknown>): MusicEntityHypothesis | null {
  const type = parseEntityType(stringValue(input.type));
  if (!type) return null;
  const title = stringValue(input.title);
  const name = stringValue(input.name);
  const artist = stringValue(input.artist);
  const id = stringValue(input.id);
  const providerId = stringValue(input.providerId);
  const query = stringValue(input.query);
  return {
    type,
    ...(title ? { title } : {}),
    ...(name ? { name } : {}),
    ...(artist ? { artist } : {}),
    ...(id ? { id } : {}),
    ...(providerId ? { providerId } : {}),
    ...(query ? { query } : {})
  };
}

export function parseEntityType(value: string): MusicEntityType | null {
  const normalized = value.toLowerCase();
  if (normalized === 'track' || normalized === 'song') return 'track';
  if (normalized === 'artist' || normalized === 'singer') return 'artist';
  if (normalized === 'album') return 'album';
  if (normalized === 'playlist') return 'playlist';
  return null;
}

export function entityTitle(entity: MusicEntityHypothesis): string {
  return entity.title ?? entity.name ?? '';
}

export function entityArtistName(entity: MusicEntityHypothesis): string {
  return entity.name ?? entity.artist ?? entity.title ?? '';
}

export function entityId(entity: MusicEntityHypothesis): string {
  return entity.providerId ?? entity.id ?? '';
}

export function entityLabel(entity: MusicEntityHypothesis): string {
  const title = entityTitle(entity) || entity.query || entityArtistName(entity) || entity.type;
  return entity.artist ? `${title} - ${entity.artist}` : title;
}

export function isVerifiedTrackEntity(entity: MusicEntityHypothesis, track: NcmTrackLike): boolean {
  const title = entityTitle(entity);
  if (!title || !track.name || !tokenMatches(title, track.name)) return false;
  return !entity.artist || trackMatchesArtist(track, entity.artist);
}

export function trackMatchesKnownEntityFields(entity: MusicEntityHypothesis, track: NcmTrackLike): boolean {
  const title = entityTitle(entity);
  if (title && (!track.name || !tokenMatches(title, track.name))) return false;
  return !entity.artist || trackMatchesArtist(track, entity.artist);
}

export function findVerifiedAlbum(entity: MusicEntityHypothesis, albums: NcmAlbumLike[]): NcmAlbumLike | null {
  return albums.find((album) => albumMatchesEntity(entity, album)) ?? null;
}

export function albumMatchesEntity(entity: MusicEntityHypothesis, album: NcmAlbumLike): boolean {
  const title = entityTitle(entity);
  if (!title || !album.name || !tokenMatches(title, album.name)) return false;
  return !entity.artist || tokenMatches(entity.artist, album.artist ?? '');
}

export function albumMatchesKnownEntityFields(entity: MusicEntityHypothesis, album: NcmAlbumLike): boolean {
  const title = entityTitle(entity);
  if (title && (!album.name || !tokenMatches(title, album.name))) return false;
  return !entity.artist || tokenMatches(entity.artist, album.artist ?? '');
}

export function trackMatchesArtist(track: NcmTrackLike, artist: string): boolean {
  const expectedArtist = primaryArtistKey(artist);
  if (!expectedArtist) return false;
  return (track.artists ?? []).some((candidate) => {
    const candidateArtists = artistKeys(candidate);
    return candidateArtists.some((actual) => tokenMatches(expectedArtist, actual));
  });
}

export function tokenMatches(expected: string, actual: string): boolean {
  const left = normalizeMusicTrackToken(expected);
  const right = normalizeMusicTrackToken(actual);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 4 && longer.includes(shorter);
}

export function entityFromStoredRecord(entity: StoredMusicEntityRecord): MusicEntityHypothesis | null {
  if (entity.type === 'chart_item') {
    return null;
  }
  if (entity.type === 'track') {
    return {
      type: 'track',
      ...(entity.title ? { title: entity.title } : {}),
      ...(entity.artist ? { artist: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  if (entity.type === 'artist') {
    return {
      type: 'artist',
      ...(entity.title ? { name: entity.title } : entity.artist ? { name: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  if (entity.type === 'album') {
    return {
      type: 'album',
      ...(entity.title ? { title: entity.title } : {}),
      ...(entity.artist ? { artist: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  return {
    type: 'playlist',
    ...(entity.title ? { name: entity.title } : {}),
    ...(entity.providerId ? { providerId: entity.providerId } : {})
  };
}

function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
