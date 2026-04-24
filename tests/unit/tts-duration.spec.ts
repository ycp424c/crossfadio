import { describe, expect, it } from 'vitest';
import { estimateTtsDurationSec } from '../../src/server/tts/duration';

describe('estimateTtsDurationSec', () => {
  it('returns bounded minimum for empty text', () => {
    expect(estimateTtsDurationSec('')).toBe(2);
    expect(estimateTtsDurationSec('   ')).toBe(2);
  });

  it('estimates longer duration for longer text', () => {
    const shortText = estimateTtsDurationSec('接下来是下一首。');
    const longText = estimateTtsDurationSec('接下来这首歌会带你进入更明亮的节奏层次，我们一起把今天的情绪推到新的高潮。');

    expect(longText).toBeGreaterThan(shortText);
  });

  it('adjusts duration by speech speed', () => {
    const text = 'Welcome back, this is your AI DJ for tonight.';
    const normal = estimateTtsDurationSec(text, 1);
    const faster = estimateTtsDurationSec(text, 1.5);
    const slower = estimateTtsDurationSec(text, 0.8);

    expect(faster).toBeLessThan(normal);
    expect(slower).toBeGreaterThan(normal);
  });

  it('caps duration within safe range', () => {
    const text = '音乐'.repeat(500);
    const duration = estimateTtsDurationSec(text, 0.25);
    expect(duration).toBeLessThanOrEqual(45);
  });
});
