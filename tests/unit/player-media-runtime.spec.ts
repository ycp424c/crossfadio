import { describe, expect, it } from 'vitest';
import {
  getTrackMediaErrorAction,
  getTrackMediaManualResumeDecision,
  getTrackMediaRetryResumeDecision,
  shouldResetTrackMediaRetryWindow
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
      maxRetryAttempts: 3,
      trackId: 'current'
    })).toEqual({ type: 'retry', resumeAtSec: 120 });

    expect(getTrackMediaErrorAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 3,
      maxRetryAttempts: 3,
      trackId: 'current'
    })).toEqual({ type: 'fail' });
  });

  it('refreshes the current stream before manual resume after recoverable failure', () => {
    expect(getTrackMediaManualResumeDecision({
      needsFreshStream: true,
      trackId: 'current',
      currentTimeSec: 92,
      positionSec: 88
    })).toEqual({ shouldRefresh: true, trackId: 'current', resumeAtSec: 92 });

    expect(getTrackMediaManualResumeDecision({
      needsFreshStream: true,
      trackId: 'current',
      currentTimeSec: Number.NaN,
      positionSec: 88
    })).toEqual({ shouldRefresh: true, trackId: 'current', resumeAtSec: 88 });

    expect(getTrackMediaManualResumeDecision({
      needsFreshStream: false,
      trackId: 'current',
      currentTimeSec: 92,
      positionSec: 88
    })).toEqual({ shouldRefresh: false });
  });

  it('resets the retry window only after ten seconds of stable playback progress', () => {
    expect(shouldResetTrackMediaRetryWindow({
      retryWindowStartedAtSec: 120,
      currentTimeSec: 129.9,
      stablePlaybackSec: 10
    })).toBe(false);

    expect(shouldResetTrackMediaRetryWindow({
      retryWindowStartedAtSec: 120,
      currentTimeSec: 130,
      stablePlaybackSec: 10
    })).toBe(true);

    expect(shouldResetTrackMediaRetryWindow({
      retryWindowStartedAtSec: null,
      currentTimeSec: 130,
      stablePlaybackSec: 10
    })).toBe(false);
  });
});
