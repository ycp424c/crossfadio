import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { NcmTrackLike } from '../music-agent/liked-recall.js';
import {
  candidateProvenanceKindSchema,
  candidateSourceSchema,
  musicCandidateQualitySignalsSchema,
  type CandidateProvenanceKind,
  type CandidateSource,
  type MusicCandidateQualitySignals
} from '../music-agent/schema.js';
import { getDb } from './db.js';
import type { RetrievalRequestKind } from './retrieval-attempts.js';

export const SOURCE_RESERVOIR_REUSE_WINDOW_MS = 120 * 60 * 1_000;
export const SOURCE_RESERVOIR_TTL_MS = 2 * 60 * 60 * 1_000;
export const SOURCE_RESERVOIR_MAX_TRACKS_PER_SOURCE = 30;
export const SOURCE_RESERVOIR_MAX_TRACKS_PER_USER = 200;

export const sourceReservoirSourceKindSchema = z.enum([
  'search',
  'playlist',
  'artist',
  'album',
  'trend',
  'style_expansion',
  'web_hint'
]);

export type SourceReservoirSourceKind = z.infer<typeof sourceReservoirSourceKindSchema>;

export type SourceReservoirIdentity = {
  sourceKey: string;
  sourceKind: SourceReservoirSourceKind;
  provider: string;
  sourceRef: string;
};

export type SourceReservoirSource = SourceReservoirIdentity & {
  displayName: string;
  candidateSource: CandidateSource;
  provenanceKind: CandidateProvenanceKind;
  runId: string;
  fetchedAt: string;
  reuseAfter: string;
  expiresAt: string;
  tracks: SourceReservoirTrack[];
};

export type SourceReservoirTrack = {
  id: string | number;
  name: string;
  artists: string[];
  qualitySignals?: MusicCandidateQualitySignals | null;
};

type SourceRow = {
  source_key: string;
  source_kind: SourceReservoirSourceKind;
  provider: string;
  source_ref: string;
  display_name: string;
  candidate_source: CandidateSource;
  provenance_kind: CandidateProvenanceKind;
  run_id: string;
  fetched_at: string;
  reuse_after: string;
  expires_at: string;
};

type TrackRow = SourceRow & {
  track_json: string;
};

const reservoirTrackSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  artists: z.array(z.string()),
  qualitySignals: musicCandidateQualitySignalsSchema.nullable().optional()
}).passthrough();

export function buildSourceReservoirIdentity(input: {
  sourceKind: SourceReservoirSourceKind;
  provider?: string;
  sourceRef: string;
}): SourceReservoirIdentity {
  const provider = normalizeToken(input.provider ?? 'ncm');
  const sourceRef = normalizeToken(input.sourceRef);
  const sourceKind = sourceReservoirSourceKindSchema.parse(input.sourceKind);
  if (!provider || !sourceRef) {
    throw new Error('source reservoir identity requires provider and sourceRef');
  }
  return {
    sourceKind,
    provider,
    sourceRef,
    sourceKey: createHash('sha256')
      .update(`${sourceKind}\u0000${provider}\u0000${sourceRef}`)
      .digest('hex')
  };
}

export function isSourceReservoirFetchAvailable(input: {
  userId: string;
  identity: SourceReservoirIdentity;
  requestKind: RetrievalRequestKind;
  now?: Date;
}): boolean {
  if (input.requestKind === 'explicit_request') return true;
  const now = (input.now ?? new Date()).toISOString();
  const row = getDb().prepare<[string, string], { reuse_after: string }>(`
    SELECT reuse_after
    FROM source_reservoir_sources
    WHERE user_id = ? AND source_key = ?
  `).get(input.userId, input.identity.sourceKey);
  return !row || row.reuse_after <= now;
}

