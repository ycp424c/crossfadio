import { describe, expect, it } from 'vitest';
import { buildSegueTrackContext, extractTagsFromWikiSummary } from '../../src/server/agent/segue-context';

describe('extractTagsFromWikiSummary', () => {
  it('extracts style/tag names from nested wiki payload', () => {
    const wiki = {
      data: {
        styleTagList: [
          { tagName: '独立流行' },
          { tagName: '电子' }
        ],
        meta: {
          genre: {
            name: 'Dream Pop'
          }
        }
      }
    };

    const tags = extractTagsFromWikiSummary(wiki);
    expect(tags).toContain('独立流行');
    expect(tags).toContain('电子');
    expect(tags).toContain('Dream Pop');
  });
});

describe('buildSegueTrackContext', () => {
  it('builds context from detail + lyric + wiki tags', () => {
    const context = buildSegueTrackContext({
      track: { id: '1' },
      detail: { id: 1, name: 'Song A', artists: ['Artist A'] },
      lyric: {
        id: '1',
        lyric: '[00:10.00]雨滴落在窗沿上\n[00:20.00]我在夜色里等你\n',
        translation: null
      },
      wikiSummary: {
        profile: {
          tags: ['流行', '伤感']
        }
      }
    });

    expect(context.name).toBe('Song A');
    expect(context.artist).toBe('Artist A');
    expect(context.lyricExcerpt).toContain('雨滴落在窗沿上');
    expect(context.tags).toContain('流行');
  });

  it('falls back gracefully when external metadata is missing', () => {
    const context = buildSegueTrackContext({
      track: { id: '2', name: 'Song B', artist: 'Artist B' },
      detail: null,
      lyric: null,
      wikiSummary: null
    });

    expect(context.name).toBe('Song B');
    expect(context.artist).toBe('Artist B');
    expect(context.lyricExcerpt).toBe('');
    expect(Array.isArray(context.tags)).toBe(true);
  });
});
