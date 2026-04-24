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

  const events = ([
    { id: 'segue', label: 'Segue', atSec: milestones.segueAtSec, pct: toPct(milestones.segueAtSec, resolvedDurationSec) },
    {
      id: 'prefetch',
      label: 'Prefetch',
      atSec: milestones.prefetchAtSec,
      pct: toPct(milestones.prefetchAtSec, resolvedDurationSec)
    },
    {
      id: 'crossfade',
      label: 'Crossfade',
      atSec: milestones.crossfadeAtSec,
      pct: toPct(milestones.crossfadeAtSec, resolvedDurationSec)
    }
  ] satisfies TimelineEvent[]).sort((a, b) => a.atSec - b.atSec);

  const ranges: TimelineRange[] = [
    makeRange('ducking', 'TTS ducking', milestones.segueAtSec, milestones.segueAtSec + duckingHintSec, resolvedDurationSec),
    makeRange('crossfade', 'Crossfade', milestones.crossfadeAtSec, resolvedDurationSec, resolvedDurationSec)
  ];

  return {
    durationSec: resolvedDurationSec,
    positionSec,
    progressPct: toPct(positionSec, resolvedDurationSec),
    events,
    ranges
  };
}

function makeRange(
  id: TimelineRangeId,
  label: string,
  startSec: number,
  endSec: number,
  durationSec: number
): TimelineRange {
  const boundedStart = clamp(startSec, 0, durationSec);
  const boundedEnd = clamp(Math.max(endSec, boundedStart), 0, durationSec);
  return {
    id,
    label,
    startSec: boundedStart,
    endSec: boundedEnd,
    startPct: toPct(boundedStart, durationSec),
    widthPct: toPct(boundedEnd - boundedStart, durationSec)
  };
}

function toPct(valueSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return clamp((valueSec / durationSec) * 100, 0, 100);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
