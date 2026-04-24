import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'Crossfadio';
const APP_DIR_NAME = '.crossfadio';

export function resolveAppDataDir(): string {
  const override = process.env.CROSSFADIO_DATA_DIR?.trim();
  const root = override || defaultAppDataDir();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function resolveStateDbPath(): string {
  return path.join(resolveAppDataDir(), 'state.db');
}

export function resolveSecretsFilePath(): string {
  return path.join(resolveAppDataDir(), 'secrets.json');
}

export function resolveLogsDir(): string {
  const logsDir = path.join(resolveAppDataDir(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function resolveUserCorpusDir(): string {
  const userDir = path.join(resolveAppDataDir(), 'user');
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}

export function resolveUserTemplateDir(): string {
  return path.resolve(process.cwd(), 'user-template');
}

function defaultAppDataDir(): string {
  const home = os.homedir();

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    default:
      return path.join(home, APP_DIR_NAME);
  }
}
