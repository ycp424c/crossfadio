import type { QueueTrackDto } from '@shared/schema';

export type PlayerQueueSnapshot = {
  queue: QueueTrackDto[];
  currentIndex: number;
};

export type PlayerAuthoritativeQueueSnapshot = PlayerQueueSnapshot & {
  revision: number;
};

export type PlayerQueueTransition = PlayerQueueSnapshot & {
  changed: boolean;
  removedTracks: QueueTrackDto[];
  shouldAutoplayNext: boolean;
  reachedEnd: boolean;
};

export type PlayerQueueOperation =
  | { type: 'manual_skip'; trackId: string; autoplay?: boolean }
  | { type: 'natural_ended'; trackId: string }
  | { type: 'select_track'; trackId: string; autoplay?: boolean }
  | { type: 'delete_track'; trackId: string }
  | { type: 'append_track'; track: QueueTrackDto }
  | { type: 'restore_previous'; track: QueueTrackDto; autoplay?: boolean }
  | { type: 'replace_queue'; snapshot: PlayerQueueSnapshot };

export type SequencedPlayerQueueOperation = {
  sequence: number;
  operation: PlayerQueueOperation;
};

export function getQueueTrackIds(queue: QueueTrackDto[]): string[] {
  return queue.map((track) => track.id);
}

export function getCurrentQueueTrack(snapshot: PlayerQueueSnapshot): QueueTrackDto | null {
  return snapshot.queue[snapshot.currentIndex] ?? null;
}

export function getCurrentQueueTrackId(snapshot: PlayerQueueSnapshot): string | null {
  return getCurrentQueueTrack(snapshot)?.id ?? null;
}

export function shouldApplyAuthoritativeQueueRevision(
  currentRevision: number,
  incomingRevision: number | null
): incomingRevision is number {
  return incomingRevision !== null && incomingRevision > currentRevision;
}

export function appendQueueTrackIfMissing(queue: QueueTrackDto[], track: QueueTrackDto): QueueTrackDto[] {
  if (queue.some((item) => item.id === track.id)) {
    return queue;
  }
  return [...queue, track];
}

export function skipCurrentQueueTrack(snapshot: PlayerQueueSnapshot): PlayerQueueTransition {
  const currentTrack = snapshot.queue[snapshot.currentIndex];
  if (!currentTrack || snapshot.currentIndex >= snapshot.queue.length - 1) return unchanged(snapshot);
  return {
    queue: snapshot.queue.slice(snapshot.currentIndex + 1),
    currentIndex: 0,
    changed: true,
    removedTracks: [currentTrack],
    shouldAutoplayNext: true,
    reachedEnd: false
  };
}

export function selectQueueTrackAt(snapshot: PlayerQueueSnapshot, index: number): PlayerQueueTransition {
  if (index <= snapshot.currentIndex || index >= snapshot.queue.length) return unchanged(snapshot);
  return {
    queue: snapshot.queue.slice(index),
    currentIndex: 0,
    changed: true,
    removedTracks: snapshot.queue.slice(snapshot.currentIndex, index),
    shouldAutoplayNext: true,
    reachedEnd: false
  };
}

export function deleteQueueTrackAt(snapshot: PlayerQueueSnapshot, index: number): PlayerQueueTransition {
  if (index === snapshot.currentIndex) return unchanged(snapshot);
  const deletedTrack = snapshot.queue[index];
  if (!deletedTrack) return unchanged(snapshot);
  return {
    queue: [...snapshot.queue.slice(0, index), ...snapshot.queue.slice(index + 1)],
    currentIndex: index < snapshot.currentIndex ? snapshot.currentIndex - 1 : snapshot.currentIndex,
    changed: true,
    removedTracks: [deletedTrack],
    shouldAutoplayNext: false,
    reachedEnd: false
  };
}

export function advanceQueueAfterEnded(snapshot: PlayerQueueSnapshot): PlayerQueueTransition {
  const completedTrack = snapshot.queue[snapshot.currentIndex];
  if (completedTrack && snapshot.currentIndex < snapshot.queue.length - 1) {
    return {
      queue: snapshot.queue.slice(snapshot.currentIndex + 1),
      currentIndex: 0,
      changed: true,
      removedTracks: [completedTrack],
      shouldAutoplayNext: true,
      reachedEnd: false
    };
  }
  if (completedTrack) {
    return {
      queue: [],
      currentIndex: 0,
      changed: true,
      removedTracks: [completedTrack],
      shouldAutoplayNext: false,
      reachedEnd: true
    };
  }
  return {
    queue: snapshot.queue,
    currentIndex: snapshot.currentIndex,
    changed: false,
    removedTracks: [],
    shouldAutoplayNext: false,
    reachedEnd: true
  };
}

export function replayQueueTrackRemovals(
  snapshot: PlayerQueueSnapshot,
  removedTracks: Array<Pick<QueueTrackDto, 'id'>>
): PlayerQueueSnapshot {
  const removedIds = new Set(removedTracks.map((track) => track.id));
  if (removedIds.size === 0) return snapshot;
  let removedBeforeCurrent = 0;
  const queue = snapshot.queue.filter((track, index) => {
    if (!removedIds.has(track.id)) return true;
    if (index < snapshot.currentIndex) removedBeforeCurrent += 1;
    return false;
  });
  const desiredIndex = snapshot.currentIndex - removedBeforeCurrent;
  return {
    queue,
    currentIndex: queue.length === 0
      ? 0
      : Math.max(0, Math.min(desiredIndex, queue.length - 1))
  };
}

