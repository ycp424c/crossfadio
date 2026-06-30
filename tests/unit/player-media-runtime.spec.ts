import { describe, expect, it } from 'vitest';
import {
  getTrackMediaErrorAction,
  getTrackMediaRetryResumeDecision
} from '../../src/renderer/playerMediaRuntime';

describe('player media runtime', () => {
  it('matches pending media retry to the active track and clamps resume position to known duration', () => {
    expect(getTrackMediaRetryResumeDecision({
      pendingRetry: {
        trackId: 'current',
        requestId: 2,
        positionSec: 120,
        shouldPlay: true
      },
      currentTrackId: 'current',
      currentRequestId: 2,
      audioDurationSec: 100
    })).toEqual({ shouldResume: true, resumeAtSec: 99.5 });

    expect(getTrackMediaRetryResumeDecision({
      pendingRetry: {
        trackId: 'old',
        requestId: 2,
        positionSec: 120,
        shouldPlay: true
      },
      currentTrackId: 'current',
      currentRequestId: 2,
      audioDurationSec: 100
    })).toEqual({ shouldResume: false });
  });

  it('classifies media errors as ended, retry, or fail', () => {
    expect(getTrackMediaErrorAction({
      currentTimeSec: 239,
      durationSec: 240,
      retryAttempts: 0,
      maxRetryAttempts: 2,
      trackId: 'current'
    })).toEqual({ type: 'ended' });

    expect(getTrackMediaErrorAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 0,
      maxRetryAttempts: 2,
      trackId: 'current'
    })).toEqual({ type: 'retry', resumeAtSec: 120 });

    expect(getTrackMediaErrorAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 2,
      maxRetryAttempts: 2,
      trackId: 'current'
    })).toEqual({ type: 'fail' });
  });
});
