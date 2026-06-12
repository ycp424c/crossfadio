import { getDb } from './db.js';

export type MusicEntityType = 'track' | 'artist' | 'album' | 'playlist' | 'chart_item';
export type MusicEntityProvider = 'ncm' | 'catalog' | 'llm_verified';

export type MusicEntityRecord = {
  userId: string;
  id: string;
  type: MusicEntityType;
  provider: MusicEntityProvider;
  providerId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  description: string;
  styleHints: string[];
  constraints: string[];
  sourceSignals: string[];
  lastVerifiedAt: string | null;
  selectedCount: number;
  skippedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertMusicEntityInput = {
  userId: string;
  id: string;
  type: MusicEntityType;
  provider: MusicEntityProvider;
  providerId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  description: string;
  styleHints?: string[];
  constraints?: string[];
  sourceSignals?: string[];
  lastVerifiedAt?: string | null;
};

export type MusicEntityFeedbackInput = {
  userId: string;
  entityId: string;
  selectedCount?: number;
  skippedCount?: number;
  usedAt?: string;
};

export type UpsertMusicEntityEmbeddingInput = {
  userId: string;
  entityId: string;
  model: string;
  vector: Float32Array | number[];
};

export type FindSimilarMusicEntitiesInput = {
  userId: string;
  model: string;
  vector: Float32Array | number[];
  limit: number;
};

export type MusicEntitySimilarityMatch = {
  entity: MusicEntityRecord;
  score: number;
};

type MusicEntityRow = {
  user_id: string;
  id: string;
  type: string;
  provider: string;
  provider_id: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  description: string;
  style_hints_json: string;
  constraints_json: string;
  source_signals_json: string;
  last_verified_at: string | null;
  selected_count: number;
  skipped_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

type EmbeddingRow = MusicEntityRow & {
  model: string;
  dimensions: number;
  vector: Buffer;
};

export function upsertMusicEntity(input: UpsertMusicEntityInput): void {
  const entity = normalizeEntityInput(input);
  if (!entity.userId || !entity.id || !entity.description) return;
  getDb().prepare(
    `INSERT INTO music_entities (
       user_id, id, type, provider, provider_id, title, artist, album,
       description, style_hints_json, constraints_json, source_signals_json,
       last_verified_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, id) DO UPDATE SET
       type = excluded.type,
       provider = excluded.provider,
       provider_id = excluded.provider_id,
       title = excluded.title,
       artist = excluded.artist,
       album = excluded.album,
       description = excluded.description,
       style_hints_json = excluded.style_hints_json,
       constraints_json = excluded.constraints_json,
       source_signals_json = excluded.source_signals_json,
       last_verified_at = excluded.last_verified_at,
       updated_at = datetime('now')`
  ).run(
    entity.userId,
    entity.id,
    entity.type,
    entity.provider,
    entity.providerId,
    entity.title,
    entity.artist,
    entity.album,
    entity.description,
    JSON.stringify(entity.styleHints),
    JSON.stringify(entity.constraints),
    JSON.stringify(entity.sourceSignals),
    entity.lastVerifiedAt
  );
}

export function getMusicEntity(userId: string, id: string): MusicEntityRecord | null {
  const row = getDb().prepare<[string, string], MusicEntityRow>(
    `SELECT *
     FROM music_entities
     WHERE user_id = ? AND id = ?`
  ).get(userId, id);
  return row ? musicEntityFromRow(row) : null;
}

export function listUserMusicEntities(userId: string, options: { type?: MusicEntityType; limit?: number } = {}): MusicEntityRecord[] {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const rows = options.type
    ? getDb().prepare<[string, string, number], MusicEntityRow>(
      `SELECT *
       FROM music_entities
       WHERE user_id = ? AND type = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    ).all(userId, options.type, limit)
    : getDb().prepare<[string, number], MusicEntityRow>(
      `SELECT *
       FROM music_entities
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    ).all(userId, limit);
  return rows.map(musicEntityFromRow);
}

export function recordMusicEntityFeedback(input: MusicEntityFeedbackInput): void {
  const selectedCount = nonNegativeInt(input.selectedCount ?? 0);
  const skippedCount = nonNegativeInt(input.skippedCount ?? 0);
  getDb().prepare(
    `UPDATE music_entities
     SET selected_count = selected_count + ?,
         skipped_count = skipped_count + ?,
         last_used_at = ?,
         updated_at = datetime('now')
     WHERE user_id = ? AND id = ?`
  ).run(
    selectedCount,
    skippedCount,
    input.usedAt ?? new Date().toISOString(),
    input.userId.trim(),
    input.entityId.trim()
  );
}

export function upsertMusicEntityEmbedding(input: UpsertMusicEntityEmbeddingInput): void {
  const userId = input.userId.trim();
  const entityId = input.entityId.trim();
  const model = input.model.trim();
  const vector = toFloat32Array(input.vector);
  if (!userId || !entityId || !model || vector.length === 0) return;
  if (!getMusicEntity(userId, entityId)) return;

  getDb().prepare(
    `INSERT INTO music_entity_embeddings (
       user_id, entity_id, model, dimensions, vector, updated_at
     )
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, entity_id, model) DO UPDATE SET
       dimensions = excluded.dimensions,
       vector = excluded.vector,
       updated_at = datetime('now')`
  ).run(userId, entityId, model, vector.length, encodeVector(vector));
}

export function findSimilarMusicEntities(input: FindSimilarMusicEntitiesInput): MusicEntitySimilarityMatch[] {
  const queryVector = toFloat32Array(input.vector);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
  if (!input.userId.trim() || !input.model.trim() || queryVector.length === 0) return [];

  const rows = getDb().prepare<[string, string], EmbeddingRow>(
    `SELECT e.*, emb.model, emb.dimensions, emb.vector
     FROM music_entity_embeddings emb
     JOIN music_entities e
       ON e.user_id = emb.user_id AND e.id = emb.entity_id
     WHERE emb.user_id = ? AND emb.model = ?`
  ).all(input.userId.trim(), input.model.trim());

  return rows
    .filter((row) => row.dimensions === queryVector.length)
    .map((row) => ({
      entity: musicEntityFromRow(row),
      score: cosineSimilarity(queryVector, decodeVector(row.vector, row.dimensions))
    }))
    .filter((match) => Number.isFinite(match.score))
    .sort((left, right) => right.score - left.score || left.entity.id.localeCompare(right.entity.id))
    .slice(0, limit);
}

function normalizeEntityInput(input: UpsertMusicEntityInput): Required<UpsertMusicEntityInput> {
  return {
    userId: input.userId.trim(),
    id: input.id.trim(),
    type: input.type,
    provider: input.provider,
    providerId: stringOrNull(input.providerId),
    title: stringOrNull(input.title),
    artist: stringOrNull(input.artist),
    album: stringOrNull(input.album),
    description: input.description.trim(),
    styleHints: uniqueStrings(input.styleHints ?? []),
    constraints: uniqueStrings(input.constraints ?? []),
    sourceSignals: uniqueStrings(input.sourceSignals ?? []),
    lastVerifiedAt: stringOrNull(input.lastVerifiedAt)
  };
}

function musicEntityFromRow(row: MusicEntityRow): MusicEntityRecord {
  return {
    userId: row.user_id,
    id: row.id,
    type: row.type as MusicEntityType,
    provider: row.provider as MusicEntityProvider,
    providerId: row.provider_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    description: row.description,
    styleHints: parseStringArray(row.style_hints_json),
    constraints: parseStringArray(row.constraints_json),
    sourceSignals: parseStringArray(row.source_signals_json),
    lastVerifiedAt: row.last_verified_at,
    selectedCount: row.selected_count,
    skippedCount: row.skipped_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function encodeVector(vector: Float32Array): Buffer {
  const copy = new Float32Array(vector.length);
  copy.set(vector);
  return Buffer.from(copy.buffer);
}

function decodeVector(buffer: Buffer, dimensions: number): Float32Array {
  if (buffer.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    return new Float32Array();
  }
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(bytes);
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NaN;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function toFloat32Array(value: Float32Array | number[]): Float32Array {
  return value instanceof Float32Array ? value : Float32Array.from(value);
}

function stringOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? uniqueStrings(parsed.map((item) => typeof item === 'string' ? item : '')) : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
