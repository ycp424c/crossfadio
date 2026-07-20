import { randomUUID } from 'node:crypto';
import type {
  ListeningEpisodeCheckpoint,
  ListeningEpisodeCreate,
  ListeningEpisodeFinalize,
  PlaybackOutcome
} from '../../shared/listening.js';
import { LISTENING_EPISODE_DAILY_LIMIT } from '../../shared/listening.js';
import { getDb } from './db.js';

export type ListeningEpisodeRecord = {
  id: string;
  userId: string;
  clientEpisodeId: string;
  playerInstanceId: string;
  deckId: string;
  provider: string;
  track: {
    id: string;
    name: string;
    artists: string[];
    primaryArtist: string | null;
  };
  durationMs: number | null;
  positionMs: number;
  listenedMs: number;
  checkpointSeq: number;
  outcome: PlaybackOutcome | null;
  startedAt: string;
  lastCheckpointAt: string;
  endedAt: string | null;
  protocolVersion: number;
  legacyExposureOverride: number | null;
};

export type CreateListeningEpisodeResult =
  | {
      status: 'accepted';
      created: boolean;
      conflict: boolean;
      episode: ListeningEpisodeRecord;
    }
  | {
      status: 'quota_exceeded';
      created: false;
      conflict: false;
      episode: null;
      quotaResetsAt: string;
    };

export type UpdateListeningEpisodeResult = {
  status: 'updated' | 'stale' | 'conflict' | 'not_found';
  episode: ListeningEpisodeRecord | null;
};

export function createListeningEpisode(
  userId: string,
  clientEpisodeId: string,
  input: ListeningEpisodeCreate,
  options?: { now?: Date }
): CreateListeningEpisodeResult {
  const db = getDb();
  const now = options?.now ?? new Date();
  const timestamp = now.toISOString();
  const { start, end } = utcDayBounds(now);
  const transaction = db.transaction((): CreateListeningEpisodeResult => {
    const existing = getListeningEpisode(userId, clientEpisodeId);
    if (existing) {
      return {
        status: 'accepted',
        created: false,
        conflict: !matchesCreateInput(existing, input),
        episode: existing
      };
    }

    const usage = db.prepare(`
      SELECT COUNT(*) AS count
      FROM listening_episodes
      WHERE user_id = ? AND started_at >= ? AND started_at < ?
    `).get(userId, start, end) as { count: number };
    if (usage.count >= LISTENING_EPISODE_DAILY_LIMIT) {
      return {
        status: 'quota_exceeded',
        created: false,
        conflict: false,
        episode: null,
        quotaResetsAt: end
      };
    }

    const result = db.prepare(`
      INSERT INTO listening_episodes (
        id,
        user_id,
        client_episode_id,
        player_instance_id,
        deck_id,
        provider,
        track_id,
        track_name,
        artists_json,
        primary_artist,
        duration_ms,
        position_ms,
        listened_ms,
        checkpoint_seq,
        outcome,
        started_at,
        last_checkpoint_at,
        ended_at,
        protocol_version,
        legacy_exposure_override
      ) VALUES (?, ?, ?, ?, ?, 'ncm', ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, NULL, 2, NULL)
      ON CONFLICT(user_id, client_episode_id) DO NOTHING
    `).run(
      randomUUID(),
      userId,
      clientEpisodeId,
      input.playerInstanceId,
      input.deckId,
      input.track.id,
      input.track.name,
      JSON.stringify(input.track.artists),
      input.track.artists[0] ?? null,
      input.durationMs,
      timestamp,
      timestamp
    );

    const episode = getListeningEpisode(userId, clientEpisodeId);
    if (!episode) {
      throw new Error('Listening Episode was not persisted');
    }
    const created = result.changes === 1;
    return {
      status: 'accepted',
      created,
      conflict: !created && !matchesCreateInput(episode, input),
      episode
    };
  });
  return transaction.immediate();
}

