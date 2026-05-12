import { describe, expect, it } from 'vitest';
import { shouldTreatMediaErrorAsEnded } from '../../src/renderer/audio/mediaError';

describe('media error handling', () => {
  it('treats a media error near the end of a known-duration track as ended', () => {
    expect(shouldTreatMediaErrorAsEnded({ currentTime: 239.4, duration: 240 })).toBe(true);
  });

  it('does not treat mid-track media errors as ended', () => {
    expect(shouldTreatMediaErrorAsEnded({ currentTime: 120, duration: 240 })).toBe(false);
  });
});
