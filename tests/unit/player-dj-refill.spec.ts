import { describe, expect, it } from 'vitest';
import {
  appendQueueTrackIfMissing,
  formatDjPickDoneStatus,
  shouldTriggerDjRefill
} from '../../src/renderer/playerDjRefill';
import type { QueueTrackDto } from '../../src/shared/schema';

function track(id: string, name: string): QueueTrackDto {
  return {
    id,
    name,
    artists: [`${name} Artist`],
    durationMs: 180_000,
    coverImgUrl: null
  };
}

describe('player DJ refill state', () => {
  it('deduplicates queue-appended events from the one-shot and persistent SSE streams', () => {
    const first = track('new-1', 'New Song');
    const appended = appendQueueTrackIfMissing([track('current', 'Current'), first], first);

    expect(appended.map((item) => item.id)).toEqual(['current', 'new-1']);
  });

  it('does not trigger another refill when the latest queue already has five backup tracks', () => {
    expect(shouldTriggerDjRefill({
      isPlaying: true,
      segueInFlight: false,
      pickNextInFlight: false,
      now: 10_000,
      backoffUntil: 0,
      lastCallAt: 0,
      cooldownMs: 3_000,
      queueLength: 6,
      currentIndex: 0,
      lowWaterMark: 2
    })).toBe(false);
  });

  it('formats large batch completion by count instead of leaving the status pending', () => {
    expect(formatDjPickDoneStatus({
      added: true,
      addedCount: 5,
      trackNames: ['A', 'B', 'C', 'D', 'E']
    })).toBe('已补充 5 首');
  });
});
