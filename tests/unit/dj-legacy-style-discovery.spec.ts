import { describe, expect, it } from 'vitest';
import {
  buildLegacySearchQueries,
  discoverLegacyWebArtists,
  parseLegacyStyleArtistResponse
} from '../../src/server/dj/legacyStyleDiscovery';

describe('Legacy DJ style discovery', () => {
  it('parses fenced style and artist JSON while deduplicating artists case-insensitively', () => {
    const parsed = parseLegacyStyleArtistResponse(`\`\`\`json
{
  "styles": [
    {
      "style": " city pop ",
      "artists": [" Tatsuro Yamashita ", "tatsuro yamashita", "Anri", "This Artist Name Is Far Too Long To Be A Useful NCM Query Artist"]
    },
    {
      "style": "jazz piano",
      "artists": ["Bill Evans", "", 123]
    }
  ]
}
\`\`\``);

    expect(parsed).toEqual({
      styleConcepts: ['city pop', 'jazz piano'],
      llmArtists: ['Tatsuro Yamashita', 'Anri', 'Bill Evans']
    });
  });

  it('returns an empty result when the response has no JSON object', () => {
    expect(parseLegacyStyleArtistResponse('try indie folk and jazz piano')).toEqual({
      styleConcepts: [],
      llmArtists: []
    });
  });

  it('keeps malformed JSON as a parser failure for the existing LLM catch path', () => {
    expect(() => parseLegacyStyleArtistResponse('{"styles": [}')).toThrow(SyntaxError);
  });

  it('puts LLM artists first, dedupes web artists, and caps total queries', () => {
    const result = buildLegacySearchQueries({
      llmArtists: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
      webArtists: ['a2', 'W1', 'W2', 'W3', 'W4', 'W5'],
      styleConcepts: ['fallback style'],
      dailyTheme: null,
      directiveQueries: []
    });

    expect(result).toEqual({
      searchQueries: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'W1', 'W2', 'W3', 'W4'],
      themeKeywordsAdded: 0,
      usedStyleFallback: false
    });
  });

  it('mixes up to two theme keywords when admitted', () => {
    const result = buildLegacySearchQueries({
      llmArtists: ['A1'],
      webArtists: ['W1'],
      styleConcepts: [],
      dailyTheme: { keywords: ['A1', 'rain', 'city', 'night'] },
      directiveQueries: [],
      shouldIncludeThemeKeyword: () => true
    });

    expect(result).toEqual({
      searchQueries: ['A1', 'W1', 'rain', 'city'],
      themeKeywordsAdded: 2,
      usedStyleFallback: false
    });
  });

  it('front-loads directive queries and preserves the query cap', () => {
    const result = buildLegacySearchQueries({
      llmArtists: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
      webArtists: ['W1', 'W2', 'W3', 'W4'],
      styleConcepts: [],
      dailyTheme: null,
      directiveQueries: ['女声', '女歌手', 'female vocalist']
    });

    expect(result.searchQueries).toEqual(['女声', '女歌手', 'female vocalist', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'W1']);
  });

  it('falls back to style concepts when query names are too sparse', () => {
    const result = buildLegacySearchQueries({
      llmArtists: ['A1'],
      webArtists: [],
      styleConcepts: ['indie folk', 'jazz piano', 'city pop', 'ambient'],
      dailyTheme: null,
      directiveQueries: []
    });

    expect(result).toEqual({
      searchQueries: ['indie folk', 'jazz piano', 'city pop'],
      themeKeywordsAdded: 0,
      usedStyleFallback: true,
      styleFallbackSourceQueries: ['A1']
    });
  });

  it('discovers and deduplicates web artists while swallowing per-style failures', async () => {
    const calls: string[] = [];
    const artists = await discoverLegacyWebArtists(
      ['city pop', 'jazz piano', 'broken style'],
      async (style) => {
        calls.push(style);
        if (style === 'broken style') throw new Error('search failed');
        if (style === 'city pop') return ['Anri', 'Tatsuro Yamashita'];
        return ['anri', 'Bill Evans'];
      }
    );

    expect(calls).toEqual(['city pop', 'jazz piano', 'broken style']);
    expect(artists).toEqual(['Anri', 'Tatsuro Yamashita', 'Bill Evans']);
  });

  it('skips web artist search when there are no style concepts', async () => {
    const artists = await discoverLegacyWebArtists([], async () => {
      throw new Error('should not be called');
    });

    expect(artists).toEqual([]);
  });
});