export function cleanupStaleListeningEpisodes(now: Date = new Date()): number {
  const staleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endedAt = now.toISOString();
  const result = getDb().prepare(`
    UPDATE listening_episodes
    SET outcome = 'interrupted',
        ended_at = ?,
        last_checkpoint_at = ?
    WHERE outcome IS NULL
      AND last_checkpoint_at <= ?
  `).run(endedAt, endedAt, staleCutoff);
  return result.changes;
}

export function cleanupExpiredListeningEpisodes(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000).toISOString();
  return getDb().prepare(`
    DELETE FROM listening_episodes
    WHERE COALESCE(ended_at, last_checkpoint_at, started_at) <= ?
  `).run(cutoff).changes;
}

export function getListeningEpisode(
  userId: string,
  clientEpisodeId: string
): ListeningEpisodeRecord | null {
  const row = getDb().prepare(`
    SELECT *
    FROM listening_episodes
    WHERE user_id = ? AND client_episode_id = ?
  `).get(userId, clientEpisodeId) as ListeningEpisodeRow | undefined;
  return row ? mapListeningEpisode(row) : null;
}

export function listRecentListeningEpisodes(
  userId: string,
  limit = 80
): ListeningEpisodeRecord[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM listening_episodes
    WHERE user_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(Math.trunc(limit), 1_000))) as ListeningEpisodeRow[];
  return rows.map(mapListeningEpisode);
}

