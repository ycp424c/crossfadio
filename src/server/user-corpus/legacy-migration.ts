import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDir } from '../app-paths.js';
import { insertDjConfigurationEntryIfAbsent } from '../store/dj-configuration.js';
import { getCurrentTasteProfile, saveTasteProfile } from '../store/taste-profiles.js';
import { getDb } from '../store/db.js';

const LEGACY_CORPUS_IMPORT_VERSION = 1;

const LEGACY_DEFAULTS = {
  'taste.md': '# 我的音乐口味\n\n- 喜欢：独立流行、电子氛围、器乐后摇\n- 不想听：过于嘈杂、低质量现场录音',
  'routines.md': '# 我的作息\n\n- 09:00-12:00: 通勤 + 开始工作\n- 13:30-18:30: 高强度专注\n- 21:00-01:00: 深夜写代码',
  'mood-rules.md': '# 心情规则\n\n- 焦虑时：降低 BPM，增加器乐占比\n- 需要提神时：提高节奏与明亮度'
} as const;

export function migrateLegacyUserCorpus(userId: string): void {
  const migrationKey = legacyCorpusMigrationKey(userId);
  if (isMigrationCompleted(migrationKey)) return;
  const userDir = resolveUserDir(userId);
  migrateLegacyTaste(userId, readNormalized(path.join(userDir, 'taste.md')));
  migrateLegacyTextConfig(
    userId,
    'routines',
    readNormalized(path.join(userDir, 'routines.md')),
    LEGACY_DEFAULTS['routines.md']
  );
  migrateLegacyTextConfig(
    userId,
    'mood_rules',
    readNormalized(path.join(userDir, 'mood-rules.md')),
    LEGACY_DEFAULTS['mood-rules.md']
  );
  migrateConfigurationFile(userId, 'persona', 'default', path.join(userDir, 'dj-persona.md'));
  migrateJsonConfigurationFile(userId, 'playlists', 'default', path.join(userDir, 'playlists.json'));
  markMigrationCompleted(migrationKey);
}

function legacyCorpusMigrationKey(userId: string): string {
  return `legacy_corpus_import_v${LEGACY_CORPUS_IMPORT_VERSION}:${userId}`;
}

function isMigrationCompleted(key: string): boolean {
  return getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(key) !== undefined;
}

function markMigrationCompleted(key: string): void {
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES (?, 'completed')
    ON CONFLICT(key) DO NOTHING
  `).run(key);
}

function migrateLegacyTaste(userId: string, content: string): void {
  if (!content || content === LEGACY_DEFAULTS['taste.md']) return;
  if (getCurrentTasteProfile(userId)) return;
  const contentHash = hashContent(content);
  saveTasteProfile({
    userId,
    profile: { summary: content, likedCount: 0, analyzedCount: 0 },
    sourceKind: 'legacy_taste_md',
    sourceLibraryHash: contentHash
  });
}

function migrateLegacyTextConfig(
  userId: string,
  entryKey: string,
  content: string,
  defaultContent: string
): void {
  if (!content || content === defaultContent) return;
  insertDjConfigurationEntryIfAbsent({
    userId,
    kind: 'legacy_user_config',
    entryKey,
    value: { text: content },
    sourceKind: 'legacy_user_config'
  });
}

function migrateConfigurationFile(
  userId: string,
  kind: string,
  entryKey: string,
  filePath: string
): void {
  const content = readNormalized(filePath);
  if (!content) return;
  insertDjConfigurationEntryIfAbsent({
    userId,
    kind,
    entryKey,
    value: { text: content },
    sourceKind: 'user_corpus'
  });
}

function migrateJsonConfigurationFile(
  userId: string,
  kind: string,
  entryKey: string,
  filePath: string
): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    insertDjConfigurationEntryIfAbsent({
      userId,
      kind,
      entryKey,
      value,
      sourceKind: 'user_corpus'
    });
  } catch {
    // Invalid legacy configuration is ignored; v2 never loads it directly.
  }
}

function readNormalized(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch {
    return '';
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
