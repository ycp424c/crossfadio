import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveUserCorpusDir } from '../app-paths.js';
import { playlistRefSchema } from '../agent/schema.js';
import { getLogger } from '../logger.js';

const playlistsSchema = z.array(playlistRefSchema);

export type PlaylistEntry = z.infer<typeof playlistRefSchema>;

export function loadPlaylists(): PlaylistEntry[] {
  const filePath = path.join(resolveUserCorpusDir(), 'playlists.json');
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

export function loadCorpusFile(filename: string): string {
  const filePath = path.join(resolveUserCorpusDir(), filename);
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

export function loadUserCorpus(): UserCorpus {
  return {
    taste: loadCorpusFile('taste.md'),
    routines: loadCorpusFile('routines.md'),
    moodRules: loadCorpusFile('mood-rules.md'),
    djPersona: loadCorpusFile('dj-persona.md'),
    playlists: loadPlaylists()
  };
}
