import { afterEach, describe, expect, it, vi } from 'vitest';
import { NcmApiError, NcmClient } from '../../src/server/ncm/client';
import { NCM_ERROR_CODE } from '../../src/shared/schema';

function mockFetch(handler: (url: URL, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return handler(url, init);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
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
            { id: 101, name: 'Song A', dt: 210_000, ar: [{ name: 'Alice' }] },
            { id: 102, name: 'Song B', dt: 180_000, ar: [{ name: 'Bob' }, { name: 'Carol' }] }
          ]
        }),
        { status: 200 }
      );
    });
    const client = new NcmClient('http://127.0.0.1:3000');

    expect(await client.getSongDetails(['101', '102'])).toEqual([
      { id: 101, name: 'Song A', artists: ['Alice'], durationMs: 210_000 },
      { id: 102, name: 'Song B', artists: ['Bob', 'Carol'], durationMs: 180_000 }
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
