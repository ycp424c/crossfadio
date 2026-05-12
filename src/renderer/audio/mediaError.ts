type MediaErrorPosition = {
  currentTime: number;
  duration: number;
};

const END_OF_TRACK_ERROR_GRACE_SEC = 2;

export function shouldTreatMediaErrorAsEnded(position: MediaErrorPosition): boolean {
  const { currentTime, duration } = position;
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }

  return duration - currentTime <= END_OF_TRACK_ERROR_GRACE_SEC;
}
