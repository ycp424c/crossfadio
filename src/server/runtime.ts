import fs from 'node:fs';
import path from 'node:path';

type ResolveStaticDirOptions = {
  rootDir: string;
  nodeEnv?: string;
};

export function resolveStaticDir(options: ResolveStaticDirOptions): string | null {
  const staticDir = path.resolve(options.rootDir, 'dist');

  if (options.nodeEnv === 'production' || fs.existsSync(staticDir)) {
    return fs.existsSync(staticDir) ? staticDir : null;
  }

  return null;
}
