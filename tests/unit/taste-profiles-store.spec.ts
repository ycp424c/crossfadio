import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-taste-profiles-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Taste Profile store', () => {
  it('keeps immutable versions and returns the newest profile', async () => {
    const { getCurrentTasteProfile, saveTasteProfile } = await import(
      '../../src/server/store/taste-profiles.js'
    );
    const first = saveTasteProfile({
      userId: 'user-a',
      profile: { summary: '偏好 City Pop', likedCount: 10, analyzedCount: 10 },
      sourceKind: 'liked_library',
      sourceLibraryHash: 'hash-a',
      generatedAt: '2026-07-17T04:00:00.000Z'
    });
    const second = saveTasteProfile({
      userId: 'user-a',
      profile: { summary: '偏好 City Pop 与 Dream Pop', likedCount: 12, analyzedCount: 12 },
      sourceKind: 'liked_library',
      sourceLibraryHash: 'hash-b',
      generatedAt: '2026-07-17T05:00:00.000Z'
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(getCurrentTasteProfile('user-a')).toEqual(expect.objectContaining({
      id: second.id,
      version: 2,
      sourceKind: 'liked_library',
      profile: expect.objectContaining({ summary: '偏好 City Pop 与 Dream Pop' })
    }));
  });
});