export function recordSourceReservoirFetch(input: {
  userId: string;
  runId: string;
  identity: SourceReservoirIdentity;
  displayName: string;
  candidateSource: CandidateSource;
  provenanceKind: CandidateProvenanceKind;
  tracks: NcmTrackLike[];
  fetchedAt?: Date;
}): void {
  const fetchedAt = input.fetchedAt ?? new Date();
  const fetchedAtIso = fetchedAt.toISOString();
  const reuseAfter = new Date(fetchedAt.getTime() + SOURCE_RESERVOIR_REUSE_WINDOW_MS).toISOString();
  const expiresAt = new Date(fetchedAt.getTime() + SOURCE_RESERVOIR_TTL_MS).toISOString();
  const candidateSource = candidateSourceSchema.parse(input.candidateSource);
  const provenanceKind = candidateProvenanceKindSchema.parse(input.provenanceKind);
  const tracks = uniqueValidTracks(input.tracks).slice(0, SOURCE_RESERVOIR_MAX_TRACKS_PER_SOURCE);
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
    INSERT INTO source_reservoir_sources (
      user_id, source_key, source_kind, provider, source_ref, display_name,
      candidate_source, provenance_kind, run_id, fetched_at, reuse_after, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source_key) DO UPDATE SET
      source_kind = excluded.source_kind,
      provider = excluded.provider,
      source_ref = excluded.source_ref,
      display_name = excluded.display_name,
      candidate_source = excluded.candidate_source,
      provenance_kind = excluded.provenance_kind,
      run_id = excluded.run_id,
      fetched_at = excluded.fetched_at,
      reuse_after = excluded.reuse_after,
      expires_at = excluded.expires_at
    `).run(
      input.userId,
      input.identity.sourceKey,
      input.identity.sourceKind,
      input.identity.provider,
      input.identity.sourceRef,
      compactWhitespace(input.displayName) || input.identity.sourceRef,
      candidateSource,
      provenanceKind,
      input.runId,
      fetchedAtIso,
      reuseAfter,
      expiresAt
    );
    db.prepare(`
      DELETE FROM source_reservoir_tracks
      WHERE user_id = ? AND source_key = ?
    `).run(input.userId, input.identity.sourceKey);
    const insertTrack = db.prepare(`
      INSERT INTO source_reservoir_tracks (
        user_id, source_key, track_id, track_json, position, consumed_at, consumed_run_id
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `);
    tracks.forEach((track, position) => {
      insertTrack.run(
        input.userId,
        input.identity.sourceKey,
        String(track.id),
        JSON.stringify(track),
        position
      );
    });
    pruneSourceReservoirForUser(input.userId, fetchedAt);
  }).immediate();
}

export function listSourceReservoir(input: {
  userId: string;
  now?: Date;
  limit?: number;
}): SourceReservoirSource[] {
  const now = (input.now ?? new Date()).toISOString();
  const limit = boundedLimit(input.limit ?? SOURCE_RESERVOIR_MAX_TRACKS_PER_USER);
  const rows = getDb().prepare<[string, string], TrackRow>(`
    SELECT s.*, t.track_json
    FROM source_reservoir_sources s
    JOIN source_reservoir_tracks t
      ON t.user_id = s.user_id AND t.source_key = s.source_key
    WHERE s.user_id = ?
      AND s.expires_at > ?
      AND t.consumed_at IS NULL
    ORDER BY s.fetched_at DESC, s.source_key ASC, t.position ASC
  `).all(input.userId, now);

  const sources = new Map<string, SourceReservoirSource>();
  for (const row of rows) {
    const parsed = parseTrack(row.track_json);
    if (!parsed) continue;
    let source = sources.get(row.source_key);
    if (!source) {
      source = {
        sourceKey: row.source_key,
        sourceKind: sourceReservoirSourceKindSchema.parse(row.source_kind),
        provider: row.provider,
        sourceRef: row.source_ref,
        displayName: row.display_name,
        candidateSource: candidateSourceSchema.parse(row.candidate_source),
        provenanceKind: candidateProvenanceKindSchema.parse(row.provenance_kind),
        runId: row.run_id,
        fetchedAt: row.fetched_at,
        reuseAfter: row.reuse_after,
        expiresAt: row.expires_at,
        tracks: []
      };
      sources.set(row.source_key, source);
    }
    source.tracks.push(parsed);
  }

  return boundReservoirSourcesRoundRobin([...sources.values()], limit);
}

export function consumeSourceReservoirTracks(input: {
  userId: string;
  runId: string;
  trackIds: Iterable<string>;
  consumedAt?: Date | string;
}): number {
  const trackIds = [...new Set([...input.trackIds].map(String).map((id) => id.trim()).filter(Boolean))];
  if (trackIds.length === 0) return 0;
  const consumedAt = typeof input.consumedAt === 'string'
    ? new Date(input.consumedAt).toISOString()
    : (input.consumedAt ?? new Date()).toISOString();
  const statement = getDb().prepare(`
    UPDATE source_reservoir_tracks
    SET consumed_at = ?, consumed_run_id = ?
    WHERE user_id = ? AND track_id = ? AND consumed_at IS NULL
  `);
  let consumed = 0;
  for (const trackId of trackIds) {
    consumed += statement.run(consumedAt, input.runId, input.userId, trackId).changes;
  }
  return consumed;
}

export function deleteExpiredSourceReservoir(now = new Date()): number {
  const db = getDb();
  const expiresAt = now.toISOString();
  return db.transaction(() => {
    db.prepare(`
      DELETE FROM source_reservoir_tracks
      WHERE EXISTS (
        SELECT 1
        FROM source_reservoir_sources s
        WHERE s.user_id = source_reservoir_tracks.user_id
          AND s.source_key = source_reservoir_tracks.source_key
          AND s.expires_at <= ?
      )
    `).run(expiresAt);
    return db.prepare(`
      DELETE FROM source_reservoir_sources
      WHERE expires_at <= ?
    `).run(expiresAt).changes;
  }).immediate();
}

function pruneSourceReservoirForUser(userId: string, now: Date): void {
  deleteExpiredSourceReservoir(now);
  const overflowRows = getDb().prepare<[string, number], { user_id: string; source_key: string; track_id: string }>(`
    SELECT user_id, source_key, track_id
    FROM source_reservoir_tracks
    WHERE user_id = ? AND consumed_at IS NULL
    ORDER BY (
      SELECT fetched_at FROM source_reservoir_sources s
      WHERE s.user_id = source_reservoir_tracks.user_id
        AND s.source_key = source_reservoir_tracks.source_key
    ) DESC, source_key ASC, position ASC
    LIMIT -1 OFFSET ?
  `).all(userId, SOURCE_RESERVOIR_MAX_TRACKS_PER_USER);
  const remove = getDb().prepare(`
    DELETE FROM source_reservoir_tracks
    WHERE user_id = ? AND source_key = ? AND track_id = ?
  `);
  for (const row of overflowRows) remove.run(row.user_id, row.source_key, row.track_id);
}

function uniqueValidTracks(tracks: NcmTrackLike[]): SourceReservoirTrack[] {
  const byId = new Map<string, SourceReservoirTrack>();
  for (const track of tracks) {
    const parsed = reservoirTrackSchema.safeParse(track);
    if (!parsed.success) continue;
    const id = String(parsed.data.id).trim();
    if (!id || !parsed.data.name.trim() || parsed.data.artists.length === 0) continue;
    byId.set(id, {
      id,
      name: parsed.data.name.trim(),
      artists: parsed.data.artists.map((artist) => artist.trim()).filter(Boolean),
      ...(parsed.data.qualitySignals ? { qualitySignals: parsed.data.qualitySignals } : {})
    });
  }
  return [...byId.values()].filter((track) => (track.artists ?? []).length > 0);
}

function parseTrack(value: string): SourceReservoirTrack | null {
  try {
    const parsed = reservoirTrackSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function boundReservoirSourcesRoundRobin(
  sources: SourceReservoirSource[],
  limit: number
): SourceReservoirSource[] {
  if (sources.length === 0 || limit === 0) return [];
  const selected = sources.map((source) => ({ ...source, tracks: [] as SourceReservoirTrack[] }));
  let count = 0;
  for (let position = 0; count < limit; position += 1) {
    let addedAtPosition = 0;
    for (const [index, source] of sources.entries()) {
      const track = source.tracks[position];
      if (!track || count >= limit) continue;
      selected[index]!.tracks.push(track);
      count += 1;
      addedAtPosition += 1;
    }
    if (addedAtPosition === 0) break;
  }
  return selected.filter((source) => source.tracks.length > 0);
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) return SOURCE_RESERVOIR_MAX_TRACKS_PER_USER;
  return Math.max(0, Math.min(SOURCE_RESERVOIR_MAX_TRACKS_PER_USER, Math.floor(value)));
}

function normalizeToken(value: string): string {
  return compactWhitespace(value).normalize('NFKC').toLocaleLowerCase();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
