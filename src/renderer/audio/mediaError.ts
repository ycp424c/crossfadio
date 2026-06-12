type MediaErrorPosition = {
  currentTime: number;
  duration: number;
};

const END_OF_TRACK_ERROR_GRACE_SEC = 2;
const MEDIA_ERROR_RETRY_SEEK_BACK_SEC = 2;

type MediaErrorRetryDecisionInput = MediaErrorPosition & {
  retryAttempts: number;
  maxRetryAttempts: number;
  seekBackSec?: number;
};

type MediaErrorRetryDecision = {
  shouldRetry: boolean;
  resumeAtSec: number;
};

export function shouldTreatMediaErrorAsEnded(position: MediaErrorPosition): boolean {
  const { currentTime, duration } = position;
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }

  return duration - currentTime <= END_OF_TRACK_ERROR_GRACE_SEC;
}

export function getMediaErrorRetryDecision(
  input: MediaErrorRetryDecisionInput
): MediaErrorRetryDecision {
  if (shouldTreatMediaErrorAsEnded(input) || input.retryAttempts >= input.maxRetryAttempts) {
    return { shouldRetry: false, resumeAtSec: 0 };
  }

  const currentTime = Number.isFinite(input.currentTime) && input.currentTime > 0
    ? input.currentTime
    : 0;
  const seekBackSec = typeof input.seekBackSec === 'number' && Number.isFinite(input.seekBackSec) && input.seekBackSec > 0
    ? input.seekBackSec
    : MEDIA_ERROR_RETRY_SEEK_BACK_SEC;

  return {
    shouldRetry: true,
    resumeAtSec: Math.max(0, currentTime - seekBackSec)
  };
}
