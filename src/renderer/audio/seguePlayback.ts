const SEGUE_COMPLETION_BUFFER_SEC = 1;

type SegueAudioStartInput = {
  trackDurationSec: number;
  crossfadeSec: number;
  speechDurationSec: number;
  completionBufferSec?: number;
};

type ShouldStartSegueAudioInput = SegueAudioStartInput & {
  positionSec: number;
};

export function getSegueAudioStartAtSec(input: SegueAudioStartInput): number {
  const trackDurationSec = positiveOrZero(input.trackDurationSec);
  if (trackDurationSec <= 0) return 0;

  const crossfadeLeadSec = positiveOrZero(input.crossfadeSec);
  const speechLeadSec = positiveOrZero(input.speechDurationSec) + positiveOrZero(
    input.completionBufferSec ?? SEGUE_COMPLETION_BUFFER_SEC
  );
  const leadSec = Math.max(crossfadeLeadSec, speechLeadSec);

  return Math.max(0, trackDurationSec - leadSec);
}

export function shouldStartSegueAudio(input: ShouldStartSegueAudioInput): boolean {
  return positiveOrZero(input.positionSec) >= getSegueAudioStartAtSec(input);
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
