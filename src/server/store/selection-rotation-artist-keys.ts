import { SELECTION_ROTATION_ARTIST_KEY_LIMIT } from '../../shared/dj-memory.js';
import { explicitArtistKeys } from '../music-agent/artists.js';

const SELECTION_ROTATION_ARTIST_KEY_MAX_LENGTH = 300;

export function buildSelectionRotationArtistKeys(artistDisplay: string): string[] {
  return normalizeSelectionRotationArtistKeys([artistDisplay]);
}

export function parseSelectionRotationArtistKeys(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeSelectionRotationArtistKeys(parsed)
      : [];
  } catch {
    return [];
  }
}

function normalizeSelectionRotationArtistKeys(values: readonly unknown[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const artistKey of explicitArtistKeys(value)) {
      if (artistKey.length > SELECTION_ROTATION_ARTIST_KEY_MAX_LENGTH) continue;
      normalized.add(artistKey);
      if (normalized.size >= SELECTION_ROTATION_ARTIST_KEY_LIMIT) {
        return [...normalized];
      }
    }
  }
  return [...normalized];
}
