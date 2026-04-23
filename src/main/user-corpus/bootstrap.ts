import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const TEMPLATE_DIR = path.resolve(__dirname, '../../../user-template');

export function ensureUserCorpus(): void {
  const userDir = path.join(app.getPath('userData'), 'user');
  fs.mkdirSync(userDir, { recursive: true });

  if (!fs.existsSync(TEMPLATE_DIR)) {
    return;
  }

  const templateEntries = fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true });
  for (const entry of templateEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const source = path.join(TEMPLATE_DIR, entry.name);
    const target = path.join(userDir, entry.name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}
