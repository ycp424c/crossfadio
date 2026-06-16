import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }
  });
}

describe('web search artist discovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('advances the MusicBrainz probability cursor for repeated style searches', async () => {
    const musicBrainzOffsets: string[] = [];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'musicbrainz.org') {
        const limit = url.searchParams.get('limit') ?? '';
        const offset = url.searchParams.get('offset') ?? '';
        if (limit === '1') return jsonResponse({ count: 100 });
        musicBrainzOffsets.push(offset);
        return jsonResponse({
          artists: Array.from({ length: 20 }, (_, index) => ({
            name: `MB Artist ${offset}-${index}`
          }))
        });
      }

      return jsonResponse({ query: { search: [] } });
    }));

    const { searchArtistsForStyle } = await import('../../src/server/web-search.js');

    const first = await searchArtistsForStyle('cantopop');
    const second = await searchArtistsForStyle('cantopop');

    expect(new Set(musicBrainzOffsets).size).toBeGreaterThan(1);
    expect(musicBrainzOffsets).not.toEqual(['0', '0']);
    expect(first).not.toEqual(second);
  });

  it('rotates Wikipedia list windows for repeated style searches', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'musicbrainz.org') {
        return jsonResponse(url.searchParams.get('limit') === '1' ? { count: 0 } : { artists: [] });
      }
      if (url.searchParams.get('list') === 'search') {
        return jsonResponse({
          query: {
            search: [{ title: 'List of cantopop artists', snippet: 'Cantopop artists' }]
          }
        });
      }
      if (url.searchParams.get('prop') === 'links') {
        return jsonResponse({
          query: {
            pages: {
              '1': {
                links: Array.from({ length: 25 }, (_, index) => ({
                  title: `Cantopop Artist ${index}`
                }))
              }
            }
          }
        });
      }

      return jsonResponse({});
    }));

    const { searchArtistsForStyle } = await import('../../src/server/web-search.js');

    const first = await searchArtistsForStyle('cantopop');
    const second = await searchArtistsForStyle('cantopop');

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first).not.toEqual(second);
  });
});
