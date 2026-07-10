import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

const calmProfile = {
  genres: ['ambient'],
  moods: ['calm'],
  energy: 'low',
  aggression: 'low',
  vocalIntensity: 'low',
  lyricThemes: ['reflection'],
  language: 'en'
} as const;

const calmConfidence = {
  genres: 0.9,
  moods: 0.8,
  energy: 0.95,
  aggression: 0.9,
  vocalIntensity: 0.7,
  lyricThemes: 0.6,
  language: 0.99
} as const;

const calmAssessment = {
  id: '42',
  profile: calmProfile,
  confidence: calmConfidence,
  evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }]
} as const;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-track-analysis-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('track understanding schemas', () => {
  it('accepts bounded strict assessments and rejects malformed semantic output', async () => {
    const { trackAssessmentSchema } = await import('../../src/server/music-agent/track-understanding.js');

    expect(trackAssessmentSchema.safeParse(calmAssessment).success).toBe(true);
    expect(trackAssessmentSchema.safeParse({
      ...calmAssessment,
      profile: { ...calmProfile, genres: Array.from({ length: 9 }, (_, index) => `genre-${index}`) }
    }).success).toBe(false);
    expect(trackAssessmentSchema.safeParse({
      ...calmAssessment,
      confidence: { ...calmAssessment.confidence, energy: 1.1 }
    }).success).toBe(false);
    expect(trackAssessmentSchema.safeParse({ ...calmAssessment, unexpected: true }).success).toBe(false);
  });
});

