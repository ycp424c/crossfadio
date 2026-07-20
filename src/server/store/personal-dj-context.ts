import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

const shortString = (max: number) => z.string().trim().min(1).max(max);
const optionalShortString = (max: number) => z.string().trim().max(max).optional();

const sourceSliceRefSchema = z.object({
  sliceId: shortString(160),
  evidenceRole: z.enum(['fact', 'raw', 'context', 'lead']),
  citationLabel: optionalShortString(240)
}).strict();

export const personalDjContextPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).optional(),
  summary: shortString(1200),
  currentState: z.object({
    activity: optionalShortString(120),
    energy: z.enum(['low', 'medium', 'high']).optional(),
    attention: z.enum(['low_distraction', 'normal', 'high_stimulation']).optional(),
    mood: optionalShortString(160)
  }).strict().default({}),
  musicGuidance: z.object({
    energyCurve: z.enum(['downshift', 'steady', 'uplift', 'mixed']).optional(),
    preferredTextures: z.array(shortString(80)).max(12).default([]),
    avoidTextures: z.array(shortString(80)).max(12).default([]),
    vocalPreference: z.enum(['vocal', 'instrumental', 'mixed', 'unknown']).optional(),
    novelty: z.enum(['comfort', 'balanced', 'explore']).optional()
  }).strict().default({ preferredTextures: [], avoidTextures: [] }),
  musicHints: z.array(z.object({
    kind: z.enum(['artist', 'track', 'style', 'scene']),
    label: shortString(160),
    strength: z.enum(['weak', 'medium', 'strong']),
    reason: shortString(300)
  }).strict()).max(12).default([]),
  segueGuidance: z.object({
    tone: optionalShortString(240),
    privacyRule: shortString(500)
  }).strict(),
  source: z.object({
    kind: z.literal('lifemesh_bundle'),
    bundleId: shortString(200),
    sliceRefs: z.array(sourceSliceRefSchema).max(20).default([])
  }).strict()
}).strict();

export type PersonalDjContextPayload = z.infer<typeof personalDjContextPayloadSchema>;

export type PersonalDjContextRow = {
  id: string;
  user_id: string;
  payload_json: string;
  payload_hash: string;
  source_kind: string;
  source_bundle_id: string | null;
  slice_count: number;
  uploaded_at: string;
  generated_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export type PersonalDjContextRecord = {
  id: string;
  userId: string;
  payload: PersonalDjContextPayload;
  payloadHash: string;
  sourceKind: string;
  sourceBundleId: string | null;
  sliceCount: number;
  uploadedAt: string;
  generatedAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type PersonalDjContextSnapshot = {
  current: PersonalDjContextRecord | null;
  trend: PersonalDjContextRecord[];
};

export function savePersonalDjContext(input: {
  userId: string;
  payload: unknown;
  uploadedAt?: string;
  now?: Date;
}): PersonalDjContextRecord {
  const payload = personalDjContextPayloadSchema.parse(input.payload);
  const id = randomUUID();
  const now = input.now ?? new Date();
  const uploadedAt = input.uploadedAt ?? now.toISOString();
  const generatedAtMs = Date.parse(payload.generatedAt);
  if (generatedAtMs > now.getTime() + 5 * 60 * 1000) {
    throw new Error('personal_dj_context_generated_in_future');
  }
  const maximumExpiresAtMs = generatedAtMs + 24 * 60 * 60 * 1000;
  const declaredExpiresAtMs = payload.validUntil
    ? Date.parse(payload.validUntil)
    : Number.POSITIVE_INFINITY;
  const expiresAtMs = Math.min(maximumExpiresAtMs, declaredExpiresAtMs);
  if (expiresAtMs <= now.getTime()) {
    throw new Error('personal_dj_context_expired');
  }
  const generatedAt = new Date(generatedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const payloadJson = JSON.stringify(payload);
  const payloadHash = createHash('sha256').update(payloadJson).digest('hex');

  getDb().prepare(
    `UPDATE personal_dj_contexts
     SET revoked_at = ?
     WHERE user_id = ? AND revoked_at IS NULL`
  ).run(uploadedAt, input.userId);

  getDb()
    .prepare(
      `INSERT INTO personal_dj_contexts (
        id, user_id, payload_json, payload_hash, source_kind, source_bundle_id,
        slice_count, uploaded_at, generated_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      id,
      input.userId,
      payloadJson,
      payloadHash,
      payload.source.kind,
      payload.source.bundleId,
      payload.source.sliceRefs.length,
      uploadedAt,
      generatedAt,
      expiresAt
    );

  cleanupExpiredPersonalDjContexts(input.userId, now);
  return getPersonalDjContextById(input.userId, id)!;
}

export function getPersonalDjContextSnapshot(
  userId: string,
  now: Date = new Date()
): PersonalDjContextSnapshot {
  cleanupExpiredPersonalDjContexts(userId, now);
  const current = getCurrentPersonalDjContext(userId, now);
  if (!current) return { current: null, trend: [] };
  return { current, trend: [] };
}

export function getCurrentPersonalDjContext(
  userId: string,
  now: Date = new Date()
): PersonalDjContextRecord | null {
  const row = getDb()
    .prepare<[string, string], PersonalDjContextRow>(
      `SELECT * FROM personal_dj_contexts
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY uploaded_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(userId, now.toISOString());
  return row ? mapPersonalDjContextRow(row) : null;
}

export function listPersonalDjContexts(userId: string, limit = 20): PersonalDjContextRecord[] {
  return getDb()
    .prepare<[string, number], PersonalDjContextRow>(
      `SELECT * FROM personal_dj_contexts
       WHERE user_id = ?
       ORDER BY uploaded_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(userId, limit)
    .map(mapPersonalDjContextRow);
}

export function revokeCurrentPersonalDjContext(userId: string, revokedAt = new Date().toISOString()): boolean {
  const current = getCurrentPersonalDjContext(userId);
  if (!current) return false;
  const result = getDb()
    .prepare<[string, string]>(
      `UPDATE personal_dj_contexts SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`
    )
    .run(revokedAt, userId);
  return result.changes > 0;
}

export function cleanupExpiredPersonalDjContexts(userId: string, now: Date = new Date()): number {
  const result = getDb()
    .prepare<[string, string]>(
      `DELETE FROM personal_dj_contexts
       WHERE user_id = ? AND expires_at <= ?`
    )
    .run(userId, now.toISOString());
  return result.changes;
}

export function cleanupAllExpiredPersonalDjContexts(now: Date = new Date()): number {
  return getDb()
    .prepare<[string]>(
      `DELETE FROM personal_dj_contexts
       WHERE expires_at IS NOT NULL AND expires_at <= ?`
    )
    .run(now.toISOString()).changes;
}

function getPersonalDjContextById(userId: string, id: string): PersonalDjContextRecord | null {
  const row = getDb()
    .prepare<[string, string], PersonalDjContextRow>(
      `SELECT * FROM personal_dj_contexts WHERE user_id = ? AND id = ?`
    )
    .get(userId, id);
  return row ? mapPersonalDjContextRow(row) : null;
}

function mapPersonalDjContextRow(row: PersonalDjContextRow): PersonalDjContextRecord {
  return {
    id: row.id,
    userId: row.user_id,
    payload: personalDjContextPayloadSchema.parse(JSON.parse(row.payload_json)),
    payloadHash: row.payload_hash,
    sourceKind: row.source_kind,
    sourceBundleId: row.source_bundle_id,
    sliceCount: row.slice_count,
    uploadedAt: row.uploaded_at,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}
