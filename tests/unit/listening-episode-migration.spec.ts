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
    db.close();
  });
});
