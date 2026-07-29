import { describe, expect, it, vi } from 'vitest';
import {
  createNextHandler,
  createNowHandler,
  estimateDurationMs,
  parseQueueIds,
  pickNextTrackId
} from '../../src/server/http/routes/now-next';

describe('parseQueueIds', () => {
  it('parses csv queue and trims blanks', () => {
    expect(parseQueueIds('1, 2 , ,3')).toEqual(['1', '2', '3']);
  });
});

describe('pickNextTrackId', () => {
  it('returns first track when current missing', () => {
    expect(pickNextTrackId(['10', '11', '12'])).toBe('10');
  });

  it('returns next track after current', () => {
    expect(pickNextTrackId(['10', '11', '12'], '11')).toBe('12');
  });

  it('returns null at queue tail', () => {
    expect(pickNextTrackId(['10', '11'], '11')).toBeNull();
  });
});

describe('estimateDurationMs', () => {
  it('estimates duration from file size and bitrate', () => {
    expect(estimateDurationMs(8_000_000, 320_000)).toBe(200000);
  });

  it('returns null for invalid values', () => {
    expect(estimateDurationMs(null, 320_000)).toBeNull();
    expect(estimateDurationMs(8_000_000, null)).toBeNull();
    expect(estimateDurationMs(0, 320_000)).toBeNull();
    expect(estimateDurationMs(8_000_000, 0)).toBeNull();
  });
});

describe('now/next song URL quality cache key', () => {
  it('bypasses the upstream song URL cache for fresh recovery requests', async () => {
    const ncmClient = {
      getSongUrl: vi.fn(async () => ({
        id: 42,
        url: 'https://music/fresh-42.flac',
        br: 1_411_000,
        size: 18_000_000,
        type: 'flac',
        expireAt: 1800
      })),
      getLyric: vi.fn(async () => null),
      getSongDetails: vi.fn(async () => [])
    };
    const res = createResponse();

    await createNowHandler()(
      { query: { ncmId: '42', fresh: '1' }, userId: 'user-1', ncmClient } as never,
      res as never,
      vi.fn()
    );

    expect(ncmClient.getSongUrl).toHaveBeenCalledWith('42', {
      qualityCacheKey: 'user-1',
      bypassUpstreamCache: true
    });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it('passes request userId when resolving the current song URL', async () => {
    const ncmClient = {
      getSongUrl: vi.fn(async () => ({
        id: 42,
        url: 'https://music/42.flac',
        br: 1_411_000,
        size: 18_000_000,
        type: 'flac',
        expireAt: 1800
      })),
      getLyric: vi.fn(async () => null),
      getSongDetails: vi.fn(async () => [])
    };
    const res = createResponse();

    await createNowHandler()(
      { query: { ncmId: '42' }, userId: 'user-1', ncmClient } as never,
      res as never,
      vi.fn()
    );

    expect(ncmClient.getSongUrl).toHaveBeenCalledWith('42', { qualityCacheKey: 'user-1' });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it('passes request userId when resolving the next song URL', async () => {
    const ncmClient = {
      getSongUrl: vi.fn(async () => ({
        id: 43,
        url: 'https://music/43.flac',
        br: 1_411_000,
        size: 18_000_000,
        type: 'flac',
        expireAt: 1800
      })),
      getSongDetails: vi.fn(async () => [])
    };
    const res = createResponse();

    await createNextHandler()(
      { query: { queue: '42,43', current: '42' }, userId: 'user-1', ncmClient } as never,
      res as never,
      vi.fn()
    );

    expect(ncmClient.getSongUrl).toHaveBeenCalledWith('43', { qualityCacheKey: 'user-1' });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});

function createResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn()
  };
}
