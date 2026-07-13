import {
  getMediaErrorRetryDecision,
  shouldTreatMediaErrorAsEnded
} from './audio/mediaError';

export type PendingTrackMediaRetry = {
  trackId: string;
  requestId: number;
  positionSec: number;
  shouldPlay: boolean;
};

export type TrackMediaRetryResumeDecision =
  | {
      shouldResume: false;
    }
  | {
      shouldResume: true;
      resumeAtSec: number;
    };

export type TrackMediaErrorAction =
  | {
      type: 'ended';
    }
  | {
      type: 'retry';
      resumeAtSec: number;
    }
  | {
      type: 'fail';
    };

export type TrackMediaManualResumeDecision =
  | {
      shouldRefresh: false;
    }
  | {
      shouldRefresh: true;
      trackId: string;
      resumeAtSec: number;
    };

export type TrackBufferedRange = {
  startSec: number;
  endSec: number;
};

export type TrackBufferGuardDecision = {
  bufferAheadSec: number;
  nextLowBufferSamples: number;
  shouldPrepareRecovery: boolean;
};

export type TrackPreloadRetryDecision =
  | {
      shouldRetry: false;
    }
  | {
      shouldRetry: true;
      nextAttempt: number;
      delayMs: number;
    };

export type TrackMediaRecoveryAction =
  | {
      type: 'ended';
    }
  | {
      type: 'retry';
      resumeAtSec: number;
      strategy: 'prepared' | 'refresh';
    }
  | {
      type: 'fail';
    };

export function getTrackPreloadRetryDecision(input: {
  failedAttempts: number;
  maxAttempts: number;
  retryDelayMs: number;
}): TrackPreloadRetryDecision {
  if (input.failedAttempts >= input.maxAttempts) {
    return { shouldRetry: false };
  }

  return {
    shouldRetry: true,
    nextAttempt: input.failedAttempts + 1,
    delayMs: input.retryDelayMs
  };
}

export function getTrackBufferGuardDecision(input: {
  bufferedRanges: TrackBufferedRange[];
  currentTimeSec: number;
  durationSec: number;
  isPlaying: boolean;
  consecutiveLowBufferSamples: number;
  lowBufferThresholdSec: number;
  requiredLowBufferSamples: number;
  endOfTrackGraceSec: number;
  minimumPlaybackPositionSec: number;
}): TrackBufferGuardDecision {
  const currentTimeSec = Number.isFinite(input.currentTimeSec)
    ? Math.max(0, input.currentTimeSec)
    : 0;
  const containingRange = input.bufferedRanges.find(
    (range) => range.startSec <= currentTimeSec && range.endSec >= currentTimeSec
  );
  const bufferAheadSec = containingRange
    ? Math.max(0, containingRange.endSec - currentTimeSec)
    : 0;
  const remainingSec = Number.isFinite(input.durationSec) && input.durationSec > 0
    ? Math.max(0, input.durationSec - currentTimeSec)
    : Number.POSITIVE_INFINITY;
  const isLowBuffer = input.isPlaying &&
    currentTimeSec >= input.minimumPlaybackPositionSec &&
    remainingSec > input.endOfTrackGraceSec &&
    bufferAheadSec < input.lowBufferThresholdSec;
  const nextLowBufferSamples = isLowBuffer
    ? input.consecutiveLowBufferSamples + 1
    : 0;

  return {
    bufferAheadSec,
    nextLowBufferSamples,
    shouldPrepareRecovery: nextLowBufferSamples >= input.requiredLowBufferSamples
  };
}

export function getTrackMediaRetryResumeDecision(input: {
  pendingRetry: PendingTrackMediaRetry | null;
  currentTrackId: string | null;
  currentRequestId: number;
  audioDurationSec: number;
}): TrackMediaRetryResumeDecision {
  const pendingRetry = input.pendingRetry;
  if (
    !pendingRetry ||
    pendingRetry.trackId !== input.currentTrackId ||
    pendingRetry.requestId !== input.currentRequestId
  ) {
    return { shouldResume: false };
  }

  const maxSeekSec = Number.isFinite(input.audioDurationSec) && input.audioDurationSec > 0
    ? Math.max(0, input.audioDurationSec - 0.5)
    : pendingRetry.positionSec;
  return {
    shouldResume: true,
    resumeAtSec: Math.min(pendingRetry.positionSec, maxSeekSec)
  };
}

export function getTrackMediaErrorAction(input: {
  currentTimeSec: number;
  durationSec: number;
  retryAttempts: number;
  maxRetryAttempts: number;
  trackId: string | null;
}): TrackMediaErrorAction {
  if (shouldTreatMediaErrorAsEnded({ currentTime: input.currentTimeSec, duration: input.durationSec })) {
    return { type: 'ended' };
  }

  const retryDecision = getMediaErrorRetryDecision({
    currentTime: input.currentTimeSec,
    duration: input.durationSec,
    retryAttempts: input.retryAttempts,
    maxRetryAttempts: input.maxRetryAttempts
  });
  if (input.trackId && retryDecision.shouldRetry) {
    return { type: 'retry', resumeAtSec: retryDecision.resumeAtSec };
  }

  return { type: 'fail' };
}

export function getTrackMediaRecoveryAction(input: {
  currentTimeSec: number;
  durationSec: number;
  retryAttempts: number;
  maxRetryAttempts: number;
  trackId: string | null;
  hasPreparedRecovery: boolean;
}): TrackMediaRecoveryAction {
  const action = getTrackMediaErrorAction(input);
  if (action.type !== 'retry') {
    return action;
  }

  return {
    ...action,
    strategy: input.hasPreparedRecovery ? 'prepared' : 'refresh'
  };
}

export function shouldHandleStandbyTrackMediaEvent(input: {
  stagedRequestId: number;
  currentRequestId: number;
  stagedSourceUrl: string | null;
  audioSourceUrl: string;
}): boolean {
  return input.stagedRequestId === input.currentRequestId &&
    input.stagedSourceUrl !== null &&
    input.stagedSourceUrl.length > 0 &&
    input.stagedSourceUrl === input.audioSourceUrl;
}

export function shouldResetTrackMediaRetryWindow(input: {
  retryWindowStartedAtSec: number | null;
  currentTimeSec: number;
  stablePlaybackSec: number;
}): boolean {
  return input.retryWindowStartedAtSec !== null &&
    Number.isFinite(input.retryWindowStartedAtSec) &&
    Number.isFinite(input.currentTimeSec) &&
    input.currentTimeSec - input.retryWindowStartedAtSec >= input.stablePlaybackSec;
}

export function getTrackMediaManualResumeDecision(input: {
  needsFreshStream: boolean;
  trackId: string | null;
  currentTimeSec: number;
  positionSec: number;
}): TrackMediaManualResumeDecision {
  if (!input.needsFreshStream || !input.trackId) {
    return { shouldRefresh: false };
  }

  const resumeAtSec = Number.isFinite(input.currentTimeSec) && input.currentTimeSec > 0
    ? input.currentTimeSec
    : Number.isFinite(input.positionSec) && input.positionSec > 0
      ? input.positionSec
      : 0;

  return {
    shouldRefresh: true,
    trackId: input.trackId,
    resumeAtSec
  };
}
