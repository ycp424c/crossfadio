import { describe, expect, it } from 'vitest';
import {
  advanceQueueAfterEnded,
  appendQueueTrackIfMissing,
  deleteQueueTrackAt,
  getCurrentQueueTrackId,
  getQueueAutoplayTargetAfterRebase,
  getQueueAutoplayTargetForTransition,
  getQueueTrackIds,
  reconcileAcknowledgedQueueMutation,
  replayQueueTrackRemovals,
  replayQueueOperations,
  replayUncommittedQueueOperations,
  selectQueueTrackAt,
  shouldApplyAuthoritativeQueueRevision,
  shouldAutoplayQueueAfterRebase,
  shouldConsumeQueueAutoplayTarget,
  skipCurrentQueueTrack
} from '../../src/renderer/playerQueueRuntime';
import type { QueueTrackDto } from '../../src/shared/schema';

describe('player queue runtime', () => {
  it('only applies complete authoritative queue snapshots with a newer revision', () => {
    expect(shouldApplyAuthoritativeQueueRevision(4, 5)).toBe(true);
    expect(shouldApplyAuthoritativeQueueRevision(4, 4)).toBe(false);
    expect(shouldApplyAuthoritativeQueueRevision(4, 3)).toBe(false);
    expect(shouldApplyAuthoritativeQueueRevision(4, null)).toBe(false);
  });

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

  it('keeps manual skip and selection correct after natural advance moved currentIndex', () => {
    const snapshot = {
      queue: [track('past'), track('current'), track('middle'), track('target')],
      currentIndex: 1
    };

    const skipped = skipCurrentQueueTrack(snapshot);
    expect(getQueueTrackIds(skipped.queue)).toEqual(['middle', 'target']);
    expect(skipped.removedTracks.map((item) => item.id)).toEqual(['current']);

    const selected = selectQueueTrackAt(snapshot, 3);
    expect(getQueueTrackIds(selected.queue)).toEqual(['target']);
    expect(selected.removedTracks.map((item) => item.id)).toEqual(['current', 'middle']);
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
    expect(advanced.currentIndex).toBe(0);
    expect(advanced.removedTracks.map((item) => item.id)).toEqual(['current']);
    expect(advanced.shouldAutoplayNext).toBe(true);
    expect(advanced.reachedEnd).toBe(false);

    const ended = advanceQueueAfterEnded({ queue: [track('last')], currentIndex: 0 });
    expect(getQueueTrackIds(ended.queue)).toEqual([]);
    expect(ended.currentIndex).toBe(0);
    expect(ended.changed).toBe(true);
    expect(ended.removedTracks.map((item) => item.id)).toEqual(['last']);
    expect(ended.shouldAutoplayNext).toBe(false);
    expect(ended.reachedEnd).toBe(true);
  });

  it('rebases explicit queue removals onto an authoritative conflict snapshot', () => {
    const rebased = replayQueueTrackRemovals({
      queue: [track('past'), track('current'), track('remote'), track('deleted')],
      currentIndex: 1
    }, [track('deleted')]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['past', 'current', 'remote']);
    expect(rebased.currentIndex).toBe(1);
  });

  it('replays a manual skip on an authoritative queue that gained a DJ track', () => {
    const rebased = replayQueueOperations({
      queue: [track('current'), track('next'), track('dj-appended')],
      currentIndex: 0
    }, [{ type: 'manual_skip', trackId: 'current' }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['next', 'dj-appended']);
    expect(rebased.currentIndex).toBe(0);
  });

  it('keeps newer local operations when an older CAS batch finishes later', () => {
    const uncommitted = [
      { sequence: 1, operation: { type: 'manual_skip', trackId: 'current' } },
      { sequence: 2, operation: { type: 'manual_skip', trackId: 'next' } }
    ] as const;

    const afterOlderBatch = replayUncommittedQueueOperations({
      queue: [track('next'), track('remote')],
      currentIndex: 0
    }, uncommitted, 1);
    expect(getQueueTrackIds(afterOlderBatch.queue)).toEqual(['remote']);

    const afterAuthoritativeEvent = replayUncommittedQueueOperations({
      queue: [track('current'), track('next'), track('remote')],
      currentIndex: 0
    }, uncommitted);
    expect(getQueueTrackIds(afterAuthoritativeEvent.queue)).toEqual(['remote']);
  });

  it('does not replay an acknowledged queue replacement over a newer authoritative snapshot', () => {
    const reconciliation = reconcileAcknowledgedQueueMutation({
      acknowledgement: {
        queue: [track('fresh-start')],
        currentIndex: 0,
        revision: 1
      },
      latestAuthoritative: {
        queue: [track('fresh-start'), track('dj-appended')],
        currentIndex: 0,
        revision: 2
      },
      uncommitted: [
        {
          sequence: 1,
          operation: {
            type: 'replace_queue',
            snapshot: { queue: [track('fresh-start')], currentIndex: 0 }
          }
        },
        { sequence: 2, operation: { type: 'append_track', track: track('local-newer') } }
      ],
      acknowledgedThroughSequence: 1
    });

    expect(getQueueTrackIds(reconciliation.snapshot.queue)).toEqual([
      'fresh-start',
      'dj-appended',
      'local-newer'
    ]);
    expect(reconciliation.revision).toBe(2);
    expect(reconciliation.uncommitted.map((entry) => entry.sequence)).toEqual([2]);
  });

  it('does not retry a failed queue replacement after a newer save acknowledges it', () => {
    const failedReplacement = {
      type: 'replace_queue' as const,
      snapshot: {
        queue: [track('fresh-start'), track('next')],
        currentIndex: 0
      }
    };
    const newerSkip = {
      type: 'manual_skip' as const,
      trackId: 'fresh-start'
    };
    const acknowledged = {
      queue: [track('next')],
      currentIndex: 0,
      revision: 2
    };

    const reconciliation = reconcileAcknowledgedQueueMutation({
      acknowledgement: acknowledged,
      latestAuthoritative: acknowledged,
      uncommitted: [
        { sequence: 1, operation: failedReplacement },
        { sequence: 2, operation: newerSkip }
      ],
      acknowledgedThroughSequence: 2,
      pending: [failedReplacement]
    });
    const afterRetry = replayQueueOperations(
      reconciliation.snapshot,
      reconciliation.pending
    );

    expect(getQueueTrackIds(afterRetry.queue)).toEqual(['next']);
  });

  it('replays selecting a later track without dropping a concurrent DJ append', () => {
    const rebased = replayQueueOperations({
      queue: [track('current'), track('middle'), track('target'), track('dj-appended')],
      currentIndex: 0
    }, [{ type: 'select_track', trackId: 'target' }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['target', 'dj-appended']);
    expect(rebased.currentIndex).toBe(0);
  });

  it('replays natural ended on an authoritative queue that gained a DJ track', () => {
    const rebased = replayQueueOperations({
      queue: [track('ended'), track('next'), track('dj-appended')],
      currentIndex: 0
    }, [{ type: 'natural_ended', trackId: 'ended' }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['next', 'dj-appended']);
    expect(rebased.currentIndex).toBe(0);
    expect(shouldAutoplayQueueAfterRebase(rebased, [
      { type: 'natural_ended', trackId: 'ended' }
    ])).toBe(true);
  });

  it('preserves manual playback intent only when a rebased queue has a playable track', () => {
    const playingSkip = [{ type: 'manual_skip', trackId: 'current', autoplay: true }] as const;
    const pausedSkip = [{ type: 'manual_skip', trackId: 'current', autoplay: false }] as const;

    expect(shouldAutoplayQueueAfterRebase({ queue: [track('next')], currentIndex: 0 }, playingSkip))
      .toBe(true);
    expect(shouldAutoplayQueueAfterRebase({ queue: [track('next')], currentIndex: 0 }, pausedSkip))
      .toBe(false);
    expect(shouldAutoplayQueueAfterRebase({ queue: [], currentIndex: 0 }, playingSkip))
      .toBe(false);
  });

  it('binds autoplay intent to a new target and lets paused transitions clear stale intent', () => {
    const snapshot = { queue: [track('next')], currentIndex: 0 };
    const playingSkip = [{ type: 'manual_skip', trackId: 'current', autoplay: true }] as const;

    expect(getQueueAutoplayTargetAfterRebase(snapshot, playingSkip, 'current')).toBe('next');
    expect(getQueueAutoplayTargetAfterRebase(snapshot, playingSkip, 'next')).toBeNull();
    expect(getQueueAutoplayTargetForTransition(snapshot, false)).toBeNull();
    expect(shouldConsumeQueueAutoplayTarget('next', 'next')).toBe(true);
    expect(shouldConsumeQueueAutoplayTarget('next', 'another')).toBe(false);
  });

  it('uses the latest playback transition intent after replaying multiple queue operations', () => {
    const operations = [
      { type: 'manual_skip', trackId: 'a', autoplay: true },
      { type: 'manual_skip', trackId: 'b', autoplay: false }
    ] as const;
    const rebased = replayQueueOperations({
      queue: [track('a'), track('b'), track('c'), track('remote')],
      currentIndex: 0
    }, operations);

    expect(getCurrentQueueTrackId(rebased)).toBe('c');
    expect(shouldAutoplayQueueAfterRebase(rebased, operations)).toBe(false);
    expect(getQueueAutoplayTargetAfterRebase(rebased, operations, 'b')).toBeNull();
  });

  it('trims an ended prefix even when the authoritative index already advanced', () => {
    const rebased = replayQueueOperations({
      queue: [track('ended'), track('current'), track('dj-appended')],
      currentIndex: 1
    }, [{ type: 'natural_ended', trackId: 'ended' }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['current', 'dj-appended']);
    expect(rebased.currentIndex).toBe(0);
  });

  it('replays natural ended by clearing an authoritative final track', () => {
    const rebased = replayQueueOperations({
      queue: [track('ended')],
      currentIndex: 0
    }, [{ type: 'natural_ended', trackId: 'ended' }]);

    expect(rebased).toEqual({ queue: [], currentIndex: 0 });
  });

  it('replays deleting one queued track without deleting a concurrent DJ append', () => {
    const rebased = replayQueueOperations({
      queue: [track('current'), track('deleted'), track('dj-appended')],
      currentIndex: 0
    }, [{ type: 'delete_track', trackId: 'deleted' }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['current', 'dj-appended']);
    expect(rebased.currentIndex).toBe(0);
  });

  it('replays a local append after the authoritative queue received another track', () => {
    const rebased = replayQueueOperations({
      queue: [track('current'), track('remote')],
      currentIndex: 0
    }, [{ type: 'append_track', track: track('local') }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['current', 'remote', 'local']);
    expect(rebased.currentIndex).toBe(0);
  });

  it('replays an intentional full queue replacement after a conflict', () => {
    const replacement = { queue: [track('fresh-start')], currentIndex: 0 };
    const rebased = replayQueueOperations({
      queue: [track('old-current'), track('remote')],
      currentIndex: 0
    }, [{ type: 'replace_queue', snapshot: replacement }]);

    expect(rebased).toEqual(replacement);
  });

  it('replays previous-track restore ahead of the authoritative queue', () => {
    const rebased = replayQueueOperations({
      queue: [track('current'), track('remote')],
      currentIndex: 0
    }, [{ type: 'restore_previous', track: track('previous') }]);

    expect(getQueueTrackIds(rebased.queue)).toEqual(['previous', 'current', 'remote']);
    expect(rebased.currentIndex).toBe(0);
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
