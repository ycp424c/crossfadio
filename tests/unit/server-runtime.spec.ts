import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStaticDir } from '../../src/server/runtime';

describe('resolveStaticDir', () => {
  it('serves built static assets when dist exists even without NODE_ENV=production', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-runtime-'));
    const distDir = path.join(rootDir, 'dist');
    fs.mkdirSync(distDir);

    expect(resolveStaticDir({ rootDir, nodeEnv: undefined })).toBe(distDir);
  });

  it('does not serve missing static assets in development', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-runtime-'));

    expect(resolveStaticDir({ rootDir, nodeEnv: 'development' })).toBeNull();
  });
});
