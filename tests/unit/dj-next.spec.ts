import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTrackDedupeKey,
  createDjPickNextHandler,
  searchCandidates,
  serializeDjPickNextErrorForLog
} from '../../src/server/http/routes/djNext';
import { parseDiscoveryMode } from '../../src/shared/dj';

describe('DJ v2 route contract', () => {
  it('keeps only explore and comfort discovery modes', () => {
    expect(parseDiscoveryMode('explore')).toBe('explore');
    expect(parseDiscoveryMode('comfort')).toBe('comfort');
    expect(parseDiscoveryMode('legacy')).toBe('explore');
  });

  it('searches candidates without selecting or mutating a queue', async () => {
    const searchSongs = vi.fn(async () => [
      { id: 1, name: 'Song A', artists: ['Artist A'] },
      { id: 2, name: 'Song B', artists: ['Artist B'] }
    ]);
    const candidates = await searchCandidates(
      ['city pop'],
      { searchSongs } as never,
      new Set(['1']),
      10
    );

    expect(candidates).toEqual([{ id: '2', name: 'Song B', artist: 'Artist B' }]);
    expect(searchSongs).toHaveBeenCalledWith('city pop', 10);
  });

  it('uses stable title and primary-artist dedupe keys', () => {
    expect(buildTrackDedupeKey({ name: '  Plastic Love ', artists: ['竹内まりや', 'Guest'] }))
      .toBe(buildTrackDedupeKey({ name: 'plastic love', artist: '竹内まりや' }));
  });

  it('serializes only stable operational fields and drops provider bodies', () => {
    const error = Object.assign(new Error('response body: PRIVATE PROMPT'), {
      status: 502,
      responseBody: '{"echo":"PRIVATE PDC"}',
      requestId: 'req-safe-42'
    });
    expect(serializeDjPickNextErrorForLog(error)).toEqual({
      code: 'provider_server_error',
      status: 502,
      requestId: 'req-safe-42'
    });
    expect(JSON.stringify(serializeDjPickNextErrorForLog(error))).not.toContain('PRIVATE');
  });

  it('rejects a queue-carrying pick-next request without an expected revision', () => {
    const handler = createDjPickNextHandler({
      secrets: {},
      ncmClient: {} as never
    });
    const response = createJsonResponse();

    handler({
      body: { queue: [{ id: 'stale' }], currentIndex: 0 },
      userId: 'revision-user'
    } as never, response as never, vi.fn());

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('rejects an oversized queue snapshot before starting pick-next', () => {
    const handler = createDjPickNextHandler({ secrets: {}, ncmClient: {} as never });
    const response = createJsonResponse();

    handler({
      body: {
        queue: Array.from({ length: 101 }, (_, index) => ({ id: `track-${index}` })),
        currentIndex: 0,
        revision: 0
      },
      userId: 'bounded-queue-user'
    } as never, response as never, vi.fn());

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid body' });
  });

  it('contains no removed selection route markers in production orchestration', () => {
    const source = fs.readFileSync(
      new URL('../../src/server/dj/pickNextRun.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/legacy_(?:llm_success|random_fallback)|music_agent_legacy_fallback/);
    expect(source).not.toContain("discoveryMode === 'legacy'");
  });
});

function createJsonResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    })
  };
  return response;
}
