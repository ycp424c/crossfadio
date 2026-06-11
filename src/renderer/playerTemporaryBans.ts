import type { QueueTrackDto } from '@shared/schema';

export function mergeQueueTracksById(tracks: QueueTrackDto[]): QueueTrackDto[] {
  return [...new Map(tracks.filter((track) => track.id).map((track) => [track.id, track])).values()];
}
