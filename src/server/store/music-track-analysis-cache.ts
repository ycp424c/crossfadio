import { z } from 'zod';
import {
  trackAssessmentEvidenceSchema,
  trackSemanticProfileSchema,
  type TrackAssessmentEvidence,
  type TrackSemanticProfile
} from '../music-agent/track-understanding.js';
import { getDb } from './db.js';

const evidenceListSchema = z.array(trackAssessmentEvidenceSchema).max(12);
const extractionSummarySchema = z.record(z.unknown());
const BATCH_QUERY_SIZE = 500;

export type MusicTrackLyricStatus = 'unknown' | 'available' | 'missing';

export type MusicTrackAnalysisCacheRecord = {
  provider: string;
  trackId: string;
  analyzerVersion: string | null;
  lyricStatus: MusicTrackLyricStatus;
  lyricHash: string | null;
  profile: TrackSemanticProfile | null;
  evidence: TrackAssessmentEvidence[];
  extractionSummary: Record<string, unknown>;
  analysisModel: string | null;
  lastLyricRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordMusicTrackLyricRefreshInput = {
  provider: string;
  trackId: string;
  lyricStatus: Exclude<MusicTrackLyricStatus, 'unknown'>;
  lyricHash: string | null;
  extractionSummary: Record<string, unknown>;
  refreshedAt: string;
};

export type SaveMusicTrackSemanticProfileInput = {
  provider: string;
  trackId: string;
  analyzerVersion: string;
  lyricHash: string | null;
  profile: TrackSemanticProfile;
  evidence: TrackAssessmentEvidence[];
  extractionSummary: Record<string, unknown>;
  analysisModel: string;
  lyricRefreshedAt: string | null;
};

type MusicTrackAnalysisCacheRow = {
  provider: string;
  track_id: string;
  analyzer_version: string | null;
  lyric_status: string;
  lyric_hash: string | null;
  profile_json: string | null;
  evidence_json: string | null;
  extraction_summary_json: string;
  analysis_model: string | null;
  last_lyric_refresh_at: string | null;
  created_at: string;
  updated_at: string;
};

export function getMusicTrackAnalysisCache(
  provider: string,
  trackId: string
): MusicTrackAnalysisCacheRecord | null {
  const normalizedProvider = provider.trim();
  const normalizedTrackId = trackId.trim();
  if (!normalizedProvider || !normalizedTrackId) return null;

  const row = getDb().prepare<[string, string], MusicTrackAnalysisCacheRow>(
    `SELECT *
     FROM music_track_analysis_cache
     WHERE provider = ? AND track_id = ?`
  ).get(normalizedProvider, normalizedTrackId);
  return row ? recordFromRow(row) : null;
}

export function getMusicTrackAnalysisCaches(
  provider: string,
  trackIds: string[]
): Map<string, MusicTrackAnalysisCacheRecord> {
  const normalizedProvider = provider.trim();
  const normalizedTrackIds = [...new Set(trackIds.map((id) => id.trim()).filter(Boolean))];
  if (!normalizedProvider || normalizedTrackIds.length === 0) return new Map();

  const rows: MusicTrackAnalysisCacheRow[] = [];
  for (let offset = 0; offset < normalizedTrackIds.length; offset += BATCH_QUERY_SIZE) {
    const batch = normalizedTrackIds.slice(offset, offset + BATCH_QUERY_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...getDb().prepare(
      `SELECT *
       FROM music_track_analysis_cache
       WHERE provider = ? AND track_id IN (${placeholders})`
    ).all(normalizedProvider, ...batch) as MusicTrackAnalysisCacheRow[]);
  }
  const recordsById = new Map(rows.map((row) => [row.track_id, recordFromRow(row)]));

  const result = new Map<string, MusicTrackAnalysisCacheRecord>();
  for (const trackId of normalizedTrackIds) {
    const record = recordsById.get(trackId);
    if (record) result.set(trackId, record);
  }
  return result;
}

export function recordMusicTrackLyricRefresh(input: RecordMusicTrackLyricRefreshInput): void {
  const provider = input.provider.trim();
  const trackId = input.trackId.trim();
  if (!provider || !trackId) return;
  const refreshedAt = normalizeIsoDate(input.refreshedAt, 'refreshedAt');

  getDb().prepare(
    `INSERT INTO music_track_analysis_cache (
       provider, track_id, lyric_status, lyric_hash, extraction_summary_json,
       last_lyric_refresh_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, track_id) DO UPDATE SET
       analyzer_version = CASE
         WHEN music_track_analysis_cache.lyric_hash IS NOT excluded.lyric_hash
         THEN NULL ELSE music_track_analysis_cache.analyzer_version END,
       lyric_status = excluded.lyric_status,
       lyric_hash = excluded.lyric_hash,
       profile_json = CASE
         WHEN music_track_analysis_cache.lyric_hash IS NOT excluded.lyric_hash
         THEN NULL ELSE music_track_analysis_cache.profile_json END,
       evidence_json = CASE
         WHEN music_track_analysis_cache.lyric_hash IS NOT excluded.lyric_hash
         THEN NULL ELSE music_track_analysis_cache.evidence_json END,
       extraction_summary_json = excluded.extraction_summary_json,
       analysis_model = CASE
         WHEN music_track_analysis_cache.lyric_hash IS NOT excluded.lyric_hash
         THEN NULL ELSE music_track_analysis_cache.analysis_model END,
       last_lyric_refresh_at = excluded.last_lyric_refresh_at,
       updated_at = datetime('now')`
  ).run(
    provider,
    trackId,
    input.lyricStatus,
    nullableTrimmedString(input.lyricHash),
    JSON.stringify(extractionSummarySchema.parse(input.extractionSummary)),
    refreshedAt
  );
}

export function saveMusicTrackSemanticProfile(input: SaveMusicTrackSemanticProfileInput): boolean {
  const provider = input.provider.trim();
  const trackId = input.trackId.trim();
  if (!provider || !trackId) return false;

  const profile = trackSemanticProfileSchema.parse(input.profile);
  const evidence = evidenceListSchema.parse(input.evidence);
  const extractionSummary = extractionSummarySchema.parse(input.extractionSummary);
  const lyricRefreshedAt = input.lyricRefreshedAt === null
    ? null
    : normalizeIsoDate(input.lyricRefreshedAt, 'lyricRefreshedAt');

  const result = getDb().prepare(
    `INSERT INTO music_track_analysis_cache (
       provider, track_id, analyzer_version, lyric_hash, profile_json,
       evidence_json, extraction_summary_json, analysis_model,
       last_lyric_refresh_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, track_id) DO UPDATE SET
       analyzer_version = excluded.analyzer_version,
       lyric_hash = excluded.lyric_hash,
       profile_json = excluded.profile_json,
       evidence_json = excluded.evidence_json,
       extraction_summary_json = excluded.extraction_summary_json,
       analysis_model = excluded.analysis_model,
       last_lyric_refresh_at = excluded.last_lyric_refresh_at,
       updated_at = datetime('now')
     WHERE music_track_analysis_cache.lyric_hash IS excluded.lyric_hash`
  ).run(
    provider,
    trackId,
    input.analyzerVersion.trim(),
    nullableTrimmedString(input.lyricHash),
    JSON.stringify(profile),
    JSON.stringify(evidence),
    JSON.stringify(extractionSummary),
    input.analysisModel.trim(),
    lyricRefreshedAt
  );
  return result.changes > 0;
}

function recordFromRow(row: MusicTrackAnalysisCacheRow): MusicTrackAnalysisCacheRecord {
  return {
    provider: row.provider,
    trackId: row.track_id,
    analyzerVersion: row.analyzer_version,
    lyricStatus: parseLyricStatus(row.lyric_status),
    lyricHash: row.lyric_hash,
    profile: parseJson(row.profile_json, trackSemanticProfileSchema, null),
    evidence: parseJson(row.evidence_json, evidenceListSchema, []),
    extractionSummary: parseJson(row.extraction_summary_json, extractionSummarySchema, {}),
    analysisModel: row.analysis_model,
    lastLyricRefreshAt: row.last_lyric_refresh_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJson<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function parseLyricStatus(value: string): MusicTrackLyricStatus {
  return value === 'available' || value === 'missing' ? value : 'unknown';
}

function nullableTrimmedString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeIsoDate(value: string, fieldName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName}: expected a valid date`);
  }
  return date.toISOString();
}
