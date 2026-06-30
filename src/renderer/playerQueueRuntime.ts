import type { QueueTrackDto } from '@shared/schema';

export type PlayerQueueSnapshot = {
  queue: QueueTrackDto[];
  currentIndex: number;
};

export type PlayerQueueTransition = PlayerQueueSnapshot & {
  changed: boolean;
  removedTracks: QueueTrackDto[];
  shouldAutoplayNext: boolean;
  reachedEnd: boolean;
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

export function appendQueueTrackIfMissing(queue: QueueTrackDto[], track: QueueTrackDto): QueueTrackDto[] {
  if (queue.some((item) => item.id === track.id)) {
    return queue;
  }
  return [...queue, track];
}

export function skipCurrentQueueTrack(snapshot: PlayerQueueSnapshot): PlayerQueueTransition {
  if (snapshot.queue.length <= 1) return unchanged(snapshot);
  return {
    queue: snapshot.queue.slice(1),
    currentIndex: 0,
    changed: true,
    removedTracks: snapshot.queue.slice(0, 1),
    shouldAutoplayNext: true,
    reachedEnd: false
  };
}

export function selectQueueTrackAt(snapshot: PlayerQueueSnapshot, index: number): PlayerQueueTransition {
  if (index <= 0 || index >= snapshot.queue.length) return unchanged(snapshot);
  return {
    queue: snapshot.queue.slice(index),
    currentIndex: 0,
    changed: true,
    removedTracks: snapshot.queue.slice(0, index),
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
  if (snapshot.queue.length > 1) {
    return {
      queue: snapshot.queue.slice(1),
      currentIndex: 0,
      changed: true,
      removedTracks: snapshot.queue.slice(0, 1),
      shouldAutoplayNext: true,
      reachedEnd: false
    };
  }
  return {
    queue: [],
    currentIndex: 0,
    changed: snapshot.queue.length > 0 || snapshot.currentIndex !== 0,
    removedTracks: snapshot.queue,
    shouldAutoplayNext: false,
    reachedEnd: true
  };
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
