import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn()
}));

vi.mock('../../src/server/logger', () => ({
  getLogger: () => mockLogger
}));

import {
  NCM_SONG_URL_QUALITY_CACHE_TTL_MS,
  NCM_SONG_URL_QUALITY_LEVELS,
  NcmApiError,
  NcmClient,
  type NcmSongUrlQualityCache
} from '../../src/server/ncm/client';
import { NCM_ERROR_CODE } from '../../src/shared/schema';

function mockFetch(handler: (url: URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return handler(url, init);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockLogger.warn.mockClear();
});

describe('NcmClient error classification', () => {
  it('throws COOKIE_EXPIRED on HTTP 301', async () => {
    mockFetch(async () =>
      new Response(null, { status: 301 })
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.getLoginStatus()).rejects.toMatchObject({
      name: 'NcmApiError',
      code: NCM_ERROR_CODE.COOKIE_EXPIRED
    });
  });

  it('throws RATE_LIMITED on HTTP 429', async () => {
    mockFetch(async () => new Response(null, { status: 429 }));
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.getLoginStatus()).rejects.toMatchObject({
      code: NCM_ERROR_CODE.RATE_LIMITED
    });
  });

  it('throws UNAVAILABLE on HTTP 5xx', async () => {
    mockFetch(async () => new Response('', { status: 502 }));
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.getLyric('42')).rejects.toMatchObject({
      code: NCM_ERROR_CODE.UNAVAILABLE
    });
  });

  it('throws TIMEOUT when fetch aborts', async () => {
    mockFetch(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new NcmClient('http://127.0.0.1:3000', { fetchTimeoutMs: 5 });

    await expect(client.getLyric('42')).rejects.toMatchObject({
      code: NCM_ERROR_CODE.TIMEOUT
    });
  });

  it('throws BAD_RESPONSE when qr/key payload missing', async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.createLoginQr()).rejects.toMatchObject({
      code: NCM_ERROR_CODE.BAD_RESPONSE
    });
  });

  it('classifies network failures as UNAVAILABLE', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.getLyric('42')).rejects.toBeInstanceOf(NcmApiError);
    await expect(client.getLyric('42')).rejects.toMatchObject({
      code: NCM_ERROR_CODE.UNAVAILABLE
    });
  });
});

describe('NcmClient qr check', () => {
  it('returns raw code/message/cookie for valid response', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ code: 802, message: 'scanned', cookie: null }), { status: 200 })
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    const result = await client.checkLoginQr('k');

    expect(result).toEqual({ code: 802, message: 'scanned', cookie: null });
  });

  it('throws BAD_RESPONSE when code is non-numeric', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ code: 'bad', message: '' }), { status: 200 })
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.checkLoginQr('k')).rejects.toMatchObject({
      code: NCM_ERROR_CODE.BAD_RESPONSE
    });
  });
});

