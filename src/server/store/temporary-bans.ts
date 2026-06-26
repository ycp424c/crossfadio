import { buildMusicTrackDedupeKey } from '../music-agent/dedupe.js';
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
  const expiresAt = new Date(now.getTime() + TEMPORARY_QUEUE_BAN_TTL_MS).toISOString();
  const byId = new Map(getActiveTemporaryQueueBans(userId, now).map((ban) => [ban.id, ban]));

  for (const track of tracks) {
    const id = track.id.trim();
    if (!id) continue;
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => artist.trim()).filter(Boolean)
      : [];
    const name = track.name?.trim();
    const dedupeKey = buildMusicTrackDedupeKey({ name, artists });
    byId.set(id, {
      id,
      ...(name ? { name } : {}),
      ...(artists.length > 0 ? { artists } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
      expiresAt
    });
  }

  const next = [...byId.values()];
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

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) continue;
    if (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) continue;
    const artists = Array.isArray(record.artists)
      ? record.artists.filter((artist): artist is string => typeof artist === 'string' && artist.trim().length > 0)
      : [];

    bans.push({
      id: record.id.trim(),
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(artists.length > 0 ? { artists } : {}),
      ...(typeof record.dedupeKey === 'string' && record.dedupeKey ? { dedupeKey: record.dedupeKey } : {}),
      expiresAt: record.expiresAt
    });
  }

  return bans;
}
