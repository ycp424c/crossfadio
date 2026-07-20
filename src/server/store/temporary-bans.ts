import { buildMusicTrackDedupeKey } from '../music-agent/dedupe.js';
import {
  MAX_ACTIVE_TEMPORARY_QUEUE_BANS,
  MAX_QUEUE_TRACK_ARTIST_LENGTH,
  MAX_QUEUE_TRACK_ARTISTS,
  MAX_QUEUE_TRACK_ID_LENGTH,
  MAX_QUEUE_TRACK_NAME_LENGTH,
  MAX_TEMPORARY_QUEUE_BANS_PER_MUTATION
} from '../../shared/queue.js';
import { deletePref, getPref, setPref } from './prefs.js';

const TEMPORARY_QUEUE_BANS_PREF_KEY = 'queue.temporaryBans';
export const TEMPORARY_QUEUE_BAN_TTL_MS = 24 * 60 * 60 * 1000;

export type TemporaryQueueBanTrackInput = {
  id: string;
  name?: string;
  artists?: string[];
};

export type TemporaryQueueBan = TemporaryQueueBanTrackInput & {
  dedupeKey?: string;
  expiresAt: string;
};

export type TemporaryQueueBanDedupeState = {
  ids: Set<string>;
  dedupeKeys: Set<string>;
  bans: TemporaryQueueBan[];
};

export function recordTemporaryQueueBans(
  userId: string,
  tracks: TemporaryQueueBanTrackInput[],
  now = new Date()
): TemporaryQueueBan[] {
  if (tracks.length > MAX_TEMPORARY_QUEUE_BANS_PER_MUTATION) {
    throw new RangeError('temporary queue bans exceed mutation limit');
  }
  const expiresAt = new Date(now.getTime() + TEMPORARY_QUEUE_BAN_TTL_MS).toISOString();
  const byId = new Map(getActiveTemporaryQueueBans(userId, now).map((ban) => [ban.id, ban]));

  for (const track of tracks) {
    const id = track.id.trim();
    if (!id) continue;
    if (id.length > MAX_QUEUE_TRACK_ID_LENGTH) throw new RangeError('temporary queue ban id exceeds limit');
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => artist.trim()).filter(Boolean)
      : [];
    if (artists.length > MAX_QUEUE_TRACK_ARTISTS
      || artists.some((artist) => artist.length > MAX_QUEUE_TRACK_ARTIST_LENGTH)) {
      throw new RangeError('temporary queue ban artists exceed limit');
    }
    const name = track.name?.trim();
    if (name && name.length > MAX_QUEUE_TRACK_NAME_LENGTH) {
      throw new RangeError('temporary queue ban name exceeds limit');
    }
    const dedupeKey = buildMusicTrackDedupeKey({ name, artists });
    byId.set(id, {
      id,
      ...(name ? { name } : {}),
      ...(artists.length > 0 ? { artists } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
      expiresAt
    });
  }

  const next = [...byId.values()].slice(-MAX_ACTIVE_TEMPORARY_QUEUE_BANS);
  if (next.length > 0) {
    setPref(userId, TEMPORARY_QUEUE_BANS_PREF_KEY, next);
  } else {
    deletePref(userId, TEMPORARY_QUEUE_BANS_PREF_KEY);
  }
  return next;
}

export function getActiveTemporaryQueueBans(userId: string, now = new Date()): TemporaryQueueBan[] {
  const raw = getPref<unknown>(userId, TEMPORARY_QUEUE_BANS_PREF_KEY);
  const parsed = parseTemporaryQueueBans(raw);
  const nowMs = now.getTime();
  const active = parsed.filter((ban) => Date.parse(ban.expiresAt) > nowMs);

  if (active.length !== parsed.length) {
    if (active.length > 0) {
      setPref(userId, TEMPORARY_QUEUE_BANS_PREF_KEY, active);
    } else {
      deletePref(userId, TEMPORARY_QUEUE_BANS_PREF_KEY);
    }
  }

  return active;
}

export function getActiveTemporaryQueueBanDedupeState(
  userId: string,
  now = new Date()
): TemporaryQueueBanDedupeState {
  const bans = getActiveTemporaryQueueBans(userId, now);
  return {
    ids: new Set(bans.map((ban) => ban.id)),
    dedupeKeys: new Set(bans.map((ban) => ban.dedupeKey).filter((key): key is string => Boolean(key))),
    bans
  };
}

function parseTemporaryQueueBans(raw: unknown): TemporaryQueueBan[] {
  if (!Array.isArray(raw)) return [];
  const bans: TemporaryQueueBan[] = [];

  for (const item of raw.slice(-MAX_ACTIVE_TEMPORARY_QUEUE_BANS)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()
      || record.id.trim().length > MAX_QUEUE_TRACK_ID_LENGTH) continue;
    if (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) continue;
    const artists = Array.isArray(record.artists)
      ? record.artists.slice(0, MAX_QUEUE_TRACK_ARTISTS).filter((artist): artist is string => (
          typeof artist === 'string'
          && artist.trim().length > 0
          && artist.trim().length <= MAX_QUEUE_TRACK_ARTIST_LENGTH
        ))
      : [];

    bans.push({
      id: record.id.trim(),
      ...(typeof record.name === 'string'
        && record.name.trim()
        && record.name.trim().length <= MAX_QUEUE_TRACK_NAME_LENGTH
        ? { name: record.name.trim() }
        : {}),
      ...(artists.length > 0 ? { artists } : {}),
      ...(typeof record.dedupeKey === 'string' && record.dedupeKey ? { dedupeKey: record.dedupeKey } : {}),
      expiresAt: record.expiresAt
    });
  }

  return bans;
}
