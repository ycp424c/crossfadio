import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

export const exclusionSourceRefSchema = z.object({
  messageId: z.number().int().positive().optional(),
  actionId: z.string().trim().min(1).max(100).optional(),
  sourceId: z.string().trim().min(1).max(200).optional()
}).strict().refine(
  (value) => value.messageId !== undefined
    || value.actionId !== undefined
    || value.sourceId !== undefined,
  'Exclusion source ref must identify a source'
);

const createExplicitExclusionSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  entityType: z.enum(['track', 'artist']),
  entityKey: z.string().trim().min(1).max(300),
  provider: z.string().trim().min(1).max(40).nullable().optional(),
  providerId: z.string().trim().min(1).max(200).nullable().optional(),
  displayName: z.string().trim().min(1).max(300).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  sourceKind: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  sourceRef: exclusionSourceRefSchema,
  createdAt: z.string().datetime({ offset: true }).optional()
}).strict();

const revokeExplicitExclusionSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  entityType: z.enum(['track', 'artist']),
  entityKey: z.string().trim().min(1).max(300),
  sourceRef: exclusionSourceRefSchema,
  revokedAt: z.string().datetime({ offset: true }).optional()
}).strict();

export type ExclusionSourceRef = z.infer<typeof exclusionSourceRefSchema>;
export type CreateExplicitExclusionInput = z.input<typeof createExplicitExclusionSchema>;

export type ExplicitExclusionRecord = {
  id: string;
  userId: string;
  entityType: 'track' | 'artist';
  entityKey: string;
  provider: string | null;
  providerId: string | null;
  displayName: string | null;
  aliases: string[];
  sourceKind: string;
  sourceRef: ExclusionSourceRef | null;
  createdAt: string;
  revokedAt: string | null;
  revocationSourceRef: ExclusionSourceRef | null;
};

export type CreateExplicitExclusionResult = {
  created: boolean;
  exclusion: ExplicitExclusionRecord;
};

export type ExplicitExclusionTrackIdentity = {
  id: string;
  name: string;
  artists: string[];
};

export function explicitTrackExclusionPolicyKeys(input: {
  entityKey: string;
  provider?: string | null;
  providerId?: string | null;
}): { trackIds: string[]; trackKeys: string[] } {
  const trackIds = input.provider === 'ncm' && input.providerId?.trim()
    ? [input.providerId.trim()]
    : input.entityKey.startsWith('ncm:')
      ? [input.entityKey.slice('ncm:'.length)]
      : [];
  const key = normalizeExclusionKey(input.entityKey);
  if (key.includes('::')) return { trackIds, trackKeys: [key] };
  const legacySeparator = key.lastIndexOf('___');
  if (legacySeparator > 0) {
    return {
      trackIds,
      trackKeys: [canonicalTrackKey(
        key.slice(0, legacySeparator),
        key.slice(legacySeparator + 3)
      )]
    };
  }
  return { trackIds, trackKeys: [] };
}

export function createExplicitExclusion(
  input: CreateExplicitExclusionInput
): CreateExplicitExclusionResult {
  const parsed = createExplicitExclusionSchema.parse(input);
  const id = randomUUID();
  const entityKey = normalizeExclusionKey(parsed.entityKey);
  const aliases = [...new Set([
    entityKey,
    ...(parsed.aliases ?? []).map(normalizeExclusionKey)
  ].filter(Boolean))];
  const result = getDb().prepare(
    `INSERT INTO explicit_exclusions (
      id, user_id, entity_type, entity_key, provider, provider_id, display_name,
      source_kind, source_ref_json, created_at, revoked_at, revocation_source_ref_json,
      aliases_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT DO NOTHING`
  ).run(
    id,
    parsed.userId,
    parsed.entityType,
    entityKey,
    parsed.provider ?? null,
    parsed.providerId ?? null,
    parsed.displayName ?? null,
    parsed.sourceKind,
    JSON.stringify(parsed.sourceRef),
    parsed.createdAt ?? new Date().toISOString(),
    JSON.stringify(aliases)
  );
  const exclusion = getActiveExplicitExclusion(
    parsed.userId,
    parsed.entityType,
    entityKey
  );
  if (!exclusion) throw new Error('Explicit Exclusion was not persisted');
  return { created: result.changes === 1, exclusion };
}

