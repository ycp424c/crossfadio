export const DEFAULT_PREFETCH_LEAD_SEC = 10;
export const DEFAULT_CROSSFADE_SEC = 8;
export const DEFAULT_SEGUE_LEAD_SEC = 12;
export const DEFAULT_TRIGGER_TOLERANCE_SEC = 0.25;

export type PrefetchTiming = {
  prefetchLeadSec?: number;
  crossfadeSec?: number;
  segueLeadSec?: number;
  triggerToleranceSec?: number;
};

export type PlaybackMilestones = {
  prefetchAtSec: number;
  segueAtSec: number;
  crossfadeAtSec: number;
};

export type PrefetchDecision = PlaybackMilestones & {
  shouldPrefetchNext: boolean;
  shouldTriggerSegue: boolean;
  shouldStartCrossfade: boolean;
};

export function resolveTiming(overrides: PrefetchTiming = {}): Required<PrefetchTiming> {
  return {
    prefetchLeadSec: overrides.prefetchLeadSec ?? DEFAULT_PREFETCH_LEAD_SEC,
    crossfadeSec: overrides.crossfadeSec ?? DEFAULT_CROSSFADE_SEC,
    segueLeadSec: overrides.segueLeadSec ?? DEFAULT_SEGUE_LEAD_SEC,
    triggerToleranceSec: overrides.triggerToleranceSec ?? DEFAULT_TRIGGER_TOLERANCE_SEC
  };
}

export function calculatePlaybackMilestones(
  durationSec: number,
  timing: PrefetchTiming = {}
): PlaybackMilestones {
  const resolved = resolveTiming(timing);

  return {
    prefetchAtSec: triggerPoint(durationSec, resolved.prefetchLeadSec),
    segueAtSec: triggerPoint(durationSec, resolved.segueLeadSec),
    crossfadeAtSec: triggerPoint(durationSec, resolved.crossfadeSec)
  };
}

export function getPrefetchDecision(
  positionSec: number,
  durationSec: number,
  timing: PrefetchTiming = {}
): PrefetchDecision {
  const resolved = resolveTiming(timing);
  const milestones = calculatePlaybackMilestones(durationSec, resolved);

  return {
    ...milestones,
    shouldPrefetchNext: isWithinTriggerWindow(
      positionSec,
      milestones.prefetchAtSec,
      resolved.triggerToleranceSec
    ),
    shouldTriggerSegue: isWithinTriggerWindow(
      positionSec,
      milestones.segueAtSec,
      resolved.triggerToleranceSec
    ),
    shouldStartCrossfade: isWithinTriggerWindow(
      positionSec,
      milestones.crossfadeAtSec,
      resolved.triggerToleranceSec
    )
  };
}

function triggerPoint(durationSec: number, leadSec: number): number {
  if (!(durationSec > 0)) {
    return 0;
  }

  return Math.max(0, durationSec - leadSec);
}

function isWithinTriggerWindow(positionSec: number, pointSec: number, toleranceSec: number): boolean {
  return positionSec >= pointSec && positionSec < pointSec + toleranceSec;
}
