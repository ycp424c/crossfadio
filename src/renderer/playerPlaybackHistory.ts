import type { QueueTrackDto } from '@shared/schema';

export type PlaybackHistory = {
  record(track: QueueTrackDto): void;
  restore(queue: QueueTrackDto[]): QueueTrackDto[];
  snapshot(): QueueTrackDto[];
  clear(): void;
};

export function createPlaybackHistory(limit = 20): PlaybackHistory {
  let tracks: QueueTrackDto[] = [];

  return {
    record(track) {
      tracks = [...tracks.filter((item) => item.id !== track.id), track].slice(-limit);
    },
    restore(queue) {
      const previous = tracks.pop();
      if (!previous) return queue;
      return [previous, ...queue.filter((track) => track.id !== previous.id)];
    },
    snapshot() {
      return [...tracks];
    },
    clear() {
      tracks = [];
    }
  };
}
