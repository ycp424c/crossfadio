import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _flushLikedProfileRefreshesForTest,
  _resetLikedRecallCacheForTest,
  getCachedLikedProfile,
  getLikedRecallTracks,
  sampleLikedRecallIds
} from '../../src/server/music-agent/liked-recall';

describe('MusicAgent liked recall', () => {
  beforeEach(() => {
    _resetLikedRecallCacheForTest();
  });

  it('caches liked ids and fetched track details by user', async () => {
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['1', '2', '3']),
      getSongDetails: vi.fn(async (ids: string[]) => ids.map((id) => ({
        id,
        name: `Song ${id}`,
        artists: [`Artist ${id}`]
      })))
    };

    expect(await getLikedRecallTracks({ userId: 'u1', ncmClient }, 3)).toEqual([
      { id: '1', name: 'Song 1', artists: ['Artist 1'] },
      { id: '2', name: 'Song 2', artists: ['Artist 2'] },
      { id: '3', name: 'Song 3', artists: ['Artist 3'] }
    ]);
    expect(await getLikedRecallTracks({ userId: 'u1', ncmClient }, 3)).toHaveLength(3);
    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(1);
  });

  it('returns aborted after liked ids load if the parent signal is aborted', async () => {
    const controller = new AbortController();
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => {
        controller.abort();
        return ['1'];
      }),
      getSongDetails: vi.fn(async () => [])
    };

    await expect(getLikedRecallTracks({ userId: 'u1', ncmClient }, 1, controller.signal)).resolves.toBe('aborted');
    expect(ncmClient.getSongDetails).not.toHaveBeenCalled();
  });

  it('samples without changing the original liked id list', () => {
    const ids = ['1', '2', '3'];

    expect(sampleLikedRecallIds(ids, 5)).toEqual(['1', '2', '3']);
    expect(ids).toEqual(['1', '2', '3']);
  });

  it('builds a cached liked profile with full ids and capped artist details', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => String(index + 1));
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ids),
      getSongDetails: vi.fn(async (batchIds: string[]) => batchIds.map((id) => ({
        id,
        name: `Song ${id}`,
        artists: id === '1' ? ['Liked Artist / Guest Artist'] : [`Artist ${id}`]
      })))
    };

    const input = { userId: 'profile-user', ncmClient };
    const profile = await getCachedLikedProfile(input);
    const cached = await getCachedLikedProfile(input);

    expect([...profile.ids]).toEqual(ids);
    expect(profile.artistKeys.has('liked artist')).toBe(true);
    expect(profile.artistKeys.has('guest artist')).toBe(true);
    expect(profile.artistKeys.has('artist 201')).toBe(false);
    expect(ncmClient.getLikedSongIds).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(1, ids.slice(0, 200));

    profile.ids.clear();
    profile.artistKeys.clear();
    expect(cached.ids.size).toBe(201);
    expect(cached.artistKeys.has('liked artist')).toBe(true);

    await _flushLikedProfileRefreshesForTest();
    const refreshed = await getCachedLikedProfile(input);
    expect(ncmClient.getSongDetails).toHaveBeenCalledTimes(2);
    expect(ncmClient.getSongDetails).toHaveBeenNthCalledWith(2, ids.slice(200));
    expect(refreshed.artistKeys.has('artist 201')).toBe(true);
  });
});
