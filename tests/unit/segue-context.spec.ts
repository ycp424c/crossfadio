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

  it('preserves filler lines in the legacy segue excerpt and keyword source', () => {
    const context = buildSegueTrackContext({
      track: { id: 'legacy-filler', name: 'Song', artist: 'Artist' },
      lyric: {
        id: 'legacy-filler',
        lyric: '[00:00]...\n[00:01]（纯音乐）\n[00:02]正文',
        translation: null
      }
    });

    expect(context.lyricExcerpt).toBe('... / （纯音乐）');
    expect(context.lyricKeywords).toEqual(['纯音乐', '正文']);
  });

  it('preserves LRC metadata that the legacy segue cleaner treated as lyric text', () => {
    const context = buildSegueTrackContext({
      track: { id: 'legacy-lrc-metadata', name: 'Song', artist: 'Artist' },
      lyric: {
        id: 'legacy-lrc-metadata',
        lyric: '[ar:Artist]\n[00:01]正文',
        translation: null
      }
    });

    expect(context.lyricExcerpt).toBe('[ar:Artist] / 正文');
  });

  it('preserves credit aliases outside the legacy segue metadata list', () => {
    const context = buildSegueTrackContext({
      track: { id: 'legacy-vocals', name: 'Song', artist: 'Artist' },
      lyric: {
        id: 'legacy-vocals',
        lyric: 'Vocals: Alice\n[00:01]正文',
        translation: null
      }
    });

    expect(context.lyricExcerpt).toBe('Vocals: Alice / 正文');
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
