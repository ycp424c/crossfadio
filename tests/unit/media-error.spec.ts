import { describe, expect, it } from 'vitest';
import {
  getMediaErrorRetryDecision,
  shouldTreatMediaErrorAsEnded
} from '../../src/renderer/audio/mediaError';

describe('media error handling', () => {
  it('treats a media error near the end of a known-duration track as ended', () => {
    expect(shouldTreatMediaErrorAsEnded({ currentTime: 239.4, duration: 240 })).toBe(true);
  });

  it('does not treat mid-track media errors as ended', () => {
    expect(shouldTreatMediaErrorAsEnded({ currentTime: 120, duration: 240 })).toBe(false);
  });

  it('retries mid-track media errors below the attempt limit', () => {
    expect(getMediaErrorRetryDecision({
      currentTime: 120,
      duration: 240,
      retryAttempts: 0,
      maxRetryAttempts: 2
    })).toEqual({ shouldRetry: true, resumeAtSec: 118 });
  });

  it('does not retry media errors that are effectively at the end', () => {
    expect(getMediaErrorRetryDecision({
      currentTime: 239.4,
      duration: 240,
      retryAttempts: 0,
      maxRetryAttempts: 2
    })).toEqual({ shouldRetry: false, resumeAtSec: 0 });
  });

  it('stops retrying media errors after the attempt limit', () => {
    expect(getMediaErrorRetryDecision({
      currentTime: 120,
      duration: 240,
      retryAttempts: 2,
      maxRetryAttempts: 2
    })).toEqual({ shouldRetry: false, resumeAtSec: 0 });
  });
});
