import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plays-'));
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
    const id = startPlay({ songId: '123', songName: 'Test Song', artistName: 'Artist' });
    expect(id).toBeGreaterThan(0);
  });

  it('endPlay marks the row with reason and ended_at', async () => {
    const { startPlay, endPlay } = await import('../../src/server/store/plays');
    const id = startPlay({ songId: '456', songName: 'Another', artistName: 'DJ' });
    const updated = endPlay(id, 'completed');
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
    const updated = endPlay(9999, 'skip');
    expect(updated).toBe(false);
  });

  it('endPlay is idempotent — second call returns false', async () => {
    const { startPlay, endPlay } = await import('../../src/server/store/plays');
    const id = startPlay({ songId: '789', songName: 'Song', artistName: 'A' });
    endPlay(id, 'skip');
    const second = endPlay(id, 'error');
    expect(second).toBe(false);
  });

  it('getRecentPlays returns rows in descending order', async () => {
    const { startPlay, getRecentPlays } = await import('../../src/server/store/plays');
    startPlay({ songId: 'a', songName: 'First', artistName: 'A' });
    startPlay({ songId: 'b', songName: 'Second', artistName: 'B' });
    const rows = getRecentPlays(10);
    expect(rows.length).toBe(2);
    expect(rows[0].song_name).toBe('Second');
    expect(rows[1].song_name).toBe('First');
  });

  it('getRecentPlays respects the limit', async () => {
    const { startPlay, getRecentPlays } = await import('../../src/server/store/plays');
    for (let i = 0; i < 5; i++) {
      startPlay({ songId: String(i), songName: `Song ${i}`, artistName: 'X' });
    }
    const rows = getRecentPlays(3);
    expect(rows.length).toBe(3);
  });
});
