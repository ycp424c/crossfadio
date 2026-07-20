import { describe, expect, it, vi } from 'vitest';
import {
  consumePlayerPickNextStream,
  createPlayerAccountScope
} from '../../src/renderer/playerDjPickNextStream';
import type { QueueTrackDto } from '../../src/shared/schema';

describe('player DJ pick-next stream consumer', () => {
  it('invalidates captured stream ownership when the player account changes', () => {
    const accountScope = createPlayerAccountScope('token-a');
    const accountAStream = accountScope.capture();

    expect(accountAStream.isActive()).toBe(true);
    expect(accountScope.updateToken('token-b')).toBe(true);
    expect(accountAStream.isActive()).toBe(false);
    expect(accountScope.capture().isActive()).toBe(true);
    expect(accountScope.updateToken('token-b')).toBe(false);
  });

  it('routes typed pick-next stream events to player callbacks and ignores malformed events', async () => {
    const queue = [track('current')];
    const onQueueReplaced = vi.fn();
    const onDebug = vi.fn();
    const onDone = vi.fn();
    const onJourney = vi.fn();
    const stream = vi.fn(async function* (input: { queue: QueueTrackDto[]; currentIndex: number; revision: number; authToken?: string }) {
      expect(input).toEqual({ queue, currentIndex: 0, revision: 3, authToken: 'token-a' });
      yield {
        type: 'queue-updated',
        data: {
          queue: [
            { ncmId: 'current', name: 'Current' },
            { ncmId: 'next', name: 'Next' }
          ],
          currentIndex: 0,
          revision: 4
        }
      };
      yield {
        type: 'dj.debug',
        data: {
          excludedIds: ['current'],
          excludedDedupeKeys: ['artist:current'],
          candidateScoreTable: [{ rank: 1, id: 'next', song: 'Next', artist: 'Artist', adjustedScore: 5 }]
        }
      };
      yield { type: 'dj.pick-next.done', data: { added: false, reason: 'already-running' } };
      yield { type: 'selection.journey', data: { type: 'selection.journey', snapshot: journeySnapshot() } };
      yield { type: 'unknown', data: {} };
    });

    await consumePlayerPickNextStream({
      queue,
      currentIndex: 0,
      revision: 3,
      authToken: 'token-a',
      stream,
      onQueueReplaced,
      onDebug,
      onJourney,
      onDone
    });

    expect(onQueueReplaced).toHaveBeenCalledWith([
      { id: 'current', name: 'Current', artists: [], durationMs: 0, coverImgUrl: null },
      { id: 'next', name: 'Next', artists: [], durationMs: 0, coverImgUrl: null }
    ], 0, 4);
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
    expect(onJourney).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-stream' }));
  });

  it('finishes the stream lifecycle for a no-candidates result', async () => {
    const onQueueReplaced = vi.fn();
    const onDone = vi.fn();
    const stream = vi.fn(async function* () {
      yield {
        type: 'dj.pick-next.done',
        data: {
          added: false,
          addedCount: 0,
          reason: 'no-candidates',
          targetCount: 2
        }
      };
    });

    await consumePlayerPickNextStream({
      queue: [track('current')],
      currentIndex: 0,
      revision: 1,
      stream,
      onQueueReplaced,
      onDebug: vi.fn(),
      onJourney: vi.fn(),
      onDone
    });

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      reason: 'no-candidates',
      data: expect.objectContaining({ addedCount: 0, targetCount: 2 })
    }));
  });

  it('stops dispatching events when the stream no longer belongs to the active account', async () => {
    let active = true;
    const onQueueReplaced = vi.fn(() => { active = false; });
    const onJourney = vi.fn();
    const onDone = vi.fn();
    const stream = vi.fn(async function* () {
      yield { type: 'queue-updated', data: { queue: [{ ncmId: 'first', name: 'First' }], currentIndex: 0, revision: 2 } };
      yield { type: 'queue-updated', data: { queue: [{ ncmId: 'stale', name: 'Stale' }], currentIndex: 0, revision: 3 } };
      yield { type: 'selection.journey', data: { type: 'selection.journey', snapshot: journeySnapshot() } };
      yield { type: 'dj.pick-next.done', data: { added: true, addedCount: 1 } };
    });

    await consumePlayerPickNextStream({
      queue: [track('current')],
      currentIndex: 0,
      revision: 1,
      stream,
      isActive: () => active,
      onQueueReplaced,
      onDebug: vi.fn(),
      onJourney,
      onDone
    });

    expect(onQueueReplaced).toHaveBeenCalledOnce();
    expect(onJourney).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

function journeySnapshot() {
  return {
    schemaVersion: 1,
    runId: 'run-stream',
    journeyVersion: 1,
    revision: 1,
    status: 'running',
    summary: '正在选歌。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt: '2026-07-17T04:00:01.000Z',
    stages: [],
    candidates: [],
    selections: [],
    narration: { status: 'pending' }
  };
}

function track(id: string): QueueTrackDto {
  return {
    id,
    name: `Track ${id}`,
    artists: [],
    durationMs: 180_000,
    coverImgUrl: null
  };
}
