import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export type DjConfigurationEntry = {
  id: string;
  userId: string;
  kind: string;
  entryKey: string;
  value: unknown;
  sourceKind: string;
  createdAt: string;
  updatedAt: string;
};

export function upsertDjConfigurationEntry(input: {
  userId: string;
  kind: string;
  entryKey: string;
  value: unknown;
  sourceKind: string;
}): DjConfigurationEntry {
  getDb().prepare(`
    INSERT INTO dj_configuration_entries (
      id, user_id, kind, entry_key, value_json, source_kind, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, kind, entry_key) WHERE deleted_at IS NULL DO UPDATE SET
      value_json = excluded.value_json,
      source_kind = excluded.source_kind,
      updated_at = datetime('now')
  `).run(
    randomUUID(),
    input.userId,
    input.kind,
    input.entryKey,
    JSON.stringify(input.value),
    input.sourceKind
  );

  const row = getDb().prepare(`
    SELECT *
    FROM dj_configuration_entries
    WHERE user_id = ? AND kind = ? AND entry_key = ? AND deleted_at IS NULL
  `).get(input.userId, input.kind, input.entryKey) as DjConfigurationRow;
  return mapDjConfiguration(row);
}

export function insertDjConfigurationEntryIfAbsent(input: {
  userId: string;
  kind: string;
  entryKey: string;
  value: unknown;
  sourceKind: string;
}): DjConfigurationEntry {
  getDb().prepare(`
    INSERT INTO dj_configuration_entries (
      id, user_id, kind, entry_key, value_json, source_kind, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, kind, entry_key) WHERE deleted_at IS NULL DO NOTHING
  `).run(
    randomUUID(),
    input.userId,
    input.kind,
    input.entryKey,
    JSON.stringify(input.value),
    input.sourceKind
  );

  const row = getDb().prepare(`
    SELECT *
    FROM dj_configuration_entries
    WHERE user_id = ? AND kind = ? AND entry_key = ? AND deleted_at IS NULL
  `).get(input.userId, input.kind, input.entryKey) as DjConfigurationRow;
  return mapDjConfiguration(row);
}

export function listDjConfigurationEntries(userId: string): DjConfigurationEntry[] {
  return (getDb().prepare(`
    SELECT *
    FROM dj_configuration_entries
    WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY kind, entry_key
  `).all(userId) as DjConfigurationRow[]).map(mapDjConfiguration);
}

type DjConfigurationRow = {
  id: string;
  user_id: string;
  kind: string;
  entry_key: string;
  value_json: string;
  source_kind: string;
  created_at: string;
  updated_at: string;
};

function mapDjConfiguration(row: DjConfigurationRow): DjConfigurationEntry {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    entryKey: row.entry_key,
    value: JSON.parse(row.value_json) as unknown,
    sourceKind: row.source_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
