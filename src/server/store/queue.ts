/**
 * In-memory playback queue.
 * Tracks the ordered list of ncmIds the browser should play next.
 */

export type QueueTrack = {
  ncmId: string;
  query?: string;
};

let queue: QueueTrack[] = [];
let currentIndex = 0;

export function getQueue(): QueueTrack[] {
  return [...queue];
}

export function setQueue(tracks: QueueTrack[]): void {
  queue = [...tracks];
  currentIndex = 0;
}

export function setQueueState(tracks: QueueTrack[], nextCurrentIndex = 0): void {
  queue = [...tracks];
  currentIndex = clampIndex(nextCurrentIndex);
}

export function getCurrentIndex(): number {
  return currentIndex;
}

export function advanceCurrent(): void {
  if (currentIndex < queue.length - 1) {
    currentIndex += 1;
  }
}

export function swapNext(track: QueueTrack): void {
  if (queue.length === 0) {
    queue = [track];
    return;
  }
  const insertAt = Math.min(currentIndex + 1, queue.length);
  queue.splice(insertAt, 0, track);
  // Remove any existing instance further ahead to keep queue clean
  const laterIdx = queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
  if (laterIdx !== -1) queue.splice(laterIdx, 1);
}

export function addToQueue(track: QueueTrack, position: 'end' | 'after_current'): void {
  if (position === 'end') {
    queue.push(track);
  } else {
    const insertAt = Math.min(currentIndex + 1, queue.length);
    queue.splice(insertAt, 0, track);
  }
}

export function skipCurrent(): void {
  advanceCurrent();
}

export function banNcmId(ncmId: string): void {
  queue = queue.filter((t) => t.ncmId !== ncmId);
  currentIndex = clampIndex(currentIndex);
}

function clampIndex(index: number): number {
  if (queue.length === 0) {
    return 0;
  }
  if (!Number.isInteger(index)) {
    return 0;
  }
  return Math.min(Math.max(index, 0), queue.length - 1);
}