export function listListeningEpisodesInWindow(
  userId: string,
  input: { since: Date; until: Date; limit: number }
): ListeningEpisodeRecord[] {
  const limit = Math.max(1, Math.trunc(input.limit));
  const rows = getDb().prepare(`
    SELECT *
    FROM listening_episodes
    WHERE user_id = ?
      AND started_at >= ?
      AND started_at <= ?
      AND (ended_at IS NULL OR ended_at <= ?)
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(
    userId,
    input.since.toISOString(),
    input.until.toISOString(),
    input.until.toISOString(),
    limit
  ) as ListeningEpisodeRow[];
  return rows.map(mapListeningEpisode);
}

export function checkpointListeningEpisode(
  userId: string,
  clientEpisodeId: string,
  input: ListeningEpisodeCheckpoint,
  options?: { now?: Date }
): UpdateListeningEpisodeResult {
  const current = getListeningEpisode(userId, clientEpisodeId);
  if (!current) return { status: 'not_found', episode: null };
  if (current.outcome !== null) {
    return { status: 'conflict', episode: current };
  }
  if (input.checkpointSeq <= current.checkpointSeq) {
    return { status: 'stale', episode: current };
  }
  if (input.listenedMs < current.listenedMs) {
    return { status: 'conflict', episode: current };
  }
  const now = options?.now ?? new Date();
  if (!isPlausibleListenedProgress(current, input.listenedMs, now)) {
    return { status: 'conflict', episode: current };
  }

  const result = getDb().prepare(`
    UPDATE listening_episodes
    SET position_ms = ?,
        listened_ms = ?,
        duration_ms = COALESCE(?, duration_ms),
        checkpoint_seq = ?,
        last_checkpoint_at = ?
    WHERE user_id = ?
      AND client_episode_id = ?
      AND outcome IS NULL
      AND checkpoint_seq = ?
  `).run(
    input.positionMs,
    input.listenedMs,
    input.durationMs,
    input.checkpointSeq,
    now.toISOString(),
    userId,
    clientEpisodeId,
    current.checkpointSeq
  );

  const episode = getListeningEpisode(userId, clientEpisodeId);
  if (result.changes === 0) {
    return { status: 'stale', episode };
  }
  return { status: 'updated', episode };
}

export function finalizeListeningEpisode(
  userId: string,
  clientEpisodeId: string,
  input: ListeningEpisodeFinalize,
  options?: { now?: Date }
): UpdateListeningEpisodeResult {
  const current = getListeningEpisode(userId, clientEpisodeId);
  if (!current) return { status: 'not_found', episode: null };
  if (current.outcome !== null) {
    return current.outcome === input.outcome
      ? { status: 'stale', episode: current }
      : { status: 'conflict', episode: current };
  }
  if (input.checkpointSeq <= current.checkpointSeq || input.listenedMs < current.listenedMs) {
    return { status: 'conflict', episode: current };
  }
  const now = options?.now ?? new Date();
  if (!isPlausibleListenedProgress(current, input.listenedMs, now)) {
    return { status: 'conflict', episode: current };
  }

  const timestamp = now.toISOString();
  const result = getDb().prepare(`
    UPDATE listening_episodes
    SET position_ms = ?,
        listened_ms = ?,
        duration_ms = COALESCE(?, duration_ms),
        checkpoint_seq = ?,
        outcome = ?,
        last_checkpoint_at = ?,
        ended_at = ?
    WHERE user_id = ?
      AND client_episode_id = ?
      AND outcome IS NULL
      AND checkpoint_seq = ?
  `).run(
    input.positionMs,
    input.listenedMs,
    input.durationMs,
    input.checkpointSeq,
    input.outcome,
    timestamp,
    timestamp,
    userId,
    clientEpisodeId,
    current.checkpointSeq
  );

  const episode = getListeningEpisode(userId, clientEpisodeId);
  if (result.changes === 0) {
    if (episode?.outcome === input.outcome) return { status: 'stale', episode };
    return { status: 'conflict', episode };
  }
  return { status: 'updated', episode };
}

type ListeningEpisodeRow = {
  id: string;
  user_id: string;
  client_episode_id: string;
  player_instance_id: string;
  deck_id: string;
  provider: string;
  track_id: string;
  track_name: string;
  artists_json: string;
  primary_artist: string | null;
  duration_ms: number | null;
  position_ms: number;
  listened_ms: number;
  checkpoint_seq: number;
  outcome: PlaybackOutcome | null;
  started_at: string;
  last_checkpoint_at: string;
  ended_at: string | null;
  protocol_version: number;
  legacy_exposure_override: number | null;
};

function mapListeningEpisode(row: ListeningEpisodeRow): ListeningEpisodeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    clientEpisodeId: row.client_episode_id,
    playerInstanceId: row.player_instance_id,
    deckId: row.deck_id,
    provider: row.provider,
    track: {
      id: row.track_id,
      name: row.track_name,
      artists: parseArtists(row.artists_json),
      primaryArtist: row.primary_artist
    },
    durationMs: row.duration_ms,
    positionMs: row.position_ms,
    listenedMs: row.listened_ms,
    checkpointSeq: row.checkpoint_seq,
    outcome: row.outcome,
    startedAt: row.started_at,
    lastCheckpointAt: row.last_checkpoint_at,
    endedAt: row.ended_at,
    protocolVersion: row.protocol_version,
    legacyExposureOverride: row.legacy_exposure_override
  };
}

function parseArtists(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((artist): artist is string => typeof artist === 'string')
      : [];
  } catch {
    return [];
  }
}

function matchesCreateInput(
  episode: ListeningEpisodeRecord,
  input: ListeningEpisodeCreate
): boolean {
  return episode.playerInstanceId === input.playerInstanceId &&
    episode.deckId === input.deckId &&
    episode.track.id === input.track.id &&
    episode.track.name === input.track.name &&
    episode.durationMs === input.durationMs &&
    episode.track.artists.length === input.track.artists.length &&
    episode.track.artists.every((artist, index) => artist === input.track.artists[index]);
}

function utcDayBounds(now: Date): { start: string; end: string } {
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86_400_000).toISOString()
  };
}

function isPlausibleListenedProgress(
  current: ListeningEpisodeRecord,
  nextListenedMs: number,
  now: Date
): boolean {
  const lastCheckpointMs = Date.parse(current.lastCheckpointAt);
  if (!Number.isFinite(lastCheckpointMs)) return false;
  const wallClockDeltaMs = Math.max(0, now.getTime() - lastCheckpointMs);
  const listenedDeltaMs = nextListenedMs - current.listenedMs;
  const maximumDeltaMs = Math.max(30_000, wallClockDeltaMs * 2);
  return listenedDeltaMs <= maximumDeltaMs;
}