export function replayQueueOperations(
  snapshot: PlayerQueueSnapshot,
  operations: readonly PlayerQueueOperation[]
): PlayerQueueSnapshot {
  return operations.reduce((current, operation) => {
    if (operation.type === 'replace_queue') {
      return operation.snapshot;
    }
    if (operation.type === 'restore_previous') {
      return {
        queue: [
          operation.track,
          ...current.queue
            .slice(current.currentIndex)
            .filter((track) => track.id !== operation.track.id)
        ],
        currentIndex: 0
      };
    }
    if (operation.type === 'append_track') {
      return {
        queue: appendQueueTrackIfMissing(current.queue, operation.track),
        currentIndex: current.currentIndex
      };
    }
    const trackIndex = current.queue.findIndex((track) => track.id === operation.trackId);
    if (trackIndex < 0) return current;
    if (operation.type === 'natural_ended') {
      const queue = current.queue.slice(trackIndex + 1);
      return {
        queue,
        currentIndex: queue.length === 0
          ? 0
          : Math.max(0, Math.min(current.currentIndex - trackIndex - 1, queue.length - 1))
      };
    }
    if (operation.type === 'delete_track') {
      const transition = deleteQueueTrackAt(current, trackIndex);
      return transition.changed
        ? { queue: transition.queue, currentIndex: transition.currentIndex }
        : current;
    }
    if (trackIndex < current.currentIndex) return current;
    if (operation.type === 'manual_skip') {
      if (trackIndex >= current.queue.length - 1) return current;
      return { queue: current.queue.slice(trackIndex + 1), currentIndex: 0 };
    }
    return { queue: current.queue.slice(trackIndex), currentIndex: 0 };
  }, snapshot);
}

export function replayUncommittedQueueOperations(
  snapshot: PlayerQueueSnapshot,
  uncommitted: readonly SequencedPlayerQueueOperation[],
  confirmedThroughSequence = 0
): PlayerQueueSnapshot {
  return replayQueueOperations(
    snapshot,
    uncommitted
      .filter((entry) => entry.sequence > confirmedThroughSequence)
      .map((entry) => entry.operation)
  );
}

export function reconcileAcknowledgedQueueMutation(input: {
  acknowledgement: PlayerAuthoritativeQueueSnapshot;
  latestAuthoritative: PlayerAuthoritativeQueueSnapshot;
  uncommitted: readonly SequencedPlayerQueueOperation[];
  acknowledgedThroughSequence: number;
  pending?: readonly PlayerQueueOperation[];
}): {
  snapshot: PlayerQueueSnapshot;
  revision: number;
  uncommitted: SequencedPlayerQueueOperation[];
  pending: PlayerQueueOperation[];
} {
  const authoritative = input.latestAuthoritative.revision >= input.acknowledgement.revision
    ? input.latestAuthoritative
    : input.acknowledgement;
  const uncommitted = input.uncommitted.filter(
    (entry) => entry.sequence > input.acknowledgedThroughSequence
  );
  const uncommittedOperations = new Set(uncommitted.map((entry) => entry.operation));
  return {
    snapshot: replayUncommittedQueueOperations(authoritative, uncommitted),
    revision: authoritative.revision,
    uncommitted,
    pending: (input.pending ?? []).filter((operation) => uncommittedOperations.has(operation))
  };
}

export function shouldAutoplayQueueAfterRebase(
  snapshot: PlayerQueueSnapshot,
  operations: readonly PlayerQueueOperation[]
): boolean {
  if (!getCurrentQueueTrack(snapshot)) return false;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]!;
    if (operation.type === 'natural_ended') return true;
    if (
      operation.type === 'manual_skip'
      || operation.type === 'select_track'
      || operation.type === 'restore_previous'
    ) return operation.autoplay === true;
    if (operation.type === 'replace_queue') return false;
  }
  return false;
}

export function getQueueAutoplayTargetForTransition(
  snapshot: PlayerQueueSnapshot,
  shouldAutoplay: boolean
): string | null {
  return shouldAutoplay ? getCurrentQueueTrackId(snapshot) : null;
}

export function getQueueAutoplayTargetAfterRebase(
  snapshot: PlayerQueueSnapshot,
  operations: readonly PlayerQueueOperation[],
  currentTrackId: string | null
): string | null {
  if (!shouldAutoplayQueueAfterRebase(snapshot, operations)) return null;
  const targetTrackId = getCurrentQueueTrackId(snapshot);
  return targetTrackId && targetTrackId !== currentTrackId ? targetTrackId : null;
}

export function shouldConsumeQueueAutoplayTarget(
  targetTrackId: string | null,
  loadingTrackId: string
): boolean {
  return targetTrackId === loadingTrackId;
}

function unchanged(snapshot: PlayerQueueSnapshot): PlayerQueueTransition {
  return {
    ...snapshot,
    changed: false,
    removedTracks: [],
    shouldAutoplayNext: false,
    reachedEnd: false
  };
}
