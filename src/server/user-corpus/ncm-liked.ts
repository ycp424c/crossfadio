import type { Track } from '../agent/schema.js';
import type { NcmClient } from '../ncm/client.js';

type LikedCapableNcmClient = Pick<NcmClient, 'getLikedSongIds' | 'getSongDetails'>;

export async function loadLikedTracksForPlanning(
  ncmClient: Partial<LikedCapableNcmClient>,
  limit = 50
): Promise<Track[]> {
  if (typeof ncmClient.getLikedSongIds !== 'function' || typeof ncmClient.getSongDetails !== 'function') {
    return [];
  }

  try {
    const ids = (await ncmClient.getLikedSongIds()).slice(0, limit);
    const details = await ncmClient.getSongDetails(ids);
    return details.slice(0, limit).map((track) => ({
      id: String(track.id),
      name: track.name,
      artist: track.artists.join(' / ') || undefined
    }));
  } catch {
    return [];
  }
}