export function getActiveExplicitExclusion(
  userId: string,
  entityType: 'track' | 'artist',
  entityKey: string
): ExplicitExclusionRecord | null {
  const row = getDb().prepare<[string, string, string], ExplicitExclusionRow>(
    `SELECT * FROM explicit_exclusions
     WHERE user_id = ? AND entity_type = ? AND entity_key = ? AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(userId, entityType, normalizeExclusionKey(entityKey));
  return row ? mapExplicitExclusionRow(row) : null;
}

export function listActiveExplicitExclusions(
  userId: string,
  limit = 500
): ExplicitExclusionRecord[] {
  return getDb().prepare<[string, number], ExplicitExclusionRow>(
    `SELECT * FROM explicit_exclusions
     WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(userId, Math.max(1, Math.min(limit, 500))).map(mapExplicitExclusionRow);
}

export function buildTrackExclusionKey(input: {
  provider?: string | null;
  providerId?: string | null;
  title: string;
  primaryArtist: string;
}): string {
  if (input.provider?.trim() && input.providerId?.trim()) {
    return `${normalizeExclusionKey(input.provider)}:${normalizeExclusionKey(input.providerId)}`;
  }
  return canonicalTrackKey(input.title, input.primaryArtist);
}

export function buildTrackExclusionAliases(input: {
  provider?: string | null;
  providerId?: string | null;
  title: string;
  primaryArtist: string;
}): string[] {
  return [...new Set([
    buildTrackExclusionKey(input),
    canonicalTrackKey(input.title, input.primaryArtist),
    legacyTrackKey(input.title, input.primaryArtist)
  ].filter(Boolean))];
}

/** Candidate-scoped authoritative lookup used by hard gates; it is not projection-limited. */
export function findMatchingExplicitExclusion(
  userId: string,
  track: ExplicitExclusionTrackIdentity
): ExplicitExclusionRecord | null {
  const primaryArtist = track.artists[0] ?? '';
  const trackKeys = buildTrackExclusionAliases({
    provider: 'ncm',
    providerId: track.id,
    title: track.name,
    primaryArtist
  });
  const artistKeys = [...new Set(track.artists.map(normalizeExclusionKey).filter(Boolean))];
  const trackPlaceholders = trackKeys.map(() => '?').join(', ');
  const artistClause = artistKeys.length > 0
    ? `OR (entity_type = 'artist' AND entity_key IN (${artistKeys.map(() => '?').join(', ')}))`
    : '';
  const row = getDb().prepare(`
    SELECT * FROM explicit_exclusions
    WHERE user_id = ?
      AND revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM explicit_exclusion_resolution_jobs AS resolution
        WHERE resolution.exclusion_id = explicit_exclusions.id
          AND resolution.status <> 'succeeded'
      )
      AND (
        (entity_type = 'track' AND (
          (provider = 'ncm' AND provider_id = ?)
          OR entity_key IN (${trackPlaceholders})
        ))
        ${artistClause}
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(userId, track.id, ...trackKeys, ...artistKeys) as ExplicitExclusionRow | undefined;
  return row ? mapExplicitExclusionRow(row) : null;
}

export function revokeExplicitExclusionsByIdentity(input: {
  userId: string;
  entityType: 'track' | 'artist';
  exactKeyGroups: string[][];
  fallbackAliasKeys?: string[];
  compatiblePendingTrack?: { title: string; artist?: string | null };
  sourceRef: ExclusionSourceRef;
  revokedAt?: string;
}): ExplicitExclusionRecord[] {
  const sourceRef = exclusionSourceRefSchema.parse(input.sourceRef);
  const revokedAt = input.revokedAt ?? new Date().toISOString();
  const db = getDb();
  const ids = db.transaction(() => {
    let exactRows: ExplicitExclusionRow[] = [];
    for (const group of input.exactKeyGroups) {
      exactRows = findActiveExclusionsByKeys(input.userId, input.entityType, group);
      if (exactRows.length > 0) break;
    }

    const fallbackRows = exactRows.length > 0
      ? []
      : findActiveExclusionsByKeys(
          input.userId,
          input.entityType,
          input.fallbackAliasKeys ?? []
        );
    const selectedRows = exactRows.length > 0
      ? exactRows
      : fallbackRows.length === 1
        ? fallbackRows
        : [];
    const pendingRows = input.entityType === 'track' && input.compatiblePendingTrack
      ? findCompatiblePendingTrackExclusions(input.userId, input.compatiblePendingTrack)
      : [];
    const rows = [...new Map(
      [...selectedRows, ...pendingRows].map((row) => [row.id, row])
    ).values()];
    if (rows.length === 0) return [];
    return revokeExplicitExclusionRows(rows, input.userId, sourceRef, revokedAt);
  })();
  return ids.flatMap((id) => {
    const record = getExplicitExclusionById(input.userId, id);
    return record ? [record] : [];
  });
}

function findActiveExclusionsByKeys(
  userId: string,
  entityType: 'track' | 'artist',
  keys: string[]
): ExplicitExclusionRow[] {
  const entityKeys = [...new Set(keys.map(normalizeExclusionKey).filter(Boolean))];
  if (entityKeys.length === 0) return [];
  const placeholders = entityKeys.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT * FROM explicit_exclusions
    WHERE user_id = ? AND entity_type = ? AND revoked_at IS NULL
      AND (
        entity_key IN (${placeholders})
        OR EXISTS (
          SELECT 1 FROM json_each(explicit_exclusions.aliases_json)
          WHERE json_each.value IN (${placeholders})
        )
      )
    ORDER BY created_at DESC, id DESC
  `).all(
    userId, entityType, ...entityKeys, ...entityKeys
  ) as ExplicitExclusionRow[];
}

function findCompatiblePendingTrackExclusions(
  userId: string,
  identity: { title: string; artist?: string | null }
): ExplicitExclusionRow[] {
  const targetTitle = normalizeTrackToken(identity.title);
  const targetArtist = normalizeTrackToken(identity.artist ?? '');
  if (!targetTitle) return [];
  const rows = getDb().prepare(`
    SELECT exclusion.*, job.query_title AS resolution_query_title,
           job.query_artist AS resolution_query_artist
    FROM explicit_exclusions AS exclusion
    INNER JOIN explicit_exclusion_resolution_jobs AS job
      ON job.exclusion_id = exclusion.id AND job.user_id = exclusion.user_id
    WHERE exclusion.user_id = ?
      AND exclusion.entity_type = 'track'
      AND exclusion.revoked_at IS NULL
      AND exclusion.provider IS NULL
      AND exclusion.provider_id IS NULL
      AND job.status IN ('pending', 'retryable', 'processing')
  `).all(userId) as Array<ExplicitExclusionRow & {
    resolution_query_title: string;
    resolution_query_artist: string | null;
  }>;
  return rows.filter((row) => {
    if (normalizeTrackToken(row.resolution_query_title) !== targetTitle) return false;
    const pendingArtist = normalizeTrackToken(row.resolution_query_artist ?? '');
    return targetArtist
      ? !pendingArtist || pendingArtist === targetArtist
      : !pendingArtist;
  });
}

function revokeExplicitExclusionRows(
  rows: ExplicitExclusionRow[],
  userId: string,
  sourceRef: ExclusionSourceRef,
  revokedAt: string
): string[] {
  const ids = rows.map((row) => row.id);
  const updateExclusion = getDb().prepare(`
    UPDATE explicit_exclusions
    SET revoked_at = ?, revocation_source_ref_json = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `);
  const cancelResolution = getDb().prepare(`
    UPDATE explicit_exclusion_resolution_jobs
    SET status = 'dead', last_error_code = 'exclusion_revoked',
        lease_token = NULL, lease_until = NULL, updated_at = ?, completed_at = ?
    WHERE exclusion_id = ? AND user_id = ?
      AND status IN ('pending', 'retryable', 'processing')
  `);
  for (const id of ids) {
    updateExclusion.run(revokedAt, JSON.stringify(sourceRef), id, userId);
    cancelResolution.run(revokedAt, revokedAt, id, userId);
  }
  return ids;
}

export function revokeExplicitExclusion(
  input: z.input<typeof revokeExplicitExclusionSchema>
): ExplicitExclusionRecord | null {
  const parsed = revokeExplicitExclusionSchema.parse(input);
  const current = getActiveExplicitExclusion(
    parsed.userId,
    parsed.entityType,
    parsed.entityKey
  );
  if (!current) return null;

  const revokedAt = parsed.revokedAt ?? new Date().toISOString();
  return getDb().transaction(() => {
    const result = getDb().prepare(
      `UPDATE explicit_exclusions
       SET revoked_at = ?, revocation_source_ref_json = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    ).run(
      revokedAt,
      JSON.stringify(parsed.sourceRef),
      current.id,
      parsed.userId
    );
    if (result.changes === 0) return null;
    getDb().prepare(`
      UPDATE explicit_exclusion_resolution_jobs
      SET status = 'dead', last_error_code = 'exclusion_revoked',
          lease_token = NULL, lease_until = NULL, updated_at = ?, completed_at = ?
      WHERE exclusion_id = ? AND user_id = ?
        AND status IN ('pending', 'retryable', 'processing')
    `).run(revokedAt, revokedAt, current.id, parsed.userId);
    return getExplicitExclusionById(parsed.userId, current.id);
  })();
}

export function getExplicitExclusionById(
  userId: string,
  id: string
): ExplicitExclusionRecord | null {
  const row = getDb().prepare<[string, string], ExplicitExclusionRow>(
    `SELECT * FROM explicit_exclusions WHERE user_id = ? AND id = ?`
  ).get(userId, id);
  return row ? mapExplicitExclusionRow(row) : null;
}

export function normalizeExclusionKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function canonicalTrackKey(title: string, artist: string): string {
  const normalizedTitle = normalizeTrackToken(
    title.replace(/（[^）]*）|\([^)]*\)|\[[^\]]*]|\{[^}]*}/g, ' ')
  );
  if (!normalizedTitle) return '';
  return `${normalizedTitle}::${normalizeTrackToken(artist)}`;
}

function legacyTrackKey(title: string, artist: string): string {
  const normalizedTitle = normalizeTrackToken(title);
  if (!normalizedTitle) return '';
  return `${normalizedTitle}___${normalizeTrackToken(artist)}`;
}

function normalizeTrackToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

type ExplicitExclusionRow = {
  id: string;
  user_id: string;
  entity_type: 'track' | 'artist';
  entity_key: string;
  provider: string | null;
  provider_id: string | null;
  display_name: string | null;
  aliases_json: string;
  source_kind: string;
  source_ref_json: string;
  created_at: string;
  revoked_at: string | null;
  revocation_source_ref_json: string | null;
};

function mapExplicitExclusionRow(row: ExplicitExclusionRow): ExplicitExclusionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    provider: row.provider,
    providerId: row.provider_id,
    displayName: row.display_name,
    aliases: parseAliases(row.aliases_json),
    sourceKind: row.source_kind,
    sourceRef: parseSourceRef(row.source_ref_json),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revocationSourceRef: parseSourceRef(row.revocation_source_ref_json)
  };
}

function parseAliases(value: string): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value) as unknown);
    return parsed.success
      ? [...new Set(parsed.data.map(normalizeExclusionKey).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function parseSourceRef(value: string | null): ExclusionSourceRef | null {
  if (!value) return null;
  try {
    const parsed = exclusionSourceRefSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
