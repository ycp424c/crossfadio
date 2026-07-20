import { describe, expect, it } from 'vitest';
import {
  appendQueueTrackIfMissing,
  formatDjPickDoneStatus,
  shouldTriggerDjRefill
} from '../../src/renderer/playerDjRefill';
import { AUTO_FILL_LOW_WATER_MARK } from '../../src/shared/dj';
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
  it('keeps five backup tracks ready for playback', () => {
    expect(AUTO_FILL_LOW_WATER_MARK).toBe(5);
  });

  it('deduplicates a replayed local append while rebasing an atomic queue snapshot', () => {
    const first = track('new-1', 'New Song');
    const appended = appendQueueTrackIfMissing([track('current', 'Current'), first], first);

    expect(appended.map((item) => item.id)).toEqual(['current', 'new-1']);
  });

  it('triggers a refill when the current track has only four backups', () => {
    expect(shouldTriggerDjRefill({
      isPlaying: true,
      segueInFlight: false,
      pickNextInFlight: false,
      now: 10_000,
      backoffUntil: 0,
      lastCallAt: 0,
      cooldownMs: 3_000,
      queueLength: 5,
      currentIndex: 0,
      lowWaterMark: AUTO_FILL_LOW_WATER_MARK
    })).toBe(true);
  });

  it('does not trigger another refill when the current track already has five backups', () => {
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
      lowWaterMark: AUTO_FILL_LOW_WATER_MARK
    })).toBe(false);
  });

  it('counts backups relative to a non-zero current index', () => {
    expect(shouldTriggerDjRefill({
      isPlaying: true,
      segueInFlight: false,
      pickNextInFlight: false,
      now: 10_000,
      backoffUntil: 0,
      lastCallAt: 0,
      cooldownMs: 3_000,
      queueLength: 8,
      currentIndex: 3,
      lowWaterMark: AUTO_FILL_LOW_WATER_MARK
    })).toBe(true);
  });

  it('formats large batch completion by count instead of leaving the status pending', () => {
    expect(formatDjPickDoneStatus({
      added: true,
      addedCount: 5,
      trackNames: ['A', 'B', 'C', 'D', 'E']
    })).toBe('已补充 5 首');
  });
});