describe('music track analysis cache', () => {
  it('upserts and reads a validated semantic profile', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');

    recordMusicTrackLyricRefresh({
      provider: 'ncm',
      trackId: '42',
      lyricStatus: 'available',
      lyricHash: 'hash-a',
      extractionSummary: { lineCount: 20 },
      refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    saveMusicTrackSemanticProfile({
      provider: 'ncm',
      trackId: '42',
      analyzerVersion: 'lyrics-v1',
      lyricHash: 'hash-a',
      profile: calmProfile,
      confidence: calmConfidence,
      evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }],
      extractionSummary: { lineCount: 20 },
      analysisModel: 'test-model',
      lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      provider: 'ncm',
      trackId: '42',
      analyzerVersion: 'lyrics-v1',
      lyricStatus: 'available',
      lyricHash: 'hash-a',
      profile: calmProfile,
      confidence: calmConfidence,
      evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }],
      extractionSummary: { lineCount: 20 },
      analysisModel: 'test-model',
      lastLyricRefreshAt: '2026-07-10T10:00:00.000Z'
    });
  });

  it('isolates providers and batch-loads deduplicated track ids', async () => {
    const {
      getMusicTrackAnalysisCaches,
      recordMusicTrackLyricRefresh
    } = await import('../../src/server/store/music-track-analysis-cache.js');

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'ncm-hash',
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    recordMusicTrackLyricRefresh({
      provider: 'spotify', trackId: '42', lyricStatus: 'available', lyricHash: 'spotify-hash',
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '43', lyricStatus: 'missing', lyricHash: null,
      extractionSummary: { reason: 'not_found' }, refreshedAt: '2026-07-10T10:01:00.000Z'
    });

    expect(getMusicTrackAnalysisCaches('ncm', [])).toEqual(new Map());
    const records = getMusicTrackAnalysisCaches('ncm', ['42', '42', '43', 'absent']);
    expect([...records.keys()]).toEqual(['42', '43']);
    expect(records.get('42')?.lyricHash).toBe('ncm-hash');
    expect(records.get('43')).toMatchObject({ lyricStatus: 'missing', profile: null });
  });

  it('batch-loads more track ids than one SQLite variable set can hold', async () => {
    const {
      getMusicTrackAnalysisCaches,
      recordMusicTrackLyricRefresh
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'track-0', lyricStatus: 'available', lyricHash: 'hash-first',
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'track-39999', lyricStatus: 'available', lyricHash: 'hash-last',
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    const trackIds = Array.from({ length: 40_000 }, (_, index) => `track-${index}`);

    const records = getMusicTrackAnalysisCaches('ncm', trackIds);

    expect([...records.keys()]).toEqual(['track-0', 'track-39999']);
    expect(records.get('track-0')?.lyricHash).toBe('hash-first');
    expect(records.get('track-39999')?.lyricHash).toBe('hash-last');
  });

  it('preserves a semantic profile when the refreshed lyric hash is unchanged', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: 'hash-a',
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: { lineCount: 20 },
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-a',
      extractionSummary: { lineCount: 22 }, refreshedAt: '2026-07-10T11:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      profile: calmProfile,
      confidence: calmConfidence,
      analyzerVersion: 'lyrics-v1',
      analysisModel: 'test-model',
      extractionSummary: { lineCount: 22 }
    });
  });

  it('atomically clears analysis when a non-null lyric hash changes', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: 'hash-a',
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: {},
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-b',
      extractionSummary: { lineCount: 24 }, refreshedAt: '2026-07-10T12:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      lyricHash: 'hash-b',
      profile: null,
      confidence: null,
      evidence: [],
      analyzerVersion: null,
      analysisModel: null
    });
  });

  it('clears analysis when an available lyric becomes missing', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: 'hash-a',
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: {},
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'missing', lyricHash: null,
      extractionSummary: { reason: 'not_found' }, refreshedAt: '2026-07-10T12:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      lyricHash: null,
      profile: null,
      confidence: null,
      evidence: [],
      analyzerVersion: null,
      analysisModel: null
    });
  });

  it('clears analysis when a missing lyric gains a hash', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: null,
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: {},
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-b',
      extractionSummary: { lineCount: 24 }, refreshedAt: '2026-07-10T12:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      lyricHash: 'hash-b',
      profile: null,
      confidence: null,
      evidence: [],
      analyzerVersion: null,
      analysisModel: null
    });
  });

  it('rejects a stale semantic profile after a newer lyric refresh wins', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-a',
      extractionSummary: { lineCount: 20 }, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-b',
      extractionSummary: { lineCount: 24 }, refreshedAt: '2026-07-10T11:00:00.000Z'
    });

    const saved = saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: 'hash-a',
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: { lineCount: 20 },
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T10:00:00.000Z'
    });

    expect(saved).toBe(false);
    expect(getMusicTrackAnalysisCache('ncm', '42')).toMatchObject({
      lyricHash: 'hash-b',
      profile: null,
      confidence: null,
      evidence: [],
      analyzerVersion: null,
      analysisModel: null,
      extractionSummary: { lineCount: 24 }
    });
  });

  it('records missing lyrics without manufacturing a semantic profile', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh
    } = await import('../../src/server/store/music-track-analysis-cache.js');

    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'missing', lyricStatus: 'missing', lyricHash: null,
      extractionSummary: { reason: 'not_found' }, refreshedAt: '2026-07-10T10:00:00.000Z'
    });

    expect(getMusicTrackAnalysisCache('ncm', 'missing')).toMatchObject({
      lyricStatus: 'missing', lyricHash: null, profile: null, evidence: [],
      confidence: null,
      extractionSummary: { reason: 'not_found' }
    });
  });

  it('normalizes refresh timestamps to UTC ISO strings at both write boundaries', async () => {
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: '42', lyricStatus: 'available', lyricHash: 'hash-a',
      extractionSummary: {}, refreshedAt: '2026-07-10T18:00:00+08:00'
    });
    expect(getMusicTrackAnalysisCache('ncm', '42')?.lastLyricRefreshAt)
      .toBe('2026-07-10T10:00:00.000Z');

    expect(saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: '42', analyzerVersion: 'lyrics-v1', lyricHash: 'hash-a',
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: {},
      analysisModel: 'test-model', lyricRefreshedAt: '2026-07-10T19:00:00+08:00'
    })).toBe(true);
    expect(getMusicTrackAnalysisCache('ncm', '42')?.lastLyricRefreshAt)
      .toBe('2026-07-10T11:00:00.000Z');
  });

  it('rejects invalid refresh timestamps with the input field name', async () => {
    const {
      recordMusicTrackLyricRefresh,
      saveMusicTrackSemanticProfile
    } = await import('../../src/server/store/music-track-analysis-cache.js');

    expect(() => recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'bad-refresh', lyricStatus: 'missing', lyricHash: null,
      extractionSummary: {}, refreshedAt: 'not-a-date'
    })).toThrowError('Invalid refreshedAt: expected a valid date');
    expect(() => saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: 'bad-analysis', analyzerVersion: 'lyrics-v1', lyricHash: null,
      profile: calmProfile, confidence: calmConfidence,
      evidence: calmAssessment.evidence, extractionSummary: {},
      analysisModel: 'test-model', lyricRefreshedAt: 'still-not-a-date'
    })).toThrowError('Invalid lyricRefreshedAt: expected a valid date');
  });

  it('returns null semantic fields instead of throwing for invalid database JSON', async () => {
    const { getDb } = await import('../../src/server/store/db.js');
    const {
      getMusicTrackAnalysisCache,
      recordMusicTrackLyricRefresh
    } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'corrupt', lyricStatus: 'available', lyricHash: 'hash-a',
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    getDb().prepare(
      `UPDATE music_track_analysis_cache
       SET profile_json = ?, confidence_json = ?, evidence_json = ?, extraction_summary_json = ?
       WHERE provider = ? AND track_id = ?`
    ).run(
      '{bad json',
      '{"genres":2}',
      '[{"claim":"x","source":"bad"}]',
      '[]',
      'ncm',
      'corrupt'
    );

    expect(() => getMusicTrackAnalysisCache('ncm', 'corrupt')).not.toThrow();
    expect(getMusicTrackAnalysisCache('ncm', 'corrupt')).toMatchObject({
      profile: null,
      confidence: null,
      evidence: [],
      extractionSummary: {}
    });
  });

  it('keeps the appended migration idempotent', async () => {
    const { _resetDbForTest, getDb, initDb } = await import('../../src/server/store/db.js');
    _resetDbForTest();
    initDb();
    _resetDbForTest();
    initDb();

    const row = getDb().prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name = 'music_track_analysis_cache'`
    ).get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('upgrades a schema-version 17 cache table without losing existing rows', async () => {
    const { _resetDbForTest, getDb, initDb } = await import('../../src/server/store/db.js');
    _resetDbForTest();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const legacyDb = new Database(path.join(dataDir, 'state.db'));
    legacyDb.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '17');
      CREATE TABLE music_track_analysis_cache (
        provider                TEXT NOT NULL,
        track_id                TEXT NOT NULL,
        analyzer_version        TEXT,
        lyric_status            TEXT NOT NULL DEFAULT 'unknown',
        lyric_hash              TEXT,
        profile_json            TEXT,
        evidence_json           TEXT,
        extraction_summary_json TEXT NOT NULL DEFAULT '{}',
        analysis_model          TEXT,
        last_lyric_refresh_at   TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (provider, track_id)
      );
      INSERT INTO music_track_analysis_cache (provider, track_id, lyric_status)
      VALUES ('ncm', 'legacy-track', 'missing');
    `);
    legacyDb.close();

    initDb();

    const columns = getDb().prepare(`PRAGMA table_info(music_track_analysis_cache)`).all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain('confidence_json');
    expect(getDb().prepare(
      `SELECT lyric_status FROM music_track_analysis_cache
       WHERE provider = 'ncm' AND track_id = 'legacy-track'`
    ).get()).toEqual({ lyric_status: 'missing' });
  });
});
