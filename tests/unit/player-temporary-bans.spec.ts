import { describe, expect, it } from 'vitest';
import { mergeQueueTracksById } from '../../src/renderer/playerTemporaryBans';
import type { QueueTrackDto } from '../../src/shared/schema';

function track(id: string, name: string): QueueTrackDto {
  return {
    id,
    name,
    artists: [`${name} Artist`],
    durationMs: 180_000,
    coverImgUrl: null
  };
}

describe('player temporary queue bans', () => {
  it('deduplicates skipped and removed tracks by id while keeping the latest track metadata', () => {
    const merged = mergeQueueTracksById([
      track('skip-1', 'First Skip'),
      track('remove-1', 'Removed'),
      track('skip-1', 'Updated Skip')
    ]);

    expect(merged.map((item) => [item.id, item.name])).toEqual([
      ['skip-1', 'Updated Skip'],
      ['remove-1', 'Removed']
    ]);
  });
});
