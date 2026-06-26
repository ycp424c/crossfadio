import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const indexPlayedTrackMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/music-agent/entity-indexer.js', () => ({
  indexPlayedTrack: indexPlayedTrackMock
}));

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  indexPlayedTrackMock.mockReset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plays-routes-'));
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

describe('plays routes', () => {
  it('starts play and triggers immediate music entity backfill', async () => {
    const { createStartPlayHandler } = await import('../../src/server/http/routes/plays.js');
    const { req, res } = makeReqRes({
      userId: 'route-user',
      body: {
        songId: '909',
        songName: 'My Cookie Can',
        artistName: '卫兰'
      }
    });

    createStartPlayHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ ok: true, id: expect.any(Number) });
    expect(indexPlayedTrackMock).toHaveBeenCalledWith({
      userId: 'route-user',
      track: {
        songId: '909',
        songName: 'My Cookie Can',
        artistName: '卫兰'
      }
    });
  });
});

function makeReqRes(input: { userId: string; body: unknown }) {
  const req = {
    userId: input.userId,
    body: input.body
  } as Request & { userId: string };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn()
  } as unknown as Response;
  return { req, res };
}
