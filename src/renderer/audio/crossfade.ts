export const DEFAULT_CROSSFADE_SEC = 8;
export const DEFAULT_CURVE_STEPS = 64;
export const DEFAULT_FILTER_START_HZ = 20_000;
export const DEFAULT_FILTER_END_HZ = 2_000;
export const SKIP_CROSSFADE_SEC = 0.8;

type AudioParamLike = {
  cancelScheduledValues?: (startTime: number) => void;
  setValueAtTime: (value: number, startTime: number) => void;
  linearRampToValueAtTime: (value: number, endTime: number) => void;
  setValueCurveAtTime: (values: Float32Array, startTime: number, duration: number) => void;
};

type GainNodeLike = {
  gain: AudioParamLike;
};

type BiquadFilterNodeLike = {
  frequency: AudioParamLike;
};

export type CrossfadeNodes = {
  fromGain: GainNodeLike;
  toGain: GainNodeLike;
  fromFilter?: BiquadFilterNodeLike;
};

export type CrossfadeOptions = {
  startTime: number;
  durationSec?: number;
  curveSteps?: number;
  enableFilterSweep?: boolean;
  filterStartHz?: number;
  filterEndHz?: number;
};

export type EqualPowerCurves = {
  fadeOut: Float32Array;
  fadeIn: Float32Array;
};

export function buildEqualPowerCurves(steps = DEFAULT_CURVE_STEPS): EqualPowerCurves {
  if (!Number.isInteger(steps) || steps < 2) {
    throw new Error('steps must be an integer >= 2');
  }

  const fadeOut = new Float32Array(steps);
  const fadeIn = new Float32Array(steps);

  for (let i = 0; i < steps; i += 1) {
    const x = i / (steps - 1);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
  }

  return { fadeOut, fadeIn };
}

export function applyEqualPowerCrossfade(nodes: CrossfadeNodes, options: CrossfadeOptions): void {
  const durationSec = options.durationSec ?? DEFAULT_CROSSFADE_SEC;
  if (!(durationSec > 0)) {
    throw new Error('durationSec must be > 0');
  }

  const curveSteps = options.curveSteps ?? DEFAULT_CURVE_STEPS;
  const { fadeOut, fadeIn } = buildEqualPowerCurves(curveSteps);
  const startTime = options.startTime;

  scheduleGainCurve(nodes.fromGain.gain, fadeOut, startTime, durationSec);
  scheduleGainCurve(nodes.toGain.gain, fadeIn, startTime, durationSec);

  const filterSweepEnabled = options.enableFilterSweep ?? true;
  if (filterSweepEnabled && nodes.fromFilter) {
    const filterStartHz = options.filterStartHz ?? DEFAULT_FILTER_START_HZ;
    const filterEndHz = options.filterEndHz ?? DEFAULT_FILTER_END_HZ;

    nodes.fromFilter.frequency.cancelScheduledValues?.(startTime);
    nodes.fromFilter.frequency.setValueAtTime(filterStartHz, startTime);
    nodes.fromFilter.frequency.linearRampToValueAtTime(filterEndHz, startTime + durationSec);
  }
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(gain);
}

function scheduleGainCurve(
  gainParam: AudioParamLike,
  curve: Float32Array,
  startTime: number,
  durationSec: number
): void {
  gainParam.cancelScheduledValues?.(startTime);
  gainParam.setValueCurveAtTime(curve, startTime, durationSec);
}
