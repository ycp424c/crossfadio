import { getQueue } from '../store/queue.js';

export function getAddedTrackCount(userId: string, initialQueueLength: number): number {
  return Math.max(0, getQueue(userId).length - initialQueueLength);
}

export function getRemainingPickSlots(userId: string, initialQueueLength: number, targetPickCount: number): number {
  return Math.max(0, targetPickCount - getAddedTrackCount(userId, initialQueueLength));
}

export function hasReachedPickTarget(userId: string, initialQueueLength: number, targetPickCount: number): boolean {
  return getAddedTrackCount(userId, initialQueueLength) >= targetPickCount;
}
