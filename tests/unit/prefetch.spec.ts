import { describe, expect, it } from 'vitest';
import { calculatePlaybackMilestones, getPrefetchDecision } from '../../src/renderer/audio/prefetch';

describe('calculatePlaybackMilestones', () => {
  it('calculates default d-12/d-10/d-8 milestones', () => {
    const milestones = calculatePlaybackMilestones(180);

    expect(milestones).toEqual({
      segueAtSec: 168,
      prefetchAtSec: 170,
      crossfadeAtSec: 172
    });
  });

  it('clamps milestones to zero for short tracks', () => {
    const milestones = calculatePlaybackMilestones(6);

    expect(milestones).toEqual({
      segueAtSec: 0,
      prefetchAtSec: 0,
      crossfadeAtSec: 0
    });
  });
});

describe('getPrefetchDecision', () => {
  it('triggers in the configured tolerance window', () => {
    const decision = getPrefetchDecision(170.1, 180, { triggerToleranceSec: 0.3 });

    expect(decision.shouldPrefetchNext).toBe(true);
    expect(decision.shouldTriggerSegue).toBe(false);
    expect(decision.shouldStartCrossfade).toBe(false);
  });

  it('returns false before trigger points', () => {
    const decision = getPrefetchDecision(160, 180);

    expect(decision.shouldPrefetchNext).toBe(false);
    expect(decision.shouldTriggerSegue).toBe(false);
    expect(decision.shouldStartCrossfade).toBe(false);
  });

  it('starts crossfade at d-8 by default', () => {
    const decision = getPrefetchDecision(172.1, 180);

    expect(decision.shouldStartCrossfade).toBe(true);
    expect(decision.shouldPrefetchNext).toBe(false);
  });
});
