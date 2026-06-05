import { describe, expect, it } from 'vitest';
import { getSegueAudioStartAtSec, shouldStartSegueAudio } from '../../src/renderer/audio/seguePlayback';

describe('segue audio playback timing', () => {
  it('starts long segue speech early enough to finish before track end', () => {
    expect(getSegueAudioStartAtSec({
      trackDurationSec: 180,
      crossfadeSec: 8,
      speechDurationSec: 12
    })).toBe(167);
  });

  it('keeps short segue speech aligned with the crossfade window', () => {
    expect(getSegueAudioStartAtSec({
      trackDurationSec: 180,
      crossfadeSec: 8,
      speechDurationSec: 5
    })).toBe(172);
  });

  it('starts once playback reaches the duration-aware start point', () => {
    const timing = {
      trackDurationSec: 180,
      crossfadeSec: 8,
      speechDurationSec: 12
    };

    expect(shouldStartSegueAudio({ ...timing, positionSec: 166.9 })).toBe(false);
    expect(shouldStartSegueAudio({ ...timing, positionSec: 167 })).toBe(true);
  });
});
