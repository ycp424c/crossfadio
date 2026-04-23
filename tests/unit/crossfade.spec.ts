import { describe, expect, it } from 'vitest';
import {
  applyEqualPowerCrossfade,
  buildEqualPowerCurves,
  dbToGain,
  gainToDb
} from '../../src/renderer/audio/crossfade';

class FakeAudioParam {
  readonly calls: string[] = [];
  curve: Float32Array | null = null;
  curveStart: number | null = null;
  curveDuration: number | null = null;
  valueAtTime: Array<{ value: number; time: number }> = [];
  ramps: Array<{ value: number; time: number }> = [];

  cancelScheduledValues(startTime: number): void {
    this.calls.push(`cancel:${startTime}`);
  }

  setValueAtTime(value: number, startTime: number): void {
    this.calls.push(`set:${value}@${startTime}`);
    this.valueAtTime.push({ value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.calls.push(`ramp:${value}@${endTime}`);
    this.ramps.push({ value, time: endTime });
  }

  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): void {
    this.calls.push(`curve:${values.length}@${startTime}+${duration}`);
    this.curve = values;
    this.curveStart = startTime;
    this.curveDuration = duration;
  }
}

describe('buildEqualPowerCurves', () => {
  it('creates equal-power curves with expected boundaries', () => {
    const { fadeOut, fadeIn } = buildEqualPowerCurves(64);

    expect(fadeOut.length).toBe(64);
    expect(fadeIn.length).toBe(64);
    expect(fadeOut[0]).toBeCloseTo(1, 6);
    expect(fadeIn[0]).toBeCloseTo(0, 6);
    expect(fadeOut[63]).toBeCloseTo(0, 6);
    expect(fadeIn[63]).toBeCloseTo(1, 6);
  });

  it('maintains near-constant power across the curve', () => {
    const { fadeOut, fadeIn } = buildEqualPowerCurves(64);

    for (let i = 0; i < 64; i += 1) {
      const power = fadeOut[i] ** 2 + fadeIn[i] ** 2;
      expect(power).toBeCloseTo(1, 5);
    }
  });
});

describe('applyEqualPowerCrossfade', () => {
  it('schedules gain curves and filter sweep with defaults', () => {
    const fromGain = new FakeAudioParam();
    const toGain = new FakeAudioParam();
    const fromFilter = new FakeAudioParam();

    applyEqualPowerCrossfade(
      {
        fromGain: { gain: fromGain },
        toGain: { gain: toGain },
        fromFilter: { frequency: fromFilter }
      },
      { startTime: 12.5 }
    );

    expect(fromGain.curve).not.toBeNull();
    expect(toGain.curve).not.toBeNull();
    expect(fromGain.curveDuration).toBe(8);
    expect(toGain.curveDuration).toBe(8);
    expect(fromGain.curveStart).toBe(12.5);
    expect(toGain.curveStart).toBe(12.5);

    expect(fromFilter.valueAtTime).toEqual([{ value: 20_000, time: 12.5 }]);
    expect(fromFilter.ramps).toEqual([{ value: 2_000, time: 20.5 }]);
  });

  it('can disable filter sweep', () => {
    const fromGain = new FakeAudioParam();
    const toGain = new FakeAudioParam();
    const fromFilter = new FakeAudioParam();

    applyEqualPowerCrossfade(
      {
        fromGain: { gain: fromGain },
        toGain: { gain: toGain },
        fromFilter: { frequency: fromFilter }
      },
      { startTime: 3, enableFilterSweep: false }
    );

    expect(fromGain.curveDuration).toBe(8);
    expect(toGain.curveDuration).toBe(8);
    expect(fromFilter.valueAtTime).toHaveLength(0);
    expect(fromFilter.ramps).toHaveLength(0);
  });

  it('throws on non-positive duration', () => {
    const fromGain = new FakeAudioParam();
    const toGain = new FakeAudioParam();

    expect(() =>
      applyEqualPowerCrossfade(
        {
          fromGain: { gain: fromGain },
          toGain: { gain: toGain }
        },
        { startTime: 0, durationSec: 0 }
      )
    ).toThrow('durationSec must be > 0');
  });
});

describe('dB conversion helpers', () => {
  it('converts between db and gain', () => {
    expect(dbToGain(-8)).toBeCloseTo(0.398107, 6);
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});
