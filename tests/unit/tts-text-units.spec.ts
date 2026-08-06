import { describe, expect, it } from 'vitest';
import { estimateTtsTextUnits, truncateTtsText, TENCENT_TTS_MAX_INPUT_UNITS } from '../../src/server/tts/client.js';

describe('estimateTtsTextUnits', () => {
  it('counts CJK characters as one unit each', () => {
    expect(estimateTtsTextUnits('你好，世界')).toBe(5);
  });

  it('counts about three ASCII letters as one unit (150 units = 500 letters)', () => {
    expect(estimateTtsTextUnits('a')).toBe(1);
    expect(estimateTtsTextUnits('abcd')).toBe(2); // ceil(4*0.3) = 2
  });

  it('mixes CJK and ASCII with ceil rounding', () => {
    expect(estimateTtsTextUnits('你好abc')).toBe(3); // 2 CJK + 3 ASCII (0.9 -> ceil 3)
    expect(estimateTtsTextUnits('Ok')).toBe(1); // ceil(2*0.3) = 1
  });

  it('counts 500 ASCII letters as exactly 150 units within the Tencent limit', () => {
    expect(estimateTtsTextUnits('a'.repeat(500))).toBe(150);
  });

  it('counts 501 ASCII letters as exceeding the 150-unit limit', () => {
    expect(estimateTtsTextUnits('a'.repeat(501))).toBe(151);
  });

  it('counts 150 CJK characters as exactly 150 units', () => {
    expect(estimateTtsTextUnits('中'.repeat(150))).toBe(150);
  });
});

describe('truncateTtsText', () => {
  it('returns the text unchanged when within the limit', () => {
    const text = '中'.repeat(149);
    expect(truncateTtsText(text, TENCENT_TTS_MAX_INPUT_UNITS)).toBe(text);
  });

  it('truncates CJK text to the unit limit', () => {
    const truncated = truncateTtsText('中'.repeat(160), TENCENT_TTS_MAX_INPUT_UNITS);
    expect(estimateTtsTextUnits(truncated)).toBe(TENCENT_TTS_MAX_INPUT_UNITS);
    expect(Array.from(truncated)).toHaveLength(TENCENT_TTS_MAX_INPUT_UNITS);
  });

  it('keeps ASCII letters up to the Tencent 500-letter limit', () => {
    const truncated = truncateTtsText('a'.repeat(600), TENCENT_TTS_MAX_INPUT_UNITS);
    expect(truncated).toHaveLength(500);
    expect(estimateTtsTextUnits(truncated)).toBe(TENCENT_TTS_MAX_INPUT_UNITS);
  });

  it('does not cut surrogate pairs', () => {
    // 150 个 CJK + emoji（emoji 为代理对，按码点遍历不会切半）
    const text = '中'.repeat(150) + '🎵';
    const truncated = truncateTtsText(text, TENCENT_TTS_MAX_INPUT_UNITS);
    expect(truncated).not.toContain('\uD83C'); // 不包含孤立高代理
    expect(truncated.endsWith('🎵')).toBe(false); // emoji 在边界外被丢弃而非切半
    expect(estimateTtsTextUnits(truncated)).toBe(TENCENT_TTS_MAX_INPUT_UNITS);
  });
});
