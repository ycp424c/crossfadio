import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

export const tasteProfilePayloadSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  likedCount: z.number().int().nonnegative(),
  analyzedCount: z.number().int().nonnegative()
}).strict().refine(
  (profile) => profile.analyzedCount <= profile.likedCount,
  { message: 'analyzedCount cannot exceed likedCount' }
);

export type TasteProfilePayload = z.infer<typeof tasteProfilePayloadSchema>;
export type TasteProfileSourceKind = 'liked_library' | 'legacy_taste_md';

export type TasteProfileRecord = {
  id: string;
  userId: string;
  version: number;
  profile: TasteProfilePayload;
  sourceKind: TasteProfileSourceKind;
  sourceLibraryHash: string | null;
  generatedAt: string;
  createdAt: string;
};

export function saveTasteProfile(input: {
  userId: string;
  profile: TasteProfilePayload;
  sourceKind: TasteProfileSourceKind;
  sourceLibraryHash?: string | null;
  generatedAt?: string;
}): TasteProfileRecord {
  const profile = tasteProfilePayloadSchema.parse(input.profile);
  const generatedAt = new Date(input.generatedAt ?? Date.now()).toISOString();
  const db = getDb();
  const id = randomUUID();

  const version = db.transaction(() => {
    const row = db.prepare(
      `SELECT COALESCE(MAX(version), 0) AS version
       FROM taste_profiles
       WHERE user_id = ?`
    ).get(input.userId) as { version: number };
    const nextVersion = row.version + 1;
    db.prepare(`
      INSERT INTO taste_profiles (
        id, user_id, version, profile_json, source_kind, source_library_hash, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      nextVersion,
      JSON.stringify(profile),
      input.sourceKind,
      input.sourceLibraryHash ?? null,
      generatedAt
    );
    return nextVersion;
  })();

  const record = getTasteProfileByVersion(input.userId, version);
  if (!record) throw new Error('Taste Profile was not persisted');
  return record;
}

export function getCurrentTasteProfile(userId: string): TasteProfileRecord | null {
  const row = getDb().prepare(`
    SELECT *
    FROM taste_profiles
    WHERE user_id = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(userId) as TasteProfileRow | undefined;
  return row ? mapTasteProfile(row) : null;
}

function getTasteProfileByVersion(userId: string, version: number): TasteProfileRecord | null {
  const row = getDb().prepare(`
    SELECT *
    FROM taste_profiles
    WHERE user_id = ? AND version = ?
  `).get(userId, version) as TasteProfileRow | undefined;
  return row ? mapTasteProfile(row) : null;
}

type TasteProfileRow = {
  id: string;
  user_id: string;
  version: number;
  profile_json: string;
  source_kind: TasteProfileSourceKind;
  source_library_hash: string | null;
  generated_at: string;
  created_at: string;
};

function mapTasteProfile(row: TasteProfileRow): TasteProfileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    version: row.version,
    profile: tasteProfilePayloadSchema.parse(JSON.parse(row.profile_json)),
    sourceKind: row.source_kind,
    sourceLibraryHash: row.source_library_hash,
    generatedAt: row.generated_at,
    createdAt: row.created_at
  };
}
