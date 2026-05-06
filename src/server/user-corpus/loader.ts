import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveUserDir } from '../app-paths.js';
import { playlistRefSchema } from '../agent/schema.js';
import { getLogger } from '../logger.js';

const playlistsSchema = z.array(playlistRefSchema);

export type PlaylistEntry = z.infer<typeof playlistRefSchema>;

export function loadPlaylists(ncmId: string): PlaylistEntry[] {
  const filePath = path.join(resolveUserDir(ncmId), 'playlists.json');
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = playlistsSchema.safeParse(parsed);
    if (!result.success) {
      getLogger().warn({ err: result.error }, 'playlists.json failed validation, using empty list');
      return [];
    }
    return result.data;
  } catch (err) {
    getLogger().warn({ err }, 'Failed to read playlists.json');
    return [];
  }
}

export function loadCorpusFile(ncmId: string, filename: string): string {
  const filePath = path.join(resolveUserDir(ncmId), filename);
  if (!fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export type UserCorpus = {
  taste: string;
  routines: string;
  moodRules: string;
  djPersona: string;
  playlists: PlaylistEntry[];
};

export function loadUserCorpus(ncmId: string): UserCorpus {
  return {
    taste: loadCorpusFile(ncmId, 'taste.md'),
    routines: loadCorpusFile(ncmId, 'routines.md'),
    moodRules: loadCorpusFile(ncmId, 'mood-rules.md'),
    djPersona: loadCorpusFile(ncmId, 'dj-persona.md'),
    playlists: loadPlaylists(ncmId)
  };
}
