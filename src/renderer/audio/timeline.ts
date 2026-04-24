import { calculatePlaybackMilestones } from './prefetch';
import type { PlaybackTiming } from '@shared/schema';

export type TimelineEventId = 'segue' | 'prefetch' | 'crossfade';
export type TimelineRangeId = 'ducking' | 'crossfade';

export type TimelineEvent = {
  id: TimelineEventId;
  label: string;
  atSec: number;
  pct: number;
};

export type TimelineRange = {
  id: TimelineRangeId;
  label: string;
  startSec: number;
  endSec: number;
  startPct: number;
  widthPct: number;
};

export type PlaybackTimeline = {
  durationSec: number;
  positionSec: number;
  windowStartSec: number;
  windowEndSec: number;
  progressPct: number;
  events: TimelineEvent[];
  ranges: TimelineRange[];
};

type BuildPlaybackTimelineInput = {
  positionSec: number;
  timing: PlaybackTiming;
  duckingHintSec?: number;
};

export function buildPlaybackTimeline(
  durationSec: number,
  input: BuildPlaybackTimelineInput
): PlaybackTimeline {
  const resolvedDurationSec = Math.max(0, finiteOrZero(durationSec));
  const positionSec = clamp(finiteOrZero(input.positionSec), 0, resolvedDurationSec || finiteOrZero(input.positionSec));
  const milestones = calculatePlaybackMilestones(resolvedDurationSec, input.timing);
  const duckingHintSec = Math.max(0, finiteOrZero(input.duckingHintSec ?? 0));
  const windowStartSec = Math.min(milestones.segueAtSec, milestones.prefetchAtSec, milestones.crossfadeAtSec);
  const windowEndSec = resolvedDurationSec;
  const windowDurationSec = Math.max(1, windowEndSec - windowStartSec);

  const events = ([
    {
      id: 'segue',
      label: 'Segue',
      atSec: milestones.segueAtSec,
      pct: toWindowPct(milestones.segueAtSec, windowStartSec, windowDurationSec)
    },
    {
      id: 'prefetch',
      label: 'Prefetch',
      atSec: milestones.prefetchAtSec,
      pct: toWindowPct(milestones.prefetchAtSec, windowStartSec, windowDurationSec)
    },
    {
      id: 'crossfade',
      label: 'Crossfade',
      atSec: milestones.crossfadeAtSec,
      pct: toWindowPct(milestones.crossfadeAtSec, windowStartSec, windowDurationSec)
    }
  ] satisfies TimelineEvent[]).sort((a, b) => a.atSec - b.atSec);

  const ranges: TimelineRange[] = [
    makeRange(
      'ducking',
      'TTS ducking',
      milestones.segueAtSec,
      milestones.segueAtSec + duckingHintSec,
      windowStartSec,
      windowEndSec,
      windowDurationSec
    ),
    makeRange(
      'crossfade',
      'Crossfade',
      milestones.crossfadeAtSec,
      resolvedDurationSec,
      windowStartSec,
      windowEndSec,
      windowDurationSec
    )
  ];

  return {
    durationSec: resolvedDurationSec,
    positionSec,
    windowStartSec,
    windowEndSec,
    progressPct: toWindowPct(positionSec, windowStartSec, windowDurationSec),
    events,
    ranges
  };
}

function makeRange(
  id: TimelineRangeId,
  label: string,
  startSec: number,
  endSec: number,
  windowStartSec: number,
  windowEndSec: number,
  windowDurationSec: number
): TimelineRange {
  const boundedStart = clamp(startSec, windowStartSec, windowEndSec);
  const boundedEnd = clamp(Math.max(endSec, boundedStart), windowStartSec, windowEndSec);
  return {
    id,
    label,
    startSec: boundedStart,
    endSec: boundedEnd,
    startPct: toWindowPct(boundedStart, windowStartSec, windowDurationSec),
    widthPct: toPct(boundedEnd - boundedStart, windowDurationSec)
  };
}

function toPct(valueSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return clamp((valueSec / durationSec) * 100, 0, 100);
}

function toWindowPct(valueSec: number, windowStartSec: number, windowDurationSec: number): number {
  return toPct(valueSec - windowStartSec, windowDurationSec);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
