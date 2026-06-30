export { appendQueueTrackIfMissing } from './playerQueueRuntime';
export { queueTrackFromSsePayload } from './playerSseEvents';

type RefillGateInput = {
  isPlaying: boolean;
  segueInFlight: boolean;
  pickNextInFlight: boolean;
  now: number;
  backoffUntil: number;
  lastCallAt: number;
  cooldownMs: number;
  queueLength: number;
  currentIndex: number;
  lowWaterMark: number;
};

export function getBackupTrackCount(queueLength: number, currentIndex: number): number {
  return Math.max(0, queueLength - currentIndex - 1);
}

export function shouldTriggerDjRefill(input: RefillGateInput): boolean {
  return input.isPlaying
    && !input.segueInFlight
    && !input.pickNextInFlight
    && input.now >= input.backoffUntil
    && getBackupTrackCount(input.queueLength, input.currentIndex) <= input.lowWaterMark
    && input.now - input.lastCallAt >= input.cooldownMs;
}

export function getDjPickDoneAddedCount(data: Record<string, unknown>): number {
  return typeof data.addedCount === 'number' && Number.isFinite(data.addedCount)
    ? Math.max(0, Math.floor(data.addedCount))
    : data.added === true
      ? 1
      : 0;
}

export function getDjPickDoneTrackNames(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.trackNames)) {
    return data.trackNames.filter((name): name is string => typeof name === 'string' && name.length > 0);
  }
  return typeof data.trackName === 'string' && data.trackName.length > 0 ? [data.trackName] : [];
}

export function formatDjPickDoneStatus(data: Record<string, unknown>): string {
  const addedCount = getDjPickDoneAddedCount(data);
  if (addedCount >= 2) {
    return `已补充 ${addedCount} 首`;
  }
  const [firstName] = getDjPickDoneTrackNames(data);
  return firstName ? `已加入「${firstName}」` : '已补充队列';
}
