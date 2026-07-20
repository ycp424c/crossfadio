import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-corpus-migration-'));
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

describe('legacy corpus migration', () => {
  it('ignores untouched examples and imports only customized personal content once', async () => {
    const { resolveUserDir } = await import('../../src/server/app-paths.js');
    const { migrateLegacyUserCorpus } = await import(
      '../../src/server/user-corpus/legacy-migration.js'
    );
    const { getCurrentTasteProfile } = await import('../../src/server/store/taste-profiles.js');
    const { getDb } = await import('../../src/server/store/db.js');
    const { listDjConfigurationEntries } = await import(
      '../../src/server/store/dj-configuration.js'
    );
    const userDir = resolveUserDir('user-a');
    fs.writeFileSync(
      path.join(userDir, 'taste.md'),
      '# 我的音乐口味\n\n- 喜欢：独立流行、电子氛围、器乐后摇\n- 不想听：过于嘈杂、低质量现场录音\n'
    );
    fs.writeFileSync(path.join(userDir, 'routines.md'), '# 我的真实作息\n\n- 深夜阅读\n');
    fs.writeFileSync(
      path.join(userDir, 'mood-rules.md'),
      '# 心情规则\n\n- 焦虑时：降低 BPM，增加器乐占比\n- 需要提神时：提高节奏与明亮度\n'
    );

    migrateLegacyUserCorpus('user-a');
    migrateLegacyUserCorpus('user-a');

    expect(getCurrentTasteProfile('user-a')).toBeNull();
    expect(listDjConfigurationEntries('user-a')).toEqual([
      expect.objectContaining({
        kind: 'legacy_user_config',
        entryKey: 'routines',
        value: { text: '# 我的真实作息\n\n- 深夜阅读' }
      })
    ]);
    expect(getDb().prepare(
      'SELECT value FROM meta WHERE key = ?'
    ).get('legacy_corpus_import_v1:user-a')).toEqual({ value: 'completed' });
  });

  it('never overwrites SQLite configuration or taste that already became the source of truth', async () => {
    const { resolveUserDir } = await import('../../src/server/app-paths.js');
    const { migrateLegacyUserCorpus } = await import(
      '../../src/server/user-corpus/legacy-migration.js'
    );
    const {
      listDjConfigurationEntries,
      upsertDjConfigurationEntry
    } = await import('../../src/server/store/dj-configuration.js');
    const { getCurrentTasteProfile, saveTasteProfile } = await import(
      '../../src/server/store/taste-profiles.js'
    );
    const userDir = resolveUserDir('operator-owned');
    fs.writeFileSync(path.join(userDir, 'taste.md'), '# Legacy taste\n\n- old file');
    fs.writeFileSync(path.join(userDir, 'routines.md'), '# Legacy routine');
    fs.writeFileSync(path.join(userDir, 'dj-persona.md'), '# Legacy persona');
    fs.writeFileSync(path.join(userDir, 'playlists.json'), JSON.stringify({ legacy: true }));
    upsertDjConfigurationEntry({
      userId: 'operator-owned', kind: 'legacy_user_config', entryKey: 'routines',
      value: { text: '# SQLite routine' }, sourceKind: 'operator'
    });
    upsertDjConfigurationEntry({
      userId: 'operator-owned', kind: 'persona', entryKey: 'default',
      value: { text: '# SQLite persona' }, sourceKind: 'operator'
    });
    upsertDjConfigurationEntry({
      userId: 'operator-owned', kind: 'playlists', entryKey: 'default',
      value: { sqlite: true }, sourceKind: 'operator'
    });
    saveTasteProfile({
      userId: 'operator-owned',
      profile: { summary: 'SQLite taste', likedCount: 10, analyzedCount: 10 },
      sourceKind: 'liked_library',
      sourceLibraryHash: 'library-v1'
    });

    migrateLegacyUserCorpus('operator-owned');

    expect(listDjConfigurationEntries('operator-owned')).toEqual([
      expect.objectContaining({
        kind: 'legacy_user_config', entryKey: 'routines',
        value: { text: '# SQLite routine' }, sourceKind: 'operator'
      }),
      expect.objectContaining({
        kind: 'persona', entryKey: 'default',
        value: { text: '# SQLite persona' }, sourceKind: 'operator'
      }),
      expect.objectContaining({
        kind: 'playlists', entryKey: 'default',
        value: { sqlite: true }, sourceKind: 'operator'
      })
    ]);
    expect(getCurrentTasteProfile('operator-owned')).toMatchObject({
      version: 1,
      profile: { summary: 'SQLite taste', likedCount: 10, analyzedCount: 10 },
      sourceKind: 'liked_library'
    });
  });

  it('imports each legacy value only once even if the legacy file later changes', async () => {
    const { resolveUserDir } = await import('../../src/server/app-paths.js');
    const { migrateLegacyUserCorpus } = await import(
      '../../src/server/user-corpus/legacy-migration.js'
    );
    const { listDjConfigurationEntries } = await import(
      '../../src/server/store/dj-configuration.js'
    );
    const { getCurrentTasteProfile } = await import('../../src/server/store/taste-profiles.js');
    const userDir = resolveUserDir('one-time');
    fs.writeFileSync(path.join(userDir, 'taste.md'), '# First taste');
    fs.writeFileSync(path.join(userDir, 'routines.md'), '# First routine');
    migrateLegacyUserCorpus('one-time');

    fs.writeFileSync(path.join(userDir, 'taste.md'), '# Changed legacy taste');
    fs.writeFileSync(path.join(userDir, 'routines.md'), '# Changed legacy routine');
    migrateLegacyUserCorpus('one-time');

    expect(getCurrentTasteProfile('one-time')).toMatchObject({
      version: 1,
      profile: { summary: '# First taste' }
    });
    expect(listDjConfigurationEntries('one-time')).toEqual([
      expect.objectContaining({
        kind: 'legacy_user_config', entryKey: 'routines', value: { text: '# First routine' }
      })
    ]);
  });
});
