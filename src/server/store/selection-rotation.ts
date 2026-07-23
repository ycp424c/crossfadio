import { explicitArtistKeys } from '../music-agent/artists.js';
import { buildMusicTrackDedupeKey } from '../music-agent/dedupe.js';
import { SELECTION_ROTATION_HISTORY_PICK_LIMIT } from '../../shared/dj-memory.js';
import { getDb } from './db.js';

export const SELECTION_ROTATION_HISTORY_ROUNDS = 200;

export type SelectionRotationTrackInput = {
  id: string;
  name: string;
  artists: string[];
};

export type SelectionRotationPick = {
  runId: string;
  roundNumber: number;
  pickOrder: number;
  trackId: string;
  trackName: string;
  artistDisplay: string;
  trackKey: string;
  artistKeys: string[];
  selectedAt: string;
};

export type SelectionRotationSnapshot = {
  currentRound: number;
  picks: SelectionRotationPick[];
};

export function recordSelectionRotationRound(input: {
  userId: string;
  runId: string;
  tracks: SelectionRotationTrackInput[];
  selectedAt?: string;
}): { inserted: boolean; roundNumber: number } {
  return recordSelectionRotation(input, true);
}

export function recordSelectionRotationExposure(input: {
  userId: string;
  runId: string;
  tracks: SelectionRotationTrackInput[];
  selectedAt?: string;
}): { inserted: boolean; roundNumber: number } {
  return recordSelectionRotation(input, false);
}

function recordSelectionRotation(
  input: {
    userId: string;
    runId: string;
    tracks: SelectionRotationTrackInput[];
    selectedAt?: string;
  },
  advancesRound: boolean
): { inserted: boolean; roundNumber: number } {
  const userId = required(input.userId, 'userId');
  const runId = required(input.runId, 'runId');
  if (input.tracks.length === 0) {
    throw new Error('selection rotation record requires at least one track');
  }
  const selectedAt = normalizedTimestamp(input.selectedAt ?? new Date().toISOString());
  const db = getDb();

  const write = (): { inserted: boolean; roundNumber: number } => {
    const existing = db.prepare(`
      SELECT round_number AS roundNumber
      FROM selection_rotation_runs
      WHERE user_id = ? AND run_id = ?
    `).get(userId, runId) as { roundNumber: number } | undefined;
    if (existing) {
      return { inserted: false, roundNumber: existing.roundNumber };
    }

    const latest = db.prepare(`
      SELECT COALESCE(MAX(round_number), 0) AS roundNumber
      FROM selection_rotation_runs
      WHERE user_id = ? AND advances_round = 1
    `).get(userId) as { roundNumber: number };
    const roundNumber = advancesRound ? latest.roundNumber + 1 : latest.roundNumber;
    db.prepare(`
      INSERT INTO selection_rotation_runs (
        user_id, run_id, round_number, advances_round, selected_at, track_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, runId, roundNumber, advancesRound ? 1 : 0, selectedAt, input.tracks.length);

    const insertPick = db.prepare(`
      INSERT INTO selection_rotation_picks (
        user_id, run_id, round_number, pick_order, track_id, track_name,
        artist_display, track_key, artist_keys_json, selected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.tracks.forEach((track, index) => {
      const trackId = required(track.id, 'track.id');
      const trackName = required(track.name, 'track.name');
      const artists = track.artists.map((artist) => artist.trim()).filter(Boolean);
      const artistDisplay = artists.join(' / ');
      const trackKey = buildMusicTrackDedupeKey({ name: trackName, artists });
      if (!trackKey) throw new Error(`selection rotation track key is empty: ${trackId}`);
      insertPick.run(
        userId,
        runId,
        roundNumber,
        index + 1,
        trackId,
        trackName,
        artistDisplay,
        trackKey,
        JSON.stringify(explicitArtistKeys(artistDisplay)),
        selectedAt
      );
    });

    pruneSelectionRotationHistory(userId, roundNumber);
    return { inserted: true, roundNumber };
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

export function getSelectionRotationSnapshot(
  userId: string,
  historyRounds = SELECTION_ROTATION_HISTORY_ROUNDS
): SelectionRotationSnapshot {
  const normalizedUserId = required(userId, 'userId');
  const boundedRounds = Math.max(
    1,
    Math.min(Math.trunc(historyRounds), SELECTION_ROTATION_HISTORY_ROUNDS)
  );
  const current = getDb().prepare(`
    SELECT COALESCE(MAX(round_number), 0) AS currentRound
    FROM selection_rotation_runs
    WHERE user_id = ? AND advances_round = 1
  `).get(normalizedUserId) as { currentRound: number };

  const minimumRound = Math.max(0, current.currentRound - boundedRounds + 1);
  const rows = getDb().prepare(`
    SELECT run_id, round_number, pick_order, track_id, track_name,
           artist_display, track_key, artist_keys_json, selected_at
    FROM selection_rotation_picks
    WHERE user_id = ? AND round_number >= ?
    ORDER BY round_number DESC, selected_at DESC, run_id DESC, pick_order ASC
    LIMIT ?
  `).all(
    normalizedUserId,
    minimumRound,
    SELECTION_ROTATION_HISTORY_PICK_LIMIT
  ) as SelectionRotationPickRow[];
  return {
    currentRound: current.currentRound,
    picks: rows.map(mapPick)
  };
}

function pruneSelectionRotationHistory(userId: string, currentRound: number): void {
  const minimumRound = Math.max(0, currentRound - SELECTION_ROTATION_HISTORY_ROUNDS + 1);
  const db = getDb();
  db.prepare(`
    DELETE FROM selection_rotation_picks
    WHERE user_id = ? AND round_number < ?
  `).run(userId, minimumRound);
  db.prepare(`
    DELETE FROM selection_rotation_runs
    WHERE user_id = ? AND round_number < ?
  `).run(userId, minimumRound);
  db.prepare(`
    DELETE FROM selection_rotation_picks
    WHERE rowid IN (
      SELECT rowid
      FROM selection_rotation_picks
      WHERE user_id = ?
      ORDER BY round_number DESC, selected_at DESC, run_id DESC, pick_order ASC
      LIMIT -1 OFFSET ?
    )
  `).run(userId, SELECTION_ROTATION_HISTORY_PICK_LIMIT);
  db.prepare(`
    DELETE FROM selection_rotation_runs
    WHERE user_id = ?
      AND advances_round = 0
      AND NOT EXISTS (
        SELECT 1
        FROM selection_rotation_picks
        WHERE selection_rotation_picks.user_id = selection_rotation_runs.user_id
          AND selection_rotation_picks.run_id = selection_rotation_runs.run_id
      )
  `).run(userId);
}

function mapPick(row: SelectionRotationPickRow): SelectionRotationPick {
  return {
    runId: row.run_id,
    roundNumber: row.round_number,
    pickOrder: row.pick_order,
    trackId: row.track_id,
    trackName: row.track_name,
    artistDisplay: row.artist_display,
    trackKey: row.track_key,
    artistKeys: parseStringArray(row.artist_keys_json),
    selectedAt: row.selected_at
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`selection rotation ${field} is required`);
  return normalized;
}

function normalizedTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('selection rotation selectedAt is invalid');
  return new Date(timestamp).toISOString();
}

type SelectionRotationPickRow = {
  run_id: string;
  round_number: number;
  pick_order: number;
  track_id: string;
  track_name: string;
  artist_display: string;
  track_key: string;
  artist_keys_json: string;
  selected_at: string;
};
