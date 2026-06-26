import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-16-chars';  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plays-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

describe('plays store', () => {
  it('startPlay returns a positive integer id', async () => {
    const { startPlay } = await import('../../src/server/store/plays');
    const id = startPlay('test-user', { songId: '123', songName: 'Test Song', artistName: 'Artist' });
    expect(id).toBeGreaterThan(0);
  });

  it('endPlay marks the row with reason and ended_at', async () => {
    const { startPlay, endPlay } = await import('../../src/server/store/plays');
    const id = startPlay('test-user', { songId: '456', songName: 'Another', artistName: 'DJ' });
    const updated = endPlay('test-user', id, 'completed');
    expect(updated).toBe(true);

    const db = new Database(path.join(dataDir, 'state.db'));
    const row = db.prepare('SELECT * FROM plays WHERE id = ?').get(id) as {
      end_reason: string;
      ended_at: string;
    };
    expect(row.end_reason).toBe('completed');
    expect(row.ended_at).toBeTruthy();
    db.close();
  });

  it('endPlay returns false for non-existent id', async () => {
    const { endPlay } = await import('../../src/server/store/plays');
    const updated = endPlay('test-user', 9999, 'skip');
    expect(updated).toBe(false);
  });

  it('endPlay is idempotent — second call returns false', async () => {
    const { startPlay, endPlay } = await import('../../src/server/store/plays');
    const id = startPlay('test-user', { songId: '789', songName: 'Song', artistName: 'A' });
    endPlay('test-user', id, 'skip');
    const second = endPlay('test-user', id, 'error');
    expect(second).toBe(false);
  });

  it('getRecentPlays returns rows in descending order', async () => {
    const { startPlay, getRecentPlays } = await import('../../src/server/store/plays');
    startPlay('test-user', { songId: 'a', songName: 'First', artistName: 'A' });
    startPlay('test-user', { songId: 'b', songName: 'Second', artistName: 'B' });
    const rows = getRecentPlays('test-user', 10);
    expect(rows.length).toBe(2);
    expect(rows[0].song_name).toBe('Second');
    expect(rows[1].song_name).toBe('First');
  });

  it('getRecentPlays respects the limit', async () => {
    const { startPlay, getRecentPlays } = await import('../../src/server/store/plays');
    for (let i = 0; i < 5; i++) {
      startPlay('test-user', { songId: String(i), songName: `Song ${i}`, artistName: 'X' });
    }
    const rows = getRecentPlays('test-user', 3);
    expect(rows.length).toBe(3);
  });

  it('getTodayPlayedSongIds returns only tracks played on the local day', async () => {
    const { getTodayPlayedSongIds } = await import('../../src/server/store/plays');
    const db = new Database(path.join(dataDir, 'state.db'));
    db.prepare(
      `INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, ?, datetime('now', '-1 day'))`
    ).run('test-user', 'yesterday-song', 'Yesterday', 'Artist');
    db.prepare(
      `INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run('test-user', 'today-song', 'Today', 'Artist');
    db.close();

    expect(getTodayPlayedSongIds('test-user')).toEqual(['today-song']);
  });
});
