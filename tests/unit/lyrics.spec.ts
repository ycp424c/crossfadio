import { describe, expect, it } from 'vitest';
import { getActiveLyricIndex, parseSyncedLyrics } from '../../src/renderer/audio/lyrics';

describe('parseSyncedLyrics', () => {
  it('parses timestamped lrc lines and ignores metadata lines', () => {
    expect(
      parseSyncedLyrics('[ar:Beyond]\n[00:01.000]第一句\n[00:03.50]第二句\n[00:05]第三句')
    ).toEqual([
      { timeSec: 1, text: '第一句' },
      { timeSec: 3.5, text: '第二句' },
      { timeSec: 5, text: '第三句' }
    ]);
  });
});

describe('getActiveLyricIndex', () => {
  it('returns the latest lyric line at or before the current position', () => {
    const lines = parseSyncedLyrics('[00:01.000]第一句\n[00:03.000]第二句\n[00:05.000]第三句');

    expect(getActiveLyricIndex(lines, 0.5)).toBe(0);
    expect(getActiveLyricIndex(lines, 3.2)).toBe(1);
    expect(getActiveLyricIndex(lines, 8)).toBe(2);
  });
});
