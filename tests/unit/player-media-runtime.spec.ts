import { describe, expect, it } from 'vitest';
import {
  getTrackBufferGuardDecision,
  getTrackMediaErrorAction,
  getTrackMediaManualResumeDecision,
  getTrackMediaRecoveryAction,
  getTrackMediaRetryResumeDecision,
  getTrackPreloadRetryDecision,
  shouldHandleStandbyTrackMediaEvent,
  shouldResetTrackMediaRetryWindow
} from '../../src/renderer/playerMediaRuntime';

describe('player media runtime', () => {
  it('arms proactive recovery after the forward buffer stays low for three samples', () => {
    expect(getTrackBufferGuardDecision({
      bufferedRanges: [{ startSec: 0, endSec: 126 }],
      currentTimeSec: 120,
      durationSec: 240,
      isPlaying: true,
      consecutiveLowBufferSamples: 2,
      lowBufferThresholdSec: 8,
      requiredLowBufferSamples: 3,
      endOfTrackGraceSec: 2,
      minimumPlaybackPositionSec: 5
    })).toEqual({
      bufferAheadSec: 6,
      nextLowBufferSamples: 3,
      shouldPrepareRecovery: true
    });

    expect(getTrackBufferGuardDecision({
      bufferedRanges: [{ startSec: 0, endSec: 150 }],
      currentTimeSec: 120,
      durationSec: 240,
      isPlaying: true,
      consecutiveLowBufferSamples: 2,
      lowBufferThresholdSec: 8,
      requiredLowBufferSamples: 3,
      endOfTrackGraceSec: 2,
      minimumPlaybackPositionSec: 5
    })).toEqual({
      bufferAheadSec: 30,
      nextLowBufferSamples: 0,
      shouldPrepareRecovery: false
    });

    expect(getTrackBufferGuardDecision({
      bufferedRanges: [{ startSec: 0, endSec: 4 }],
      currentTimeSec: 1,
      durationSec: 240,
      isPlaying: true,
      consecutiveLowBufferSamples: 2,
      lowBufferThresholdSec: 8,
      requiredLowBufferSamples: 3,
      endOfTrackGraceSec: 2,
      minimumPlaybackPositionSec: 5
    }).shouldPrepareRecovery).toBe(false);
  });

  it('ignores stale standby events from an old request or source URL', () => {
    expect(shouldHandleStandbyTrackMediaEvent({
      stagedRequestId: 3,
      currentRequestId: 3,
      stagedSourceUrl: 'https://audio.example/current.mp3',
      audioSourceUrl: 'https://audio.example/current.mp3'
    })).toBe(true);
    expect(shouldHandleStandbyTrackMediaEvent({
      stagedRequestId: 2,
      currentRequestId: 3,
      stagedSourceUrl: 'https://audio.example/current.mp3',
      audioSourceUrl: 'https://audio.example/current.mp3'
    })).toBe(false);
    expect(shouldHandleStandbyTrackMediaEvent({
      stagedRequestId: 3,
      currentRequestId: 3,
      stagedSourceUrl: 'https://audio.example/current.mp3',
      audioSourceUrl: 'https://audio.example/next.mp3'
    })).toBe(false);
    expect(shouldHandleStandbyTrackMediaEvent({
      stagedRequestId: 3,
      currentRequestId: 3,
      stagedSourceUrl: null,
      audioSourceUrl: 'https://audio.example/next.mp3'
    })).toBe(false);
  });

  it('bounds standby preload retries without exponential backoff', () => {
    expect(getTrackPreloadRetryDecision({
      failedAttempts: 1,
      maxAttempts: 3,
      retryDelayMs: 500
    })).toEqual({ shouldRetry: true, nextAttempt: 2, delayMs: 500 });
    expect(getTrackPreloadRetryDecision({
      failedAttempts: 2,
      maxAttempts: 3,
      retryDelayMs: 500
    })).toEqual({ shouldRetry: true, nextAttempt: 3, delayMs: 500 });
    expect(getTrackPreloadRetryDecision({
      failedAttempts: 3,
      maxAttempts: 3,
      retryDelayMs: 500
    })).toEqual({ shouldRetry: false });
  });

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

  it('charges real media errors to the same retry budget even with a prepared deck', () => {
    expect(getTrackMediaRecoveryAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 2,
      maxRetryAttempts: 3,
      trackId: 'current',
      hasPreparedRecovery: true
    })).toEqual({ type: 'retry', resumeAtSec: 120, strategy: 'prepared' });

    expect(getTrackMediaRecoveryAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 3,
      maxRetryAttempts: 3,
      trackId: 'current',
      hasPreparedRecovery: true
    })).toEqual({ type: 'fail' });

    expect(getTrackMediaRecoveryAction({
      currentTimeSec: 120,
      durationSec: 240,
      retryAttempts: 0,
      maxRetryAttempts: 3,
      trackId: 'current',
      hasPreparedRecovery: false
    })).toEqual({ type: 'retry', resumeAtSec: 120, strategy: 'refresh' });
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
