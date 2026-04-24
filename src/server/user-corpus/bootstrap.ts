import fs from 'node:fs';
import path from 'node:path';
import { resolveUserCorpusDir, resolveUserTemplateDir } from '../app-paths.js';

export function ensureUserCorpus(): void {
  const userDir = resolveUserCorpusDir();
  const templateDir = resolveUserTemplateDir();
  fs.mkdirSync(userDir, { recursive: true });

  if (!fs.existsSync(templateDir)) {
    return;
  }

  const templateEntries = fs.readdirSync(templateDir, { withFileTypes: true });
  for (const entry of templateEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const source = path.join(templateDir, entry.name);
    const target = path.join(userDir, entry.name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}
