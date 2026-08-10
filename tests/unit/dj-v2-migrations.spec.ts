import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { runDataMigrations, runMigrations } from '../../src/server/store/migrations';
import { LISTENING_EPISODE_DAILY_LIMIT } from '../../src/shared/listening';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('DJ v2 additive migrations', () => {
  it('adds Listening Episodes without removing the rollback plays table', () => {
    runMigrations(db);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);

    expect(names).toContain('listening_episodes');
    expect(names).toContain('plays');
  });

  it('enforces the Listening Episode UTC-day quota at the database boundary', () => {
    runMigrations(db);
    const insert = db.prepare(`
      INSERT INTO listening_episodes (
        id, user_id, client_episode_id, player_instance_id, deck_id,
        track_id, track_name, started_at, last_checkpoint_at
      ) VALUES (?, ?, ?, 'player', 'main', 'track', 'Song', ?, ?)
    `);
    const timestamp = '2026-07-17T12:00:00.000Z';
    db.transaction(() => {
      for (let index = 0; index < LISTENING_EPISODE_DAILY_LIMIT; index += 1) {
        insert.run(`id-${index}`, 'quota-user', `episode-${index}`, timestamp, timestamp);
      }
    })();

    expect(() => insert.run(
      'id-overflow', 'quota-user', 'episode-overflow', timestamp, timestamp
    )).toThrow(/listening_episode_daily_quota_exceeded/);
    expect(() => insert.run(
      'id-other-user', 'other-user', 'episode-overflow', timestamp, timestamp
    )).not.toThrow();
    expect(() => insert.run(
      'id-next-day', 'quota-user', 'episode-next-day',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
    )).not.toThrow();
  });

  it('adds every DJ v2 authoritative and projection store', () => {
    runMigrations(db);

    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));

    expect([...names]).toEqual(expect.arrayContaining([
      'preference_evidence',
      'preference_extraction_batches',
      'explicit_exclusions',
      'taste_profiles',
      'retrieval_attempts',
      'dj_configuration_entries',
      'selection_debug_traces',
      'selection_journeys',
      'selection_narration_outbox',
      'selection_replay_runs',
      'selection_policy_replay_cases',
      'explicit_exclusion_resolution_jobs',
      'queue_state_mutations'
    ]));
  });

  it('adds the resource tier governance tables', () => {
    runMigrations(db);

    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));

    expect(names).toContain('user_access_controls');
    expect(names).toContain('resource_usage_buckets');

    const accessColumns = db.prepare('PRAGMA table_info(user_access_controls)')
      .all() as Array<{ name: string }>;
    expect(accessColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'user_id',
      'status',
      'updated_at'
    ]));

    const bucketColumns = db.prepare('PRAGMA table_info(resource_usage_buckets)')
      .all() as Array<{ name: string }>;
    expect(bucketColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'user_id',
      'period_key',
      'credits_used',
      'updated_at'
    ]));
  });

  it('defines widened v2 states and aliases in the additive table creation', () => {
    runMigrations(db);

    const exclusionColumns = db.prepare('PRAGMA table_info(explicit_exclusions)')
      .all() as Array<{ name: string }>;
    const replayColumns = db.prepare('PRAGMA table_info(selection_replay_runs)')
      .all() as Array<{ name: string }>;
    expect(exclusionColumns.map((column) => column.name)).toContain('aliases_json');
    expect(replayColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'prompt_json_status',
      'narration_status',
      'narration_deadline_at'
    ]));

    const source = fs.readFileSync(path.join(process.cwd(), 'src/server/store/migrations.ts'), 'utf8');
    expect(source).not.toContain('DROP TABLE preference_extraction_batches');
    expect(source).not.toContain('DROP TABLE selection_journeys');
  });

  it('adds Personal DJ Context validity columns and global DJ event retention index', () => {
    runMigrations(db);

    const contextColumns = db.prepare(
      `PRAGMA table_info(personal_dj_contexts)`
    ).all() as Array<{ name: string }>;
    const eventIndexes = db.prepare(
      `PRAGMA index_list(dj_events)`
    ).all() as Array<{ name: string }>;

    expect(contextColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'generated_at',
      'expires_at'
    ]));
    expect(eventIndexes.map((index) => index.name)).toContain('idx_dj_events_created_retention');
  });

  it('backfills Personal DJ Context validity once through the TypeScript runner', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO personal_dj_contexts (
        id, user_id, payload_json, payload_hash, source_kind, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-1',
      'user-1',
      JSON.stringify({ generatedAt: '2026-07-17T08:00:00.000Z' }),
      'hash-1',
      'lifemesh_bundle',
      '2026-07-17T09:00:00.000Z'
    );

    runDataMigrations(db);
    runDataMigrations(db);

    expect(db.prepare(
      `SELECT generated_at, expires_at FROM personal_dj_contexts WHERE id = ?`
    ).get('ctx-1')).toEqual({
      generated_at: '2026-07-17T08:00:00.000Z',
      expires_at: '2026-07-18T08:00:00.000Z'
    });
    expect(db.prepare(
      `SELECT value FROM meta WHERE key = 'data_migration_version'`
    ).get()).toEqual({ value: '9' });
  });

  it('normalizes existing Listening Episode timestamps without destroying unparseable values', () => {
    runMigrations(db);
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('data_migration_version', '7')`
    ).run();
    const insert = db.prepare(`
      INSERT INTO listening_episodes (
        id, user_id, client_episode_id, player_instance_id, deck_id,
        track_id, track_name, started_at, last_checkpoint_at, ended_at
      ) VALUES (?, 'timestamp-user', ?, 'legacy-player', 'main', ?, ?, ?, ?, ?)
    `);
    insert.run(
      'legacy-timestamps',
      'legacy-timestamps',
      'legacy-track',
      'Legacy Song',
      '2026-07-17 10:11:12',
      '2026-07-17 10:12:13',
      '2026-07-17 10:13:14'
    );
    insert.run(
      'unparseable-timestamps',
      'unparseable-timestamps',
      'unparseable-track',
      'Unparseable Song',
      'not-a-timestamp',
      'still-not-a-timestamp',
      'also-not-a-timestamp'
    );

    runDataMigrations(db);
    runDataMigrations(db);

    expect(db.prepare(`
      SELECT id, started_at AS startedAt, last_checkpoint_at AS lastCheckpointAt,
             ended_at AS endedAt
      FROM listening_episodes
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'legacy-timestamps',
        startedAt: '2026-07-17T10:11:12.000Z',
        lastCheckpointAt: '2026-07-17T10:12:13.000Z',
        endedAt: '2026-07-17T10:13:14.000Z'
      },
      {
        id: 'unparseable-timestamps',
        startedAt: 'not-a-timestamp',
        lastCheckpointAt: 'still-not-a-timestamp',
        endedAt: 'also-not-a-timestamp'
      }
    ]);
    expect(db.prepare(
      `SELECT value FROM meta WHERE key = 'data_migration_version'`
    ).get()).toEqual({ value: '9' });
  });

  it('runs data migrations after schema migration during database initialization', () => {
    const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-v2-migration-'));
    _resetDbForTest();
    process.env.CROSSFADIO_DATA_DIR = dataDir;

    try {
      const initialized = initDb();
      expect(initialized.prepare(
        `SELECT value FROM meta WHERE key = 'data_migration_version'`
      ).get()).toEqual({ value: '9' });
    } finally {
      _resetDbForTest();
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
      else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
    }
  });

  it('keeps the removed legacy discovery value intact for branch rollback', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO prefs (user_id, key, value_json) VALUES (?, 'discovery.mode', ?)`
    ).run('user-legacy', JSON.stringify('legacy'));

    runDataMigrations(db);

    expect(db.prepare(
      `SELECT value_json FROM prefs WHERE user_id = ? AND key = 'discovery.mode'`
    ).get('user-legacy')).toEqual({ value_json: JSON.stringify('legacy') });
  });

  it('migrates legacy ban prefs into authoritative explicit exclusions once', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`
    ).run('legacy-ban-user', 'ban.artist.Radiohead', JSON.stringify(true), '2026-07-16 10:00:00');
    db.prepare(
      `INSERT INTO prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`
    ).run('legacy-ban-user', 'ban.track.Creep___Radiohead', JSON.stringify(true), '2026-07-16 10:01:00');
    db.prepare(
      `INSERT INTO prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`
    ).run('legacy-ban-user', 'ban.track.Plastic Love___竹内まりや', JSON.stringify(true), '2026-07-16 10:02:00');
    db.prepare(
      `INSERT INTO prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)`
    ).run('legacy-ban-user', 'ban.artist.ＡＢＢＡ', JSON.stringify(true), '2026-07-16 10:03:00');

    runDataMigrations(db);
    runDataMigrations(db);

    expect(db.prepare(`
      SELECT entity_type AS entityType, entity_key AS entityKey, source_kind AS sourceKind
      FROM explicit_exclusions WHERE user_id = ? ORDER BY entity_type, entity_key
    `).all('legacy-ban-user')).toEqual([
      { entityType: 'artist', entityKey: 'abba', sourceKind: 'legacy_pref_migration' },
      { entityType: 'artist', entityKey: 'radiohead', sourceKind: 'legacy_pref_migration' },
      { entityType: 'track', entityKey: 'creep___radiohead', sourceKind: 'legacy_pref_migration' },
      { entityType: 'track', entityKey: 'plasticlove___竹内まりや', sourceKind: 'legacy_pref_migration' }
    ]);
  });

  it('normalizes existing preference identities and resolves Unicode-equivalent contradictions', () => {
    runMigrations(db);
    const insert = db.prepare(`
      INSERT INTO preference_evidence (
        id, user_id, evidence_kind, subject_type, subject_key, polarity, strength,
        confidence, source_kind, source_refs_json, observed_at, expires_at,
        extractor_version, superseded_by_id, payload_json, created_at, updated_at
      ) VALUES (?, 'preference-user', 'expressed', 'artist', ?, ?, 'strong', 1,
        'chat_extraction', ?, ?, NULL, 'v2', NULL, '{}', ?, ?)
    `);
    insert.run(
      'older', 'ＡＢＢＡ', 'negative', JSON.stringify([{ messageId: 1 }]),
      '2026-07-17T10:00:00.000Z', '2026-07-17T10:00:00.000Z', '2026-07-17T10:00:00.000Z'
    );
    insert.run(
      'newer', 'ABBA', 'positive', JSON.stringify([{ messageId: 2 }]),
      '2026-07-17T11:00:00.000Z', '2026-07-17T11:00:00.000Z', '2026-07-17T11:00:00.000Z'
    );

    runDataMigrations(db);

    expect(db.prepare(`
      SELECT id, subject_key AS subjectKey, superseded_by_id AS supersededById
      FROM preference_evidence WHERE user_id = ? ORDER BY id
    `).all('preference-user')).toEqual([
      { id: 'newer', subjectKey: 'abba', supersededById: null },
      { id: 'older', subjectKey: 'abba', supersededById: 'newer' }
    ]);
  });

  it('requeues locatable legacy chat sources and bounds orphan summaries to 60 days', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO messages (id, user_id, role, content, created_at, extracted_at)
       VALUES (?, ?, 'user', ?, ?, ?)`
    ).run(101, 'legacy-pref-user', '我喜欢 Radiohead', '2026-07-10 10:00:00', '2026-07-10 10:01:00');
    db.prepare(
      `INSERT INTO chat_preferences (id, user_id, summary, message_ids, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(201, 'legacy-pref-user', '近期偏好：喜欢 Radiohead', JSON.stringify([101]), '2026-07-10 10:02:00');
    db.prepare(
      `INSERT INTO chat_preferences (id, user_id, summary, message_ids, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(202, 'legacy-pref-user', '近期偏好：安静的器乐', JSON.stringify([999]), '2026-07-11 10:00:00');

    runDataMigrations(db);

    expect(db.prepare(`
      SELECT source_key AS sourceKey, message_ids_json AS messageIdsJson,
             extractor_version AS extractorVersion, status
      FROM preference_extraction_batches WHERE user_id = ?
    `).all('legacy-pref-user')).toEqual([{
      sourceKey: 'legacy-chat-preference:201',
      messageIdsJson: '[101]',
      extractorVersion: 'preference-extractor-v1',
      status: 'pending'
    }]);
    expect(db.prepare(`
      SELECT evidence_kind AS evidenceKind, subject_type AS subjectType,
             subject_key AS subjectKey, confidence, expires_at AS expiresAt
      FROM preference_evidence WHERE user_id = ?
    `).all('legacy-pref-user')).toEqual([{
      evidenceKind: 'inferred',
      subjectType: 'legacy_summary',
      subjectKey: '近期偏好:安静的器乐',
      confidence: 0.25,
      expiresAt: '2026-09-09T10:00:00.000Z'
    }]);
  });

  it('enforces retrieval idempotency inside one DJ run', () => {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO retrieval_attempts (
        id, user_id, run_id, source, request_kind, normalized_query, display_query, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'attempt-1', 'user-1', 'run-1', 'ncm_search', 'autonomous',
      'city pop', 'City Pop', '2026-07-17T10:00:00.000Z'
    );

    expect(() => insert.run(
      'attempt-2', 'user-1', 'run-1', 'ncm_search', 'autonomous',
      'city pop', 'city pop', '2026-07-17T10:00:01.000Z'
    )).toThrow();
  });
});
