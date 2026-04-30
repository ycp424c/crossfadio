export type QueueTrack = {
  ncmId: string;
  query?: string;
  name?: string;
  artists?: string[];
  durationMs?: number;
};

type QueueState = {
  queue: QueueTrack[];
  currentIndex: number;
};

const userQueues = new Map<string, QueueState>();

function getState(userId: string): QueueState {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, { queue: [], currentIndex: 0 });
  }
  return userQueues.get(userId)!;
}

function clampIndex(queue: QueueTrack[], index: number): number {
  if (queue.length === 0) return 0;
  if (!Number.isInteger(index)) return 0;
  return Math.min(Math.max(index, 0), queue.length - 1);
}

export function getQueue(userId: string): QueueTrack[] {
  return [...getState(userId).queue];
}

export function setQueue(userId: string, tracks: QueueTrack[]): void {
  userQueues.set(userId, { queue: [...tracks], currentIndex: 0 });
}

export function setQueueState(userId: string, tracks: QueueTrack[], nextCurrentIndex = 0): void {
  const queue = [...tracks];
  userQueues.set(userId, { queue, currentIndex: clampIndex(queue, nextCurrentIndex) });
}

export function getCurrentIndex(userId: string): number {
  return getState(userId).currentIndex;
}

export function advanceCurrent(userId: string): void {
  const s = getState(userId);
  if (s.currentIndex < s.queue.length - 1) s.currentIndex += 1;
}

export function swapNext(userId: string, track: QueueTrack): void {
  const s = getState(userId);
  if (s.queue.length === 0) { s.queue = [track]; return; }
  const insertAt = Math.min(s.currentIndex + 1, s.queue.length);
  s.queue.splice(insertAt, 0, track);
  const laterIdx = s.queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
  if (laterIdx !== -1) s.queue.splice(laterIdx, 1);
}

export function addToQueue(userId: string, track: QueueTrack, position: 'end' | 'after_current'): void {
  const s = getState(userId);
  if (position === 'end') {
    s.queue = s.queue.filter((t) => t.ncmId !== track.ncmId);
    s.queue.push(track);
  } else {
    const insertAt = Math.min(s.currentIndex + 1, s.queue.length);
    s.queue.splice(insertAt, 0, track);
    const laterIdx = s.queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
    if (laterIdx !== -1) s.queue.splice(laterIdx, 1);
  }
}

export function skipCurrent(userId: string): void {
  advanceCurrent(userId);
}

export function banNcmId(userId: string, ncmId: string): void {
  const s = getState(userId);
  s.queue = s.queue.filter((t) => t.ncmId !== ncmId);
  s.currentIndex = clampIndex(s.queue, s.currentIndex);
}
