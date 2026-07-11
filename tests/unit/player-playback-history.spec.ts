import { describe, expect, it } from 'vitest';
import { createPlaybackHistory } from '../../src/renderer/playerPlaybackHistory';
import { selectQueueTrackAt } from '../../src/renderer/playerQueueRuntime';
import type { QueueTrackDto } from '../../src/shared/schema';

function track(id: string): QueueTrackDto {
  return { id, name: `Track ${id}`, artists: [`Artist ${id}`] };
}

describe('player playback history', () => {
  it('restores the latest previous track to the front without duplicating it', () => {
    const history = createPlaybackHistory();
    history.record(track('previous'));

    expect(history.restore([track('current'), track('previous'), track('next')])).toEqual([
      track('previous'),
      track('current'),
      track('next')
    ]);
    expect(history.snapshot()).toEqual([]);
  });

  it('deduplicates tracks and moves the latest record to the end', () => {
    const history = createPlaybackHistory();
    history.record(track('a'));
    history.record(track('b'));
    history.record(track('a'));

    expect(history.snapshot()).toEqual([track('b'), track('a')]);
  });

  it('keeps only the latest tracks within the configured limit', () => {
    const history = createPlaybackHistory(2);
    history.record(track('a'));
    history.record(track('b'));
    history.record(track('c'));

    expect(history.snapshot()).toEqual([track('b'), track('c')]);
  });

  it('clears all recorded tracks', () => {
    const history = createPlaybackHistory();
    history.record(track('a'));

    history.clear();

    expect(history.snapshot()).toEqual([]);
  });

  it('returns the original queue reference when history is empty', () => {
    const history = createPlaybackHistory();
    const queue = [track('current')];

    expect(history.restore(queue)).toBe(queue);
  });

  it('restores tracks removed by a forward selection in reverse playback order', () => {
    const history = createPlaybackHistory();
    const transition = selectQueueTrackAt(
      { queue: [track('current'), track('middle'), track('target')], currentIndex: 0 },
      2
    );
    for (const removedTrack of transition.removedTracks) {
      history.record(removedTrack);
    }

    const firstRestore = history.restore(transition.queue);
    expect(firstRestore.map((item) => item.id)).toEqual(['middle', 'target']);

    const secondRestore = history.restore(firstRestore);
    expect(secondRestore.map((item) => item.id)).toEqual(['current', 'middle', 'target']);
  });
});
