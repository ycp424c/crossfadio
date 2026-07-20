import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runDataMigrations, runMigrations } from '../../src/server/store/migrations.js';

describe('legacy play data migration', () => {
  it('imports only the last ninety days with conservative Exposure overrides', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const insert = db.prepare(`
      INSERT INTO plays (
        user_id, song_id, song_name, artist_name, started_at, ended_at, end_reason
      ) VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now', ?), ?)
    `);
    insert.run('user-a', 'completed', 'Completed', 'Artist A', '-10 days', '-10 days', 'completed');
    insert.run('user-a', 'skipped', 'Skipped', 'Artist B', '-9 days', '-9 days', 'skip');
    insert.run('user-a', 'failed', 'Failed', 'Artist C', '-8 days', '-8 days', 'error');
    insert.run('user-a', 'open', 'Open', 'Artist D', '-7 days', '-7 days', null);
    insert.run('user-a', 'too-old', 'Old', 'Artist E', '-100 days', '-100 days', 'completed');

    runDataMigrations(db);
    runDataMigrations(db);

    const rows = db.prepare(`
      SELECT track_id, outcome, protocol_version, legacy_exposure_override
      FROM listening_episodes
      ORDER BY track_id
    `).all();
    expect(rows).toEqual([
      {
        track_id: 'completed',
        outcome: 'completed',
        protocol_version: 0,
        legacy_exposure_override: 1
      },
      {
        track_id: 'failed',
        outcome: 'failed',
        protocol_version: 0,
        legacy_exposure_override: 0.25
      },
      {
        track_id: 'open',
        outcome: 'interrupted',
        protocol_version: 0,
        legacy_exposure_override: 0.25
      },
      {
        track_id: 'skipped',
        outcome: 'skipped',
        protocol_version: 0,
        legacy_exposure_override: 0.25
      }
    ]);
    const timestamps = db.prepare(`
      SELECT id, started_at, last_checkpoint_at, ended_at
      FROM listening_episodes
      WHERE id LIKE 'legacy-play-%'
      ORDER BY track_id
    `).all() as Array<{
      id: string;
      started_at: string;
      last_checkpoint_at: string;
      ended_at: string;
    }>;
    expect(timestamps).toHaveLength(4);
    for (const timestamp of timestamps) {
      expect(timestamp.id).toMatch(/^legacy-play-\d+$/);
      expect(timestamp.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(timestamp.last_checkpoint_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(timestamp.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    db.close();
  });
});
