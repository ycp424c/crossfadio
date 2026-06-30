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
