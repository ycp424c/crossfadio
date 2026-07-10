import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFinalSelectionResult,
  type FinalSelectionSkippedPick
} from '../../src/server/dj/finalSelectionResult';

describe('buildFinalSelectionResult', () => {
  it('owns the skipped-pick type without depending on a pick-next handler', () => {
    const source = readFileSync(
      new URL('../../src/server/dj/finalSelectionResult.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain('export type FinalSelectionSkippedPick');
    expect(source).not.toContain("from './musicAgentPickNextResult.js'");
  });

  it('builds the rationale only from normalized tracks and preserves separate proposed rationale', () => {
    const result = buildFinalSelectionResult({
      tracks: [
        {
          id: ' 101 ',
          name: '  春风十里  ',
          artist: '  鹿先森乐队 ',
          reason: '  衔接   当前氛围 ',
          source: ' music   agent '
        },
        {
          id: '102',
          name: '晚风',
          artist: '伍佰',
          reason: '延续节奏',
          source: 'legacy'
        }
      ],
      proposedRationale: '  原方案建议   卫兰《大哥》  '
    });

    expect(result.rationale).toBe('本次实际补充 2 首：鹿先森乐队《春风十里》、伍佰《晚风》。');
    expect(result.rationale).not.toContain('卫兰');
    expect(result.proposedRationale).toBe('原方案建议 卫兰《大哥》');
    expect(result.tracks).toEqual([
      {
        id: '101',
        name: '春风十里',
        artist: '鹿先森乐队',
        reason: '衔接 当前氛围',
        source: 'music agent'
      },
      {
        id: '102',
        name: '晚风',
        artist: '伍佰',
        reason: '延续节奏',
        source: 'legacy'
      }
    ]);
    expect(result.diagnostics).toEqual({ appendedCount: 2, skippedPicks: [] });
  });

  it('collapses whitespace and omits a blank artist', () => {
    const result = buildFinalSelectionResult({
      tracks: [
        {
          id: '  201  ',
          name: '  City\n  of   Stars ',
          artist: ' \t ',
          reason: '  calm\n transition ',
          source: '  curated   list '
        }
      ]
    });

    expect(result.rationale).toBe('本次实际补充 1 首：《City of Stars》。');
    expect(result.tracks[0]).toEqual({
      id: '201',
      name: 'City of Stars',
      reason: 'calm transition',
      source: 'curated list'
    });
  });

  it('uses the normalized id when the name is missing', () => {
    const result = buildFinalSelectionResult({
      tracks: [{ id: '  track-3  ', reason: ' reason ', source: ' source ' }]
    });

    expect(result.rationale).toBe('本次实际补充 1 首：《track-3》。');
    expect(result.tracks[0]?.name).toBe('track-3');
  });

  it('omits a blank proposed rationale and falls back from a blank name to the id', () => {
    const result = buildFinalSelectionResult({
      tracks: [{ id: 'track-4', name: ' \n ', reason: 'reason', source: 'source' }],
      proposedRationale: ' \t\n '
    });

    expect(result).not.toHaveProperty('proposedRationale');
    expect(result.tracks[0]?.name).toBe('track-4');
  });

  it('rejects an empty track list because the result represents a successful append', () => {
    expect(() => buildFinalSelectionResult({ tracks: [] })).toThrowError(
      'Final selection requires at least one appended track'
    );
  });

  it.each([
    ['id', { id: '   ', reason: 'reason', source: 'source' }],
    ['reason', { id: '1', reason: ' \n ', source: 'source' }],
    ['source', { id: '1', reason: 'reason', source: ' \t ' }]
  ] as const)('rejects a blank required %s', (field, track) => {
    expect(() => buildFinalSelectionResult({ tracks: [track] })).toThrowError(
      `Final selection track ${field} must not be blank`
    );
  });

  it('preserves supplied diagnostics while filling their defaults', () => {
    const skippedPick: FinalSelectionSkippedPick = {
      id: 'rejected-1',
      reason: 'id_excluded'
    };
    const result = buildFinalSelectionResult({
      tracks: [{ id: '1', name: '歌', reason: '理由', source: 'agent' }],
      diagnostics: {
        targetCount: 5,
        requestedPickCount: 3,
        // @ts-expect-error appendedCount is derived from the normalized tracks
        appendedCount: 99,
        skippedPicks: [skippedPick]
      }
    });

    expect(result.diagnostics).toEqual({
      targetCount: 5,
      requestedPickCount: 3,
      appendedCount: 1,
      skippedPicks: [skippedPick]
    });
  });

  it('limits rationale and proposed rationale to 1000 characters', () => {
    const result = buildFinalSelectionResult({
      tracks: [{ id: '1', name: '歌'.repeat(1200), reason: '理由', source: 'agent' }],
      proposedRationale: `  ${'建议 '.repeat(600)}  `
    });

    expect(result.rationale.length).toBeLessThanOrEqual(1000);
    expect(result.proposedRationale).toHaveLength(1000);
    expect(result.proposedRationale).not.toMatch(/\s{2,}/);
  });

  it('truncates at Unicode boundaries while preserving rationale punctuation', () => {
    const result = buildFinalSelectionResult({
      tracks: [
        {
          id: '1',
          name: `边界${'🎵'.repeat(800)}`,
          artist: `艺人${'🌙'.repeat(800)}`,
          reason: '理由',
          source: 'agent'
        }
      ],
      proposedRationale: `a${'🎵'.repeat(800)}`
    });

    expect(result.rationale.length).toBeLessThanOrEqual(1000);
    expect(result.rationale).toContain('…');
    expect(result.rationale).toMatch(/》。$/u);
    expect(hasLoneSurrogate(result.rationale)).toBe(false);
    expect(result.proposedRationale!.length).toBeLessThanOrEqual(1000);
    expect(hasLoneSurrogate(result.proposedRationale!)).toBe(false);
  });

  it('normalizes every track field to its Unicode-safe boundary before building rationale', () => {
    const result = buildFinalSelectionResult({
      tracks: [{
        id: `id-${'🎵'.repeat(120)}`,
        name: `name-${'🌙'.repeat(180)}`,
        artist: `artist-${'🎸'.repeat(180)}`,
        reason: `reason-${'🎹'.repeat(600)}`,
        source: `source-${'🎺'.repeat(60)}`
      }]
    });

    expect(result.tracks[0]?.id.length).toBeLessThanOrEqual(200);
    expect(result.tracks[0]?.name?.length).toBeLessThanOrEqual(300);
    expect(result.tracks[0]?.artist?.length).toBeLessThanOrEqual(300);
    expect(result.tracks[0]?.reason.length).toBeLessThanOrEqual(1000);
    expect(result.tracks[0]?.source.length).toBeLessThanOrEqual(80);
    for (const value of Object.values(result.tracks[0]!)) {
      expect(hasLoneSurrogate(value)).toBe(false);
    }
    expect(result.rationale).toContain(result.tracks[0]!.name!);
    expect(result.rationale).toContain(result.tracks[0]!.artist!);
  });

  it('uses the already-truncated id when a blank name falls back to id', () => {
    const result = buildFinalSelectionResult({
      tracks: [{ id: `id-${'🎵'.repeat(120)}`, name: ' ', reason: 'reason', source: 'source' }]
    });

    expect(result.tracks[0]?.id.length).toBeLessThanOrEqual(200);
    expect(result.tracks[0]?.name).toBe(result.tracks[0]?.id);
    expect(hasLoneSurrogate(result.tracks[0]!.name!)).toBe(false);
  });
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
