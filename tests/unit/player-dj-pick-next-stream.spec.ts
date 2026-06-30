import { describe, expect, it, vi } from 'vitest';
import { consumePlayerPickNextStream } from '../../src/renderer/playerDjPickNextStream';
import type { QueueTrackDto } from '../../src/shared/schema';

describe('player DJ pick-next stream consumer', () => {
  it('routes typed pick-next stream events to player callbacks and ignores malformed events', async () => {
    const queue = [track('current')];
    const onQueueAppended = vi.fn();
    const onDebug = vi.fn();
    const onDone = vi.fn();
    const stream = vi.fn(async function* (input: { queue: QueueTrackDto[]; currentIndex: number }) {
      expect(input).toEqual({ queue, currentIndex: 0 });
      yield { type: 'queue-appended', data: { track: { ncmId: 'next', name: 'Next' } } };
      yield { type: 'queue-appended', data: { track: { name: 'missing id' } } };
      yield {
        type: 'dj.debug',
        data: {
          excludedIds: ['current'],
          excludedDedupeKeys: ['artist:current'],
          candidateScoreTable: [{ rank: 1, id: 'next', song: 'Next', artist: 'Artist', adjustedScore: 5 }]
        }
      };
      yield { type: 'dj.pick-next.done', data: { added: false, reason: 'already-running' } };
      yield { type: 'unknown', data: {} };
    });

    await consumePlayerPickNextStream({
      queue,
      currentIndex: 0,
      stream,
      onQueueAppended,
      onDebug,
      onDone
    });

    expect(onQueueAppended).toHaveBeenCalledTimes(1);
    expect(onQueueAppended).toHaveBeenCalledWith({
      id: 'next',
      name: 'Next',
      artists: [],
      durationMs: 0,
      coverImgUrl: null
    });
    expect(onDebug).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      excludedIds: ['current'],
      excludedDedupeKeys: ['artist:current']
    }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      reason: 'already-running'
    }));
  });
});

function track(id: string): QueueTrackDto {
  return {
    id,
    name: `Track ${id}`,
    artists: [],
    durationMs: 180_000,
    coverImgUrl: null
  };
}
