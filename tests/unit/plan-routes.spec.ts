import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../src/server/store/db';
import { buildPlanFragments, createGapFillHandler } from '../../src/server/http/routes/plan';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  vi.resetModules();
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-16-chars';
  // Mock weather to avoid real network calls in unit tests
  vi.mock('../../src/server/weather', () => ({
    fetchWeather: vi.fn().mockResolvedValue({ tempC: 25, desc: '晴' })
  }));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plan-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'user'), { recursive: true });
  initDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

function writePlaylists(): void {
  fs.writeFileSync(
    path.join(dataDir, 'user', 'playlists.json'),
    JSON.stringify([
      {
        id: '12345',
        name: 'Morning Focus',
        provider: 'ncm',
        segments: ['morning'],
        tags: ['calm'],
        energyRange: [20, 60],
        priority: 1
      }
    ]),
    'utf-8'
  );
}

function createJsonResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  };
  return res;
}

describe('plan routes', () => {
  it('plan fragments include user taste and NCM liked tracks', async () => {
    writePlaylists();
    fs.writeFileSync(path.join(dataDir, 'user', 'taste.md'), '偏好：dream pop 和女声', 'utf-8');
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['101']),
      getSongDetails: vi.fn().mockResolvedValue([
        { id: 101, name: 'Sweet Disposition', artists: ['The Temper Trap'], durationMs: 180_000 }
      ])
    };

    const fragments = await buildPlanFragments('test-user', '2026-04-24', ncmClient as never);

    expect(fragments.corpus.taste).toContain('dream pop');
    expect(ncmClient.getLikedSongIds).toHaveBeenCalled();
    expect(fragments.corpus.likedTracks).toEqual([
      { id: '101', name: 'Sweet Disposition', artist: 'The Temper Trap' }
    ]);
  });

  it('gap-fill prefers liked tracks before generic playlist picks', async () => {
    writePlaylists();
    const ncmClient = {
      getLikedSongIds: vi.fn().mockResolvedValue(['201']),
      getSongDetails: vi.fn().mockResolvedValue([
        { id: 201, name: 'Favorite Song', artists: ['Favorite Artist'], durationMs: 200_000 }
      ]),
      getPlaylistDetail: vi.fn(),
      searchSongs: vi.fn()
    };
    const handler = createGapFillHandler({ secrets: {} as never, ncmClient: ncmClient as never });
    const res = createJsonResponse();

    await handler({ body: { segmentId: 'morning', count: 1 } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      tracks: [{ query: 'Favorite Song — Favorite Artist', ncmId: '201' }]
    });
    expect(ncmClient.getPlaylistDetail).not.toHaveBeenCalled();
  });

  it('gap-fill resolves tracks from matched playlist details', async () => {
    writePlaylists();
    const ncmClient = {
      // No liked tracks → falls through to playlist picks
      getLikedSongIds: vi.fn().mockResolvedValue([]),
      getSongDetails: vi.fn().mockResolvedValue([]),
      getPlaylistDetail: vi.fn().mockResolvedValue({
        id: 12345,
        name: 'Morning Focus',
        coverImgUrl: null,
        trackCount: 2,
        tracks: [
          { id: 101, name: 'First Song', artists: ['Artist A'], durationMs: 180_000 },
          { id: 102, name: 'Second Song', artists: ['Artist B'], durationMs: 210_000 }
        ]
      }),
      searchSongs: vi.fn()
    };
    const handler = createGapFillHandler({ secrets: {} as never, ncmClient: ncmClient as never });
    const res = createJsonResponse();

    await handler({ body: { segmentId: 'morning', count: 2 } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(ncmClient.getPlaylistDetail).toHaveBeenCalledWith('12345');
    expect(ncmClient.searchSongs).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      ok: true,
      tracks: [
        { query: 'First Song — Artist A', ncmId: '101' },
        { query: 'Second Song — Artist B', ncmId: '102' }
      ]
    });
  });
});