describe('NcmClient DTO mapping', () => {
  it('maps /cloudsearch response into NcmSong[]', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          result: {
            songs: [
              { id: 1, name: '夜曲', ar: [{ name: '周杰伦' }] },
              { id: 2, name: 'La Vie en rose', ar: [{ name: 'Edith Piaf' }, { name: 'Louiguy' }] }
            ]
          }
        }),
        { status: 200 }
      )
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    const songs = await client.searchSongs('夜曲');

    expect(songs).toEqual([
      { id: 1, name: '夜曲', artists: ['周杰伦'] },
      { id: 2, name: 'La Vie en rose', artists: ['Edith Piaf', 'Louiguy'] }
    ]);
  });

  it('maps /song/url/v1 response into NcmSongUrl', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 42,
              url: 'https://music/42.m4a',
              br: 320000,
              size: 8_000_000,
              type: 'm4a',
              expi: 1800
            }
          ]
        }),
        { status: 200 }
      )
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    const result = await client.getSongUrl('42');

    expect(result).toEqual({
      id: 42,
      url: 'https://music/42.m4a',
      br: 320000,
      size: 8_000_000,
      type: 'm4a',
      expireAt: 1800
    });
  });

  it('starts song URL quality probing at lossless', async () => {
    const requestedLevels: string[] = [];
    mockFetch(async (url) => {
      requestedLevels.push(url.searchParams.get('level') ?? '');
      return new Response(
        JSON.stringify({
          data: [{ id: 42, url: 'https://music/42.flac', br: 999000, size: 12_000_000, type: 'flac' }]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    await client.getSongUrl('42');

    expect(requestedLevels[0]).toBe('lossless');
  });

  it('falls back from highest song URL quality and caches the successful level per user', async () => {
    const requestedLevels: string[] = [];
    const cache: NcmSongUrlQualityCache = new Map();
    mockFetch(async (url) => {
      const level = url.searchParams.get('level') ?? '';
      requestedLevels.push(level);
      const id = Number(url.searchParams.get('id'));
      return new Response(
        JSON.stringify({
          data: [
            level === 'exhigh'
              ? { id, url: `https://music/${id}.m4a`, br: 320000, size: 8_000_000, type: 'm4a' }
              : { id, url: null, br: null, size: null, type: null }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000', { songUrlQualityCache: cache });

    const result = await client.getSongUrl('42', { qualityCacheKey: 'user-1', nowMs: 1_000 });

    expect(result).toMatchObject({
      id: 42,
      url: 'https://music/42.m4a',
      br: 320000,
      type: 'm4a'
    });
    expect(requestedLevels).toEqual(
      NCM_SONG_URL_QUALITY_LEVELS.slice(0, NCM_SONG_URL_QUALITY_LEVELS.indexOf('exhigh') + 1)
    );

    requestedLevels.length = 0;
    await client.getSongUrl('43', { qualityCacheKey: 'user-1', nowMs: 2_000 });

    expect(requestedLevels[0]).toBe('exhigh');
  });

  it('expires cached song URL quality after one day', async () => {
    const requestedLevels: string[] = [];
    const cache: NcmSongUrlQualityCache = new Map();
    mockFetch(async (url) => {
      const level = url.searchParams.get('level') ?? '';
      requestedLevels.push(level);
      const id = Number(url.searchParams.get('id'));
      return new Response(
        JSON.stringify({
          data: [
            level === 'exhigh'
              ? { id, url: `https://music/${id}.flac`, br: 1_411_000, size: 18_000_000, type: 'flac' }
              : { id, url: null }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000', { songUrlQualityCache: cache });

    await client.getSongUrl('42', { qualityCacheKey: 'user-1', nowMs: 1_000 });
    requestedLevels.length = 0;

    await client.getSongUrl('43', {
      qualityCacheKey: 'user-1',
      nowMs: 1_000 + NCM_SONG_URL_QUALITY_CACHE_TTL_MS - 1
    });
    expect(requestedLevels[0]).toBe('exhigh');
    requestedLevels.length = 0;

    await client.getSongUrl('44', {
      qualityCacheKey: 'user-1',
      nowMs: 1_000 + NCM_SONG_URL_QUALITY_CACHE_TTL_MS + 1
    });
    expect(requestedLevels[0]).toBe(NCM_SONG_URL_QUALITY_LEVELS[0]);
  });

  it('keeps cached song URL quality isolated by user', async () => {
    const requestedLevelsBySong = new Map<string, string[]>();
    const cache: NcmSongUrlQualityCache = new Map();
    mockFetch(async (url) => {
      const id = url.searchParams.get('id') ?? '';
      const level = url.searchParams.get('level') ?? '';
      requestedLevelsBySong.set(id, [...(requestedLevelsBySong.get(id) ?? []), level]);
      return new Response(
        JSON.stringify({
          data: [
            level === 'lossless'
              ? { id: Number(id), url: `https://music/${id}.flac`, br: 999000, size: 12_000_000, type: 'flac' }
              : { id: Number(id), url: null }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000', { songUrlQualityCache: cache });

    await client.getSongUrl('42', { qualityCacheKey: 'user-1', nowMs: 1_000 });
    await client.getSongUrl('43', { qualityCacheKey: 'user-2', nowMs: 2_000 });

    expect(requestedLevelsBySong.get('43')?.[0]).toBe(NCM_SONG_URL_QUALITY_LEVELS[0]);
  });

  it('bounds song URL quality fallback by the fetch timeout budget', async () => {
    vi.useFakeTimers();
    const requestedLevels: string[] = [];
    mockFetch(async (url, init) => {
      const level = url.searchParams.get('level') ?? '';
      requestedLevels.push(level);
      const id = Number(url.searchParams.get('id'));
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                data: [
                  level === 'standard'
                    ? { id, url: `https://music/${id}.m4a`, br: 192_000, size: 4_000_000, type: 'm4a' }
                    : { id, url: null }
                ]
              }),
              { status: 200 }
            )
          );
        }, 30);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new NcmClient('http://127.0.0.1:3000', { fetchTimeoutMs: 50 });

    const result = client.getSongUrl('42');
    const assertion = expect(result).rejects.toMatchObject({ code: NCM_ERROR_CODE.TIMEOUT });
    await vi.advanceTimersByTimeAsync(300);

    await assertion;
    expect(requestedLevels).toEqual(['lossless', 'exhigh']);
  });

  it('logs when malformed song URL payload falls back to a lower quality', async () => {
    const requestedLevels: string[] = [];
    mockFetch(async (url) => {
      const level = url.searchParams.get('level') ?? '';
      requestedLevels.push(level);
      const id = Number(url.searchParams.get('id'));
      return new Response(
        JSON.stringify(
          level === 'lossless'
            ? { data: [{ id: 'bad', url: null }] }
            : { data: [{ id, url: `https://music/${id}.flac`, br: 999_000, size: 12_000_000, type: 'flac' }] }
        ),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.getSongUrl('42')).resolves.toMatchObject({
      id: 42,
      url: 'https://music/42.flac'
    });

    expect(requestedLevels).toEqual(['lossless', 'exhigh']);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '42',
        level: 'lossless',
        code: NCM_ERROR_CODE.BAD_RESPONSE
      }),
      'NCM song URL quality fallback after bad response'
    );
  });

  it('returns null when /song/url/v1 data is empty', async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getSongUrl('42')).toBeNull();
  });

  it('maps /lyric response including translation', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          lrc: { lyric: '[00:00]hello' },
          tlyric: { lyric: '[00:00]你好' }
        }),
        { status: 200 }
      )
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    const result = await client.getLyric('42');

    expect(result).toEqual({
      id: '42',
      lyric: '[00:00]hello',
      translation: '[00:00]你好'
    });
  });

  it('returns null when /lyric lrc.lyric is empty', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ lrc: { lyric: '' } }), { status: 200 })
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getLyric('42')).toBeNull();
  });

  it('maps /playlist/detail response into NcmPlaylistDetail', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          playlist: {
            id: 7,
            name: '晨间跑步',
            coverImgUrl: 'https://cover',
            trackCount: 2,
            tracks: [
              { id: 101, name: 'Track One', dt: 210_000, ar: [{ name: 'Alice' }] },
              { id: 102, name: 'Track Two', dt: 185_000, ar: [{ name: 'Bob' }, { name: 'Carol' }] }
            ]
          }
        }),
        { status: 200 }
      )
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    const result = await client.getPlaylistDetail('7');

    expect(result).toEqual({
      id: 7,
      name: '晨间跑步',
      coverImgUrl: 'https://cover',
      trackCount: 2,
      tracks: [
        { id: 101, name: 'Track One', artists: ['Alice'], durationMs: 210_000 },
        { id: 102, name: 'Track Two', artists: ['Bob', 'Carol'], durationMs: 185_000 }
      ]
    });
  });

  it('maps /likelist response into liked song ids using login profile user id', async () => {
    mockFetch(async (url) => {
      if (url.pathname === '/login/status') {
        return new Response(JSON.stringify({ data: { profile: { userId: 10001 } } }), { status: 200 });
      }
      if (url.pathname === '/likelist') {
        expect(url.searchParams.get('uid')).toBe('10001');
        return new Response(JSON.stringify({ ids: [101, 102, 103] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getLikedSongIds()).toEqual(['101', '102', '103']);
  });

  it('maps /song/detail response into NcmPlaylistTrack[]', async () => {
    mockFetch(async (url) => {
      expect(url.pathname).toBe('/song/detail');
      expect(url.searchParams.get('ids')).toBe('101,102');
      return new Response(
        JSON.stringify({
          songs: [
            {
              id: 101,
              name: 'Song A',
              dt: 210_000,
              ar: [{ name: 'Alice' }],
              al: { name: 'Album A', picUrl: 'https://img/101.jpg' },
              pop: 120,
              fee: 8,
              copyright: 2,
              noCopyrightRcmd: { songId: 201 },
              privilege: { st: -200, toast: true },
              originCoverType: 2,
              publishTime: 1_700_000_000_000,
              mv: 12345
            },
            { id: 102, name: 'Song B', dt: 180_000, ar: [{ name: 'Bob' }, { name: 'Carol' }], al: { picUrl: 'https://img/102.jpg' } }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getSongDetails(['101', '102'])).toEqual([
      {
        id: 101,
        name: 'Song A',
        artists: ['Alice'],
        durationMs: 210_000,
        coverImgUrl: 'https://img/101.jpg',
        qualitySignals: {
          popularity: 100,
          fee: 8,
          copyright: 2,
          noCopyrightRcmd: true,
          privilegeSt: -200,
          privilegeToast: true,
          albumName: 'Album A',
          originCoverType: 2,
          publishTime: 1_700_000_000_000,
          mv: true
        }
      },
      { id: 102, name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000, coverImgUrl: 'https://img/102.jpg' }
    ]);
  });

  it('searches artists through /cloudsearch type 100', async () => {
    mockFetch(async (url) => {
      expect(url.pathname).toBe('/cloudsearch');
      expect(url.searchParams.get('keywords')).toBe('具島直子');
      expect(url.searchParams.get('type')).toBe('100');
      expect(url.searchParams.get('limit')).toBe('5');
      return new Response(
        JSON.stringify({
          result: {
            artists: [
              { id: 301, name: '具島直子' },
              { id: 302, name: '' }
            ]
          }
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.searchArtists('具島直子', 5)).toEqual([
      { id: 301, name: '具島直子' }
    ]);
  });

  it('fetches artist top songs as playable tracks', async () => {
    mockFetch(async (url) => {
      expect(url.pathname).toBe('/artist/top/song');
      expect(url.searchParams.get('id')).toBe('301');
      return new Response(
        JSON.stringify({
          songs: [
            { id: 401, name: 'Candy', dt: 260_000, ar: [{ name: '具島直子' }], al: { picUrl: 'https://img/candy.jpg' } }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getArtistTopSongs('301')).toEqual([
      { id: 401, name: 'Candy', artists: ['具島直子'], durationMs: 260_000, coverImgUrl: 'https://img/candy.jpg' }
    ]);
  });

  it('searches albums and fetches album tracks', async () => {
    const paths: string[] = [];
    mockFetch(async (url) => {
      paths.push(url.pathname);
      if (url.pathname === '/cloudsearch') {
        expect(url.searchParams.get('keywords')).toBe('miss.G');
        expect(url.searchParams.get('type')).toBe('10');
        return new Response(
          JSON.stringify({
            result: {
              albums: [
                { id: 501, name: 'miss.G', artist: { name: '具島直子' } }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/album') {
        expect(url.searchParams.get('id')).toBe('501');
        return new Response(
          JSON.stringify({
            album: { id: 501, name: 'miss.G', artist: { name: '具島直子' } },
            songs: [
              { id: 601, name: 'Candy', dt: 260_000, ar: [{ name: '具島直子' }] }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.searchAlbums('miss.G', 3)).toEqual([
      { id: 501, name: 'miss.G', artist: '具島直子' }
    ]);
    expect(await client.getAlbumDetail('501')).toEqual({
      id: 501,
      name: 'miss.G',
      artist: '具島直子',
      tracks: [
        { id: 601, name: 'Candy', artists: ['具島直子'], durationMs: 260_000 }
      ]
    });
    expect(paths).toEqual(['/cloudsearch', '/album']);
  });

  it('fetches artist albums for album expansion', async () => {
    mockFetch(async (url) => {
      expect(url.pathname).toBe('/artist/album');
      expect(url.searchParams.get('id')).toBe('301');
      expect(url.searchParams.get('limit')).toBe('2');
      return new Response(
        JSON.stringify({
          hotAlbums: [
            { id: 501, name: 'miss.G', artist: { name: '具島直子' } },
            { id: 502, name: 'Quiet Emotion', artist: { name: '具島直子' } }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getArtistAlbums('301', 2)).toEqual([
      { id: 501, name: 'miss.G', artist: '具島直子' },
      { id: 502, name: 'Quiet Emotion', artist: '具島直子' }
    ]);
  });


  it('searches playlists through /cloudsearch type 1000', async () => {
    mockFetch(async (url) => {
      expect(url.pathname).toBe('/cloudsearch');
      expect(url.searchParams.get('keywords')).toBe('city pop');
      expect(url.searchParams.get('type')).toBe('1000');
      return new Response(
        JSON.stringify({
          result: {
            playlists: [
              { id: 701, name: 'City Pop Selection', trackCount: 42, coverImgUrl: 'https://cover/701.jpg' }
            ]
          }
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.searchPlaylists('city pop', 4)).toEqual([
      { id: 701, name: 'City Pop Selection', trackCount: 42, coverImgUrl: 'https://cover/701.jpg' }
    ]);
  });

  it('rejects malformed search payload as BAD_RESPONSE', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ result: { songs: [{ id: 'not-a-number', name: 'x' }] } }),
        { status: 200 }
      )
    );
    const client = new NcmClient('http://127.0.0.1:3000');

    await expect(client.searchSongs('x')).rejects.toMatchObject({
      code: NCM_ERROR_CODE.BAD_RESPONSE
    });
  });
});
