import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export const PERSONAL_DJ_CONTEXT_TOKEN_PREFIX = 'cfdj_ctx_';
export const PERSONAL_DJ_CONTEXT_TOKEN_SCOPE = 'personal-dj-context:write';
export const PERSONAL_DJ_CONTEXT_ACTIVE_TOKEN_LIMIT = 10;

export type PersonalDjContextTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type PersonalDjContextTokenRecord = {
  id: string;
  userId: string;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreatedPersonalDjContextToken = PersonalDjContextTokenRecord & {
  token: string;
};

export function createPersonalDjContextToken(
  userId: string,
  name = 'LifeMesh Bridge'
): CreatedPersonalDjContextToken {
  const trimmedName = normalizeTokenName(name);
  const activeCount = countActivePersonalDjContextTokens(userId);
  if (activeCount >= PERSONAL_DJ_CONTEXT_ACTIVE_TOKEN_LIMIT) {
    throw new Error('personal_dj_context_token_limit_reached');
  }

  const id = randomUUID();
  const token = `${PERSONAL_DJ_CONTEXT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO personal_dj_context_tokens (
        id, user_id, name, token_hash, scope, created_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(
      id,
      userId,
      trimmedName,
      hashPersonalDjContextToken(token),
      PERSONAL_DJ_CONTEXT_TOKEN_SCOPE,
      createdAt
    );

  return {
    id,
    userId,
    name: trimmedName,
    scope: PERSONAL_DJ_CONTEXT_TOKEN_SCOPE,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
    token
  };
}

export function listPersonalDjContextTokens(userId: string): PersonalDjContextTokenRecord[] {
  return getDb()
    .prepare<[string], PersonalDjContextTokenRow>(
      `SELECT * FROM personal_dj_context_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(userId)
    .map(mapTokenRow);
}

export function revokePersonalDjContextToken(
  userId: string,
  tokenId: string,
  revokedAt = new Date().toISOString()
): boolean {
  const result = getDb()
    .prepare<[string, string, string]>(
      `UPDATE personal_dj_context_tokens
       SET revoked_at = ?
       WHERE user_id = ? AND id = ? AND revoked_at IS NULL`
    )
    .run(revokedAt, userId, tokenId);
  return result.changes > 0;
}

export function resolvePersonalDjContextToken(token: string): PersonalDjContextTokenRecord | null {
  if (!token.startsWith(PERSONAL_DJ_CONTEXT_TOKEN_PREFIX)) return null;
  const row = getDb()
    .prepare<[string, string], PersonalDjContextTokenRow>(
      `SELECT * FROM personal_dj_context_tokens
       WHERE token_hash = ? AND scope = ? AND revoked_at IS NULL
       LIMIT 1`
    )
    .get(hashPersonalDjContextToken(token), PERSONAL_DJ_CONTEXT_TOKEN_SCOPE);
  return row ? mapTokenRow(row) : null;
}

export function markPersonalDjContextTokenUsed(
  tokenId: string,
  usedAt = new Date().toISOString()
): void {
  getDb()
    .prepare<[string, string]>(
      `UPDATE personal_dj_context_tokens
       SET last_used_at = ?
       WHERE id = ? AND revoked_at IS NULL`
    )
    .run(usedAt, tokenId);
}

export function countActivePersonalDjContextTokens(userId: string): number {
  const row = getDb()
    .prepare<[string], { count: number }>(
      `SELECT COUNT(*) as count FROM personal_dj_context_tokens
       WHERE user_id = ? AND revoked_at IS NULL`
    )
    .get(userId);
  return row?.count ?? 0;
}

export function hashPersonalDjContextToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeTokenName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 80) : 'LifeMesh Bridge';
}

function mapTokenRow(row: PersonalDjContextTokenRow): PersonalDjContextTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scope: row.scope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}
