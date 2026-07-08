import { getQueue, type QueueTrack } from '../store/queue.js';

type QueueReader = {
  getQueue(userId: string): QueueTrack[];
};

const defaultQueueReader: QueueReader = { getQueue };

export function getAddedTrackCount(
  userId: string,
  initialQueueLength: number,
  queueReader: QueueReader = defaultQueueReader
): number {
  return Math.max(0, queueReader.getQueue(userId).length - initialQueueLength);
}

export function getRemainingPickSlots(
  userId: string,
  initialQueueLength: number,
  targetPickCount: number,
  queueReader: QueueReader = defaultQueueReader
): number {
  return Math.max(0, targetPickCount - getAddedTrackCount(userId, initialQueueLength, queueReader));
}

export function hasReachedPickTarget(
  userId: string,
  initialQueueLength: number,
  targetPickCount: number,
  queueReader: QueueReader = defaultQueueReader
): boolean {
  return getAddedTrackCount(userId, initialQueueLength, queueReader) >= targetPickCount;
}
