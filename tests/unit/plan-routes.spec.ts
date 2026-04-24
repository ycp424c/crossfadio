import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGapFillHandler } from '../../src/server/http/routes/plan';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plan-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'user'), { recursive: true });
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
  it('gap-fill resolves tracks from matched playlist details', async () => {
    writePlaylists();
    const ncmClient = {
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
