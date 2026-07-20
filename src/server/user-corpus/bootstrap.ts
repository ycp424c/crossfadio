import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDir, resolveUserTemplateDir } from '../app-paths.js';
import { migrateLegacyUserCorpus } from './legacy-migration.js';

const BOOTSTRAP_FILES = new Set(['dj-persona.md', 'playlists.json']);

export function ensureUserCorpus(ncmId?: string): void {
  const userDir = ncmId ? resolveUserDir(ncmId) : resolveUserDir('__legacy__');
  const templateDir = resolveUserTemplateDir();

  if (!fs.existsSync(templateDir)) return;

  const templateEntries = fs.readdirSync(templateDir, { withFileTypes: true });
  for (const entry of templateEntries) {
    if (!entry.isFile() || !BOOTSTRAP_FILES.has(entry.name)) continue;
    const source = path.join(templateDir, entry.name);
    const target = path.join(userDir, entry.name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
  migrateLegacyUserCorpus(ncmId ?? '__legacy__');
}
