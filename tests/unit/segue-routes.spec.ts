import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSegueAudioUrl, createSegueAudioHandler } from '../../src/server/http/routes/segue';
import { getTtsCacheDir } from '../../src/server/tts/cache';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-segue-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

function createFileResponse() {
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
    }),
    sendFile: vi.fn((_relativePath: string, _opts: unknown, cb?: (err?: Error) => void) => {
      cb?.();
      return res;
    })
  };
  return res;
}

describe('segue audio routes', () => {
  it('builds URL-safe audio paths for files nested under the TTS cache', () => {
    const filePath = path.join(getTtsCacheDir(), 'fallback', 'voice name', 'a b.mp3');

    expect(buildSegueAudioUrl(filePath)).toBe('/api/segue/audio/fallback/voice%20name/a%20b.mp3');
  });

  it('serves safe nested audio paths from the TTS cache root', () => {
    const handler = createSegueAudioHandler();
    const res = createFileResponse();

    handler({ params: { 0: 'fallback/alloy/audio.mp3' } } as never, res as never);

    expect(res.sendFile).toHaveBeenCalledWith(
      'fallback/alloy/audio.mp3',
      { root: getTtsCacheDir() },
      expect.any(Function)
    );
    expect(res.statusCode).toBe(200);
  });

  it('rejects unsafe audio paths before sendFile', () => {
    const handler = createSegueAudioHandler();
    const res = createFileResponse();

    handler({ params: { 0: '../secrets.json' } } as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid audio path' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });
});
