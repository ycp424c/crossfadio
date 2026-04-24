import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAppDataDir } from '../app-paths.js';

export type TtsCacheKey = {
  endpoint: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
  text: string;
};

export function buildCacheHash(key: TtsCacheKey): string {
  const serialized = JSON.stringify(key, Object.keys(key).sort());
  return createHash('sha256').update(serialized).digest('hex');
}

export function getTtsCacheDir(): string {
  return path.join(resolveAppDataDir(), 'cache', 'tts');
}

export function getCachedFilePath(hash: string, format: string | string[]): string | null {
  const formats = Array.isArray(format) ? format : [format];

  for (const item of formats) {
    const filePath = path.join(getTtsCacheDir(), `${hash}.${item}`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

export function saveToCache(hash: string, format: string, data: Buffer): string {
  const dir = getTtsCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.${format}`);
  fs.writeFileSync(filePath, data);
  return filePath;
}
