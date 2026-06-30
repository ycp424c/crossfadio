import { describe, expect, it } from 'vitest';
import {
  advanceQueueAfterEnded,
  appendQueueTrackIfMissing,
  deleteQueueTrackAt,
  getCurrentQueueTrackId,
  getQueueTrackIds,
  selectQueueTrackAt,
  skipCurrentQueueTrack
} from '../../src/renderer/playerQueueRuntime';
import type { QueueTrackDto } from '../../src/shared/schema';

describe('player queue runtime', () => {
  it('deduplicates appended tracks while preserving the original queue reference', () => {
    const queue = [track('current'), track('next')];

    expect(appendQueueTrackIfMissing(queue, track('next'))).toBe(queue);
    expect(appendQueueTrackIfMissing(queue, track('third')).map((item) => item.id))
      .toEqual(['current', 'next', 'third']);
  });

  it('skips the current track and returns the removed track for temporary bans', () => {
    const transition = skipCurrentQueueTrack({
      queue: [track('current'), track('next'), track('third')],
      currentIndex: 0
    });

    expect(transition.changed).toBe(true);
    expect(getQueueTrackIds(transition.queue)).toEqual(['next', 'third']);
    expect(transition.currentIndex).toBe(0);
    expect(transition.removedTracks.map((item) => item.id)).toEqual(['current']);
    expect(transition.shouldAutoplayNext).toBe(true);
  });

  it('selects a later queue track by dropping earlier tracks', () => {
    const transition = selectQueueTrackAt({
      queue: [track('current'), track('middle'), track('target')],
      currentIndex: 0
    }, 2);

    expect(getCurrentQueueTrackId(transition)).toBe('target');
    expect(transition.removedTracks.map((item) => item.id)).toEqual(['current', 'middle']);
    expect(transition.shouldAutoplayNext).toBe(true);
  });

  it('deletes non-current tracks and adjusts current index when deleting before current', () => {
    const transition = deleteQueueTrackAt({
      queue: [track('past'), track('current'), track('next')],
      currentIndex: 1
    }, 0);

    expect(transition.changed).toBe(true);
    expect(getQueueTrackIds(transition.queue)).toEqual(['current', 'next']);
    expect(transition.currentIndex).toBe(0);
    expect(transition.removedTracks.map((item) => item.id)).toEqual(['past']);
    expect(deleteQueueTrackAt({ queue: [track('current'), track('next')], currentIndex: 0 }, 0).changed).toBe(false);
  });

  it('advances after ended and marks playback as reached end when no backup remains', () => {
    const advanced = advanceQueueAfterEnded({
      queue: [track('current'), track('next')],
      currentIndex: 0
    });
    expect(getQueueTrackIds(advanced.queue)).toEqual(['next']);
    expect(advanced.shouldAutoplayNext).toBe(true);
    expect(advanced.reachedEnd).toBe(false);

    const ended = advanceQueueAfterEnded({ queue: [track('last')], currentIndex: 0 });
    expect(ended.queue).toEqual([]);
    expect(ended.currentIndex).toBe(0);
    expect(ended.shouldAutoplayNext).toBe(false);
    expect(ended.reachedEnd).toBe(true);
  });
});

function track(id: string): QueueTrackDto {
  return {
    id,
    name: `Track ${id}`,
    artists: [`Artist ${id}`],
    durationMs: 180_000,
    coverImgUrl: null
  };
}
