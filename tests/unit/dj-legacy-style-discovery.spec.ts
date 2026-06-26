import { describe, expect, it } from 'vitest';
import { parseLegacyStyleArtistResponse } from '../../src/server/dj/legacyStyleDiscovery';

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
});
