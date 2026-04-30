# Multi-User Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Crossfadio from a single-user local app to a multi-user online service: NCM QR login → JWT session → per-user SQLite data, with LLM/TTS config moved to environment variables.

**Architecture:** JWT middleware (HS256 via `jose`) authenticates protected routes. A single SQLite DB holds all user data isolated by `user_id` columns. NCM cookie stored encrypted in `users` table. LLM/TTS keys come from env vars; TTS voice is per-user pref.

**Tech Stack:** `jose` (JWT HS256), AES-256-GCM (cookie encryption in `crypto.ts`), better-sqlite3 (migrations), Express middleware, React + localStorage (frontend JWT storage)

---

## File Map

| File | Action |
|---|---|
| `src/server/crypto.ts` | Create — AES-256-GCM encrypt/decrypt utils |
| `src/server/config.ts` | Create — env var loader + startup validator |
| `src/server/allowlist.ts` | Create — NCM ID allowlist loader/checker |
| `src/server/store/users.ts` | Create — users table + blocked_login_attempts CRUD |
| `src/server/http/middleware/auth.ts` | Create — JWT verification middleware |
| `src/server/http/middleware/userScope.ts` | Create — per-request NcmClient builder |
| `src/server/store/migrations.ts` | Modify — add 3 new migrations |
| `src/server/store/messages.ts` | Modify — add userId param to all functions |
| `src/server/store/plays.ts` | Modify — add userId param to all functions |
| `src/server/store/plan.ts` | Modify — add userId param to all functions |
| `src/server/store/prefs.ts` | Modify — add userId param to all functions |
| `src/server/store/segues.ts` | Modify — add userId param to all functions |
| `src/server/store/chat-preferences.ts` | Modify — add userId param to all functions |
| `src/server/store/queue.ts` | Modify — per-user Map instead of module globals |
| `src/server/store/location.ts` | Modify — per-user Map instead of module global |
| `src/server/ncm/auth.ts` | Modify — stateless, write users table, sign JWT |
| `src/server/http/routes/ncm-login.ts` | Modify — wire whitelist + JWT in QR status handler |
| `src/server/http/routes/plays.ts` | Modify — pass userId from req |
| `src/server/http/routes/plan.ts` | Modify — pass userId, use getConfig() |
| `src/server/http/routes/chat.ts` | Modify — pass userId, use getConfig() |
| `src/server/http/routes/djNext.ts` | Modify — pass userId, use getConfig() |
| `src/server/http/routes/segue.ts` | Modify — pass userId, use getConfig() |
| `src/server/http/routes/messages.ts` | Modify — pass userId |
| `src/server/http/routes/location.ts` | Modify — pass userId |
| `src/server/http/routes/queue.ts` | Modify — pass userId |
| `src/server/http/routes/settings.ts` | Rewrite — env vars + tts.voice pref only |
| `src/server/http/routes/runtime.ts` | Modify — remove sessionToken from response |
| `src/server/http/index.ts` | Modify — middleware wiring, CORS config, remove secrets |
| `src/server/http/ws.ts` | Modify — JWT auth instead of sessionToken |
| `src/server/llm/config.ts` | Modify — read from getConfig() |
| `src/server/tts/config.ts` | Modify — read from getConfig() + user pref for voice |
| `src/server/app-paths.ts` | Modify — add resolveUserDir(ncmId) |
| `src/server/user-corpus/bootstrap.ts` | Modify — accept userId |
| `src/server/user-corpus/loader.ts` | Modify — accept userId |
| `src/server/index.ts` | Modify — loadConfig() at startup, remove SecretStore + scheduler |
| `src/server/security.ts` | Delete |
| `src/server/scheduler.ts` | Delete |
| `src/shared/schema.ts` | Modify — add 'forbidden' to NcmQrHint + token to QR status response |
| `src/renderer/api.ts` | Modify — JWT storage, auth header, update types |
| `src/renderer/ws/client.ts` | No change needed (already parameterized) |
| `src/renderer/App.tsx` | Modify — read JWT from localStorage instead of sessionToken |
| `tests/unit/security.spec.ts` | Delete (SecretStore gone) |
| `tests/unit/plays.spec.ts` | Modify — add userId param |
| `tests/unit/crypto.spec.ts` | Create |
| `tests/unit/users-store.spec.ts` | Create |

---

## Task 1: Foundation — `jose`, `crypto.ts`, `config.ts`

**Files:**
- Create: `src/server/crypto.ts`
- Create: `src/server/config.ts`
- Create: `tests/unit/crypto.spec.ts`

- [ ] **Step 1.1: Install `jose`**

```bash
pnpm add jose
pnpm check
```

Expected: no type errors.

- [ ] **Step 1.2: Write failing test for crypto**

Create `tests/unit/crypto.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../../src/server/crypto';

describe('crypto', () => {
  const key = deriveKey('test-secret-key-for-unit-tests');

  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = 'MUSIC_U=test_cookie_value_12345;';
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('encrypt produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input';
    expect(encrypt(plaintext, key)).not.toBe(encrypt(plaintext, key));
  });

  it('decrypt throws on tampered ciphertext', () => {
    const ciphertext = encrypt('hello', key);
    const tampered = ciphertext.slice(0, -4) + 'XXXX';
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('decrypt throws on wrong key', () => {
    const ciphertext = encrypt('hello', key);
    const wrongKey = deriveKey('different-secret');
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });
});
```

- [ ] **Step 1.3: Run test — verify FAIL**

```bash
pnpm test -- --reporter=verbose tests/unit/crypto.spec.ts
```

Expected: FAIL with "Cannot find module '../../src/server/crypto'"

- [ ] **Step 1.4: Create `src/server/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decrypt(encoded: string, key: Buffer): string {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const [ivB64, tagB64, cipherB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64!, 'base64')),
    decipher.final()
  ]).toString('utf-8');
}
```

- [ ] **Step 1.5: Run test — verify PASS**

```bash
pnpm test -- --reporter=verbose tests/unit/crypto.spec.ts
```

Expected: 4 tests PASS.

- [ ] **Step 1.6: Create `src/server/config.ts`**

```ts
export type ServerConfig = {
  jwtSecret: string;
  jwtTtlDays: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  tts: { baseUrl: string; apiKey: string; voiceDefault: string | null };
  host: string;
  allowedOrigins: string[];
};

let _config: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  const required = (name: string): string => {
    const val = process.env[name]?.trim();
    if (!val) throw new Error(`Missing required environment variable: ${name}`);
    return val;
  };

  _config = {
    jwtSecret: required('CROSSFADIO_JWT_SECRET'),
    jwtTtlDays: Math.max(1, Number(process.env.CROSSFADIO_JWT_TTL_DAYS ?? '7') || 7),
    llm: {
      baseUrl: required('CROSSFADIO_LLM_BASE_URL'),
      apiKey: required('CROSSFADIO_LLM_API_KEY'),
      model: required('CROSSFADIO_LLM_MODEL')
    },
    tts: {
      baseUrl: required('CROSSFADIO_TTS_BASE_URL'),
      apiKey: required('CROSSFADIO_TTS_API_KEY'),
      voiceDefault: process.env.CROSSFADIO_TTS_VOICE_DEFAULT?.trim() || null
    },
    host: process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1',
    allowedOrigins: (process.env.CROSSFADIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  };

  return _config;
}

export function getConfig(): ServerConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfigForTest(): void {
  _config = null;
}
```

- [ ] **Step 1.7: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 1.8: Commit**

```bash
git add src/server/crypto.ts src/server/config.ts tests/unit/crypto.spec.ts
git commit -m "feat(auth): 添加 AES-256-GCM 加解密工具和服务端配置加载器"
```

---

## Task 2: Allowlist + DB Migrations + Users Store

**Files:**
- Create: `src/server/allowlist.ts`
- Modify: `src/server/store/migrations.ts`
- Create: `src/server/store/users.ts`
- Create: `tests/unit/users-store.spec.ts`

- [ ] **Step 2.1: Write failing tests**

Create `tests/unit/users-store.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-users-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-16-chars';
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('users store', () => {
  it('upsertUser stores and retrieves a user', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    upsertUser({ ncmId: 'u1', encryptedCookie: 'enc_cookie', profileJson: '{"name":"test"}' });
    const user = getUserById('u1');
    expect(user).not.toBeNull();
    expect(user!.ncm_id).toBe('u1');
    expect(user!.ncm_cookie).toBe('enc_cookie');
  });

  it('upsertUser updates cookie and last_seen_at on second call', async () => {
    const { upsertUser, getUserById } = await import('../../src/server/store/users');
    upsertUser({ ncmId: 'u2', encryptedCookie: 'old_cookie', profileJson: null });
    upsertUser({ ncmId: 'u2', encryptedCookie: 'new_cookie', profileJson: null });
    const user = getUserById('u2');
    expect(user!.ncm_cookie).toBe('new_cookie');
  });

  it('recordBlockedAttempt saves ncm_id and profile', async () => {
    const { recordBlockedAttempt } = await import('../../src/server/store/users');
    const Database = (await import('better-sqlite3')).default;
    recordBlockedAttempt({ ncmId: 'blocked1', profileJson: '{"name":"stranger"}' });
    const db = new Database(path.join(dataDir, 'state.db'));
    const row = db.prepare('SELECT * FROM blocked_login_attempts WHERE ncm_id = ?').get('blocked1') as { ncm_id: string };
    expect(row.ncm_id).toBe('blocked1');
    db.close();
  });

  it('getUserById returns null for unknown id', async () => {
    const { getUserById } = await import('../../src/server/store/users');
    expect(getUserById('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run tests — verify FAIL**

```bash
pnpm test -- --reporter=verbose tests/unit/users-store.spec.ts
```

Expected: FAIL with module not found errors.

- [ ] **Step 2.3: Update `src/server/store/migrations.ts`**

Add 3 migrations at the end of `migrationSqlList` (current length is 8, new indices 8, 9, 10):

```ts
// After the existing 8 entries in migrationSqlList, append:
  `
CREATE TABLE IF NOT EXISTS users (
  ncm_id       TEXT PRIMARY KEY,
  ncm_cookie   TEXT NOT NULL,
  profile_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS blocked_login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ncm_id       TEXT NOT NULL,
  profile_json TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
ALTER TABLE messages ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE messages SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE plays ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE plays SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE segues ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE segues SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE chat_preferences ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE chat_preferences SET user_id = '__legacy__' WHERE user_id = '';

CREATE TABLE prefs_new (
  user_id    TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
INSERT INTO prefs_new (user_id, key, value_json, updated_at)
  SELECT '__legacy__', key, value_json, updated_at FROM prefs;
DROP TABLE prefs;
ALTER TABLE prefs_new RENAME TO prefs;

CREATE TABLE plan_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL DEFAULT '',
  plan_date    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, plan_date, version)
);
INSERT INTO plan_new (id, user_id, plan_date, version, payload_json, created_at)
  SELECT id, '__legacy__', plan_date, version, payload_json, created_at FROM plan;
DROP TABLE plan;
ALTER TABLE plan_new RENAME TO plan;
`
```

- [ ] **Step 2.4: Create `src/server/store/users.ts`**

```ts
import { getDb } from './db.js';

export type UserRow = {
  ncm_id: string;
  ncm_cookie: string;
  profile_json: string | null;
  created_at: string;
  last_seen_at: string;
};

export function upsertUser(params: {
  ncmId: string;
  encryptedCookie: string;
  profileJson: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (ncm_id, ncm_cookie, profile_json, created_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(ncm_id) DO UPDATE SET
       ncm_cookie   = excluded.ncm_cookie,
       profile_json = excluded.profile_json,
       last_seen_at = datetime('now')`
  ).run(params.ncmId, params.encryptedCookie, params.profileJson);
}

export function getUserById(ncmId: string): UserRow | null {
  const db = getDb();
  return (
    db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE ncm_id = ?')
      .get(ncmId) ?? null
  );
}

export function deleteUser(ncmId: string): void {
  getDb().prepare('DELETE FROM users WHERE ncm_id = ?').run(ncmId);
}

export function getAllUsers(): UserRow[] {
  return getDb().prepare<[], UserRow>('SELECT * FROM users').all();
}

export function recordBlockedAttempt(params: {
  ncmId: string;
  profileJson: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO blocked_login_attempts (ncm_id, profile_json) VALUES (?, ?)`
    )
    .run(params.ncmId, params.profileJson);
}
```

- [ ] **Step 2.5: Create `src/server/allowlist.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { resolveAppDataDir } from './app-paths.js';
import { getLogger } from './logger.js';

let allowlist: Set<string> | null = null;

export function loadAllowlist(): Set<string> {
  const filePath = path.join(resolveAppDataDir(), 'allowlist.json');

  if (!fs.existsSync(filePath)) {
    getLogger().warn({ filePath }, 'allowlist.json not found — no users will be permitted');
    allowlist = new Set();
    return allowlist;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error('allowlist.json must be a JSON array of strings');
    }
    allowlist = new Set(parsed as string[]);
    getLogger().info({ count: allowlist.size }, 'Allowlist loaded');
    return allowlist;
  } catch (err) {
    getLogger().error({ err }, 'Failed to load allowlist.json');
    allowlist = new Set();
    return allowlist;
  }
}

export function isAllowed(ncmId: string): boolean {
  if (!allowlist) loadAllowlist();
  return allowlist!.has(ncmId);
}
```

- [ ] **Step 2.6: Run tests — verify PASS**

```bash
pnpm test -- --reporter=verbose tests/unit/users-store.spec.ts
```

Expected: 4 tests PASS.

- [ ] **Step 2.7: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 2.8: Commit**

```bash
git add src/server/allowlist.ts src/server/store/migrations.ts src/server/store/users.ts tests/unit/users-store.spec.ts
git commit -m "feat(auth): 添加白名单、DB 迁移（users/blocked_login_attempts/user_id 列）和 users store"
```

---

## Task 3: Per-User In-Memory Stores

**Files:**
- Modify: `src/server/store/queue.ts`
- Modify: `src/server/store/location.ts`

- [ ] **Step 3.1: Rewrite `src/server/store/queue.ts`**

Replace entire file with per-user Map:

```ts
export type QueueTrack = {
  ncmId: string;
  query?: string;
  name?: string;
  artists?: string[];
  durationMs?: number;
};

type QueueState = {
  queue: QueueTrack[];
  currentIndex: number;
};

const userQueues = new Map<string, QueueState>();

function getState(userId: string): QueueState {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, { queue: [], currentIndex: 0 });
  }
  return userQueues.get(userId)!;
}

function clampIndex(queue: QueueTrack[], index: number): number {
  if (queue.length === 0) return 0;
  if (!Number.isInteger(index)) return 0;
  return Math.min(Math.max(index, 0), queue.length - 1);
}

export function getQueue(userId: string): QueueTrack[] {
  return [...getState(userId).queue];
}

export function setQueue(userId: string, tracks: QueueTrack[]): void {
  userQueues.set(userId, { queue: [...tracks], currentIndex: 0 });
}

export function setQueueState(userId: string, tracks: QueueTrack[], nextCurrentIndex = 0): void {
  const queue = [...tracks];
  userQueues.set(userId, { queue, currentIndex: clampIndex(queue, nextCurrentIndex) });
}

export function getCurrentIndex(userId: string): number {
  return getState(userId).currentIndex;
}

export function advanceCurrent(userId: string): void {
  const s = getState(userId);
  if (s.currentIndex < s.queue.length - 1) s.currentIndex += 1;
}

export function swapNext(userId: string, track: QueueTrack): void {
  const s = getState(userId);
  if (s.queue.length === 0) { s.queue = [track]; return; }
  const insertAt = Math.min(s.currentIndex + 1, s.queue.length);
  s.queue.splice(insertAt, 0, track);
  const laterIdx = s.queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
  if (laterIdx !== -1) s.queue.splice(laterIdx, 1);
}

export function addToQueue(userId: string, track: QueueTrack, position: 'end' | 'after_current'): void {
  const s = getState(userId);
  if (position === 'end') {
    s.queue = s.queue.filter((t) => t.ncmId !== track.ncmId);
    s.queue.push(track);
  } else {
    const insertAt = Math.min(s.currentIndex + 1, s.queue.length);
    s.queue.splice(insertAt, 0, track);
    const laterIdx = s.queue.findIndex((t, i) => i > insertAt && t.ncmId === track.ncmId);
    if (laterIdx !== -1) s.queue.splice(laterIdx, 1);
  }
}

export function skipCurrent(userId: string): void {
  advanceCurrent(userId);
}

export function banNcmId(userId: string, ncmId: string): void {
  const s = getState(userId);
  s.queue = s.queue.filter((t) => t.ncmId !== ncmId);
  s.currentIndex = clampIndex(s.queue, s.currentIndex);
}
```

- [ ] **Step 3.2: Rewrite `src/server/store/location.ts`**

```ts
type LocationState = { lat: number; lon: number } | null;

const userLocations = new Map<string, LocationState>();

export function setLocation(userId: string, lat: number, lon: number): void {
  userLocations.set(userId, { lat, lon });
}

export function getLocation(userId: string): LocationState {
  return userLocations.get(userId) ?? null;
}
```

- [ ] **Step 3.3: Type check (expect errors — callers not yet updated)**

```bash
pnpm check 2>&1 | grep -c "error TS"
```

Note the count — we'll eliminate all of these in Task 4.

- [ ] **Step 3.4: Commit**

```bash
git add src/server/store/queue.ts src/server/store/location.ts
git commit -m "refactor(store): queue 和 location 改为按 userId 隔离的内存状态"
```

---

## Task 4: DB Store Functions + All Route Callers

This is the largest task — all 6 DB stores get a `userId` param and every route handler that calls them is updated in the same commit to keep the codebase compilable.

**Files:**
- Modify: `src/server/store/messages.ts`
- Modify: `src/server/store/plays.ts`
- Modify: `src/server/store/plan.ts`
- Modify: `src/server/store/prefs.ts`
- Modify: `src/server/store/segues.ts`
- Modify: `src/server/store/chat-preferences.ts`
- Modify: `src/server/http/routes/plays.ts`
- Modify: `src/server/http/routes/plan.ts`
- Modify: `src/server/http/routes/chat.ts`
- Modify: `src/server/http/routes/djNext.ts`
- Modify: `src/server/http/routes/segue.ts`
- Modify: `src/server/http/routes/messages.ts`
- Modify: `src/server/http/routes/location.ts`
- Modify: `src/server/http/routes/queue.ts`
- Modify: `src/server/http/routes/now-next.ts`
- Modify: `tests/unit/plays.spec.ts`
- Modify: `src/server/index.ts` (remove scheduler import)

- [ ] **Step 4.1: Define `AuthedRequest` type inline helper**

At the top of each route handler file being modified, add this import-free helper (copy-paste wherever needed):

```ts
import type { Request } from 'express';
type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };
```

For now, routes will read `userId` from req — the middleware in Task 6 will populate it. Until then, the value will be `undefined` at runtime (but types are correct).

- [ ] **Step 4.2: Rewrite `src/server/store/messages.ts`**

```ts
import { getDb } from './db.js';
import type { AgentMessage } from '../agent/schema.js';

export type StoredMessage = {
  id: number;
  role: string;
  content: string;
  created_at: string;
  extracted_at: string | null;
};

export function saveMessage(userId: string, role: 'user' | 'assistant', content: string): number {
  const db = getDb();
  const result = db
    .prepare<[string, string, string]>(
      `INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, datetime('now'))`
    )
    .run(userId, role, content);
  return Number(result.lastInsertRowid);
}

export function getRecentMessages(userId: string, limit = 20, withinMinutes?: number): AgentMessage[] {
  const db = getDb();
  let rows: StoredMessage[];
  if (withinMinutes !== undefined) {
    rows = db
      .prepare<[number, number, string], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages
         WHERE user_id = ? AND created_at >= datetime('now', ? || ' minutes')
         ORDER BY id DESC LIMIT ?`
      )
      .all(userId, -withinMinutes, limit)
      .reverse();
  } else {
    rows = db
      .prepare<[string, number], StoredMessage>(
        `SELECT id, role, content, created_at, extracted_at FROM messages
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(userId, limit)
      .reverse();
  }
  return rows.map((r) => ({
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content,
    created_at: r.created_at
  }));
}

export function getUnextractedMessages(userId: string): StoredMessage[] {
  const db = getDb();
  return db
    .prepare<[string], StoredMessage>(
      `SELECT id, role, content, created_at, extracted_at FROM messages
       WHERE user_id = ? AND extracted_at IS NULL ORDER BY id ASC`
    )
    .all(userId);
}

export function markMessagesExtracted(userId: string, ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE messages SET extracted_at = datetime('now') WHERE user_id = ? AND id IN (${placeholders})`
  ).run(userId, ...ids);
}
```

- [ ] **Step 4.3: Rewrite `src/server/store/plays.ts`**

```ts
import { getDb } from './db.js';

export type PlayRecord = {
  id: number;
  song_id: string | null;
  song_name: string | null;
  artist_name: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
};

export type StartPlayInput = {
  songId: string;
  songName: string;
  artistName: string;
};

export type EndReason = 'completed' | 'skip' | 'error';

export function startPlay(userId: string, input: StartPlayInput): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(userId, input.songId, input.songName, input.artistName);
  return Number(result.lastInsertRowid);
}

export function endPlay(userId: string, id: number, reason: EndReason): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE plays SET ended_at = datetime('now'), end_reason = ?
       WHERE user_id = ? AND id = ? AND ended_at IS NULL`
    )
    .run(reason, userId, id);
  return result.changes > 0;
}

export function getRecentPlays(userId: string, limit = 50): PlayRecord[] {
  const db = getDb();
  return db
    .prepare<[string, number]>(
      `SELECT * FROM plays WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`
    )
    .all(userId, limit) as PlayRecord[];
}
```

- [ ] **Step 4.4: Rewrite `src/server/store/plan.ts`**

```ts
import { getDb } from './db.js';
import type { PlanOutput } from '../agent/schema.js';

export function savePlan(userId: string, plan: PlanOutput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO plan (user_id, plan_date, version, payload_json, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM plan WHERE user_id = ? AND plan_date = ?), ?, datetime('now'))
     ON CONFLICT(user_id, plan_date, version) DO NOTHING`
  ).run(userId, plan.date, userId, plan.date, JSON.stringify(plan));
}

export function loadLatestPlan(userId: string, date: string): PlanOutput | null {
  const db = getDb();
  const row = db
    .prepare<[string, string], { payload_json: string }>(
      `SELECT payload_json FROM plan WHERE user_id = ? AND plan_date = ? ORDER BY version DESC LIMIT 1`
    )
    .get(userId, date);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as PlanOutput;
  } catch {
    return null;
  }
}

export function todayDateStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
```

- [ ] **Step 4.5: Rewrite `src/server/store/prefs.ts`**

```ts
import { getDb } from './db.js';

export function getPref<T>(userId: string, key: string): T | null {
  const db = getDb();
  const row = db
    .prepare<[string, string], { value_json: string }>(
      'SELECT value_json FROM prefs WHERE user_id = ? AND key = ?'
    )
    .get(userId, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setPref(userId: string, key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO prefs (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(userId, key, JSON.stringify(value));
}

export function deletePref(userId: string, key: string): void {
  getDb().prepare('DELETE FROM prefs WHERE user_id = ? AND key = ?').run(userId, key);
}
```

- [ ] **Step 4.6: Rewrite `src/server/store/segues.ts`**

```ts
import { getDb } from './db.js';

export type StoredSegue = {
  id: number;
  from_id: string | null;
  from_name: string | null;
  to_id: string | null;
  to_name: string | null;
  say: string;
  created_at: string;
};

export type SegueRecord = {
  fromName: string;
  toName: string;
  say: string;
  createdAt: string;
};

export function saveSegue(
  userId: string,
  params: { fromId: string; fromName?: string; toId: string; toName?: string; say: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO segues (user_id, from_id, from_name, to_id, to_name, say) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, params.fromId, params.fromName ?? null, params.toId, params.toName ?? null, params.say);
}

export function getRecentSegues(userId: string, limit = 10): SegueRecord[] {
  const rows = getDb()
    .prepare<[string, number], StoredSegue>(
      `SELECT id, from_id, from_name, to_id, to_name, say, created_at
       FROM segues WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit)
    .reverse();
  return rows.map((r) => ({
    fromName: r.from_name ?? r.from_id ?? '未知',
    toName: r.to_name ?? r.to_id ?? '未知',
    say: r.say.slice(0, 200),
    createdAt: r.created_at
  }));
}
```

- [ ] **Step 4.7: Rewrite `src/server/store/chat-preferences.ts`**

```ts
import { getDb } from './db.js';

export type ChatPreference = {
  id: number;
  summary: string;
  message_ids: string;
  created_at: string;
};

export function saveChatPreference(userId: string, summary: string, messageIds: number[]): number {
  const result = getDb()
    .prepare(
      `INSERT INTO chat_preferences (user_id, summary, message_ids, created_at) VALUES (?, ?, ?, datetime('now'))`
    )
    .run(userId, summary, JSON.stringify(messageIds));
  return Number(result.lastInsertRowid);
}

export function getLatestPreferences(userId: string, limit = 5): ChatPreference[] {
  return getDb()
    .prepare<[string, number], ChatPreference>(
      `SELECT id, summary, message_ids, created_at FROM chat_preferences
       WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit);
}

export function getPreferenceContext(userId: string, limit = 3): string {
  const prefs = getLatestPreferences(userId, limit);
  if (prefs.length === 0) return '';
  return prefs
    .reverse()
    .map((p) => p.summary)
    .join('\n---\n');
}
```

- [ ] **Step 4.8: Update `src/server/http/routes/plays.ts`**

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { startPlay, endPlay } from '../../store/plays.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const startPlayBodySchema = z.object({
  songId: z.string().min(1),
  songName: z.string().min(1),
  artistName: z.string().default('')
});

const endPlayBodySchema = z.object({
  reason: z.enum(['completed', 'skip', 'error'])
});

export function createStartPlayHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = startPlayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    const id = startPlay(userId, parsed.data);
    res.status(201).json({ ok: true, id });
  };
}

export function createEndPlayHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: 'invalid id' });
      return;
    }
    const parsed = endPlayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    const updated = endPlay(userId, id, parsed.data.reason);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'play not found or already ended' });
      return;
    }
    res.json({ ok: true });
  };
}
```

- [ ] **Step 4.9: Update `src/server/http/routes/messages.ts`**

Open the file. Change the handler to read `userId` from req and pass it to `getRecentMessages`:

```ts
import type { Request, Response } from 'express';
import type { NcmClient } from '../../ncm/client.js';
import { getRecentMessages } from '../../store/messages.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

export function createGetRecentMessagesHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const messages = getRecentMessages(userId, 20);
    res.json({ ok: true, messages });
  };
}
```

- [ ] **Step 4.10: Update `src/server/http/routes/location.ts`**

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { setLocation } from '../../store/location.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180)
});

export function createSetLocationHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    setLocation(userId, parsed.data.lat, parsed.data.lon);
    res.json({ ok: true });
  };
}
```

- [ ] **Step 4.11: Update `src/server/http/routes/queue.ts`**

Open `src/server/http/routes/queue.ts`. Add `type AuthedRequest` and pass `userId` to every queue store call. For example:

```ts
import type { Request, Response, RequestHandler } from 'express';
import type { NcmClient } from '../../ncm/client.js';
import {
  getQueue, setQueueState, getCurrentIndex, banNcmId
} from '../../store/queue.js';
// ... existing imports ...

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };
```

Then in each handler: `const { userId, ncmClient } = req as AuthedRequest;` and pass `userId` as the first arg to every `getQueue`, `setQueueState`, `getCurrentIndex`, `banNcmId` call.

> **Note:** Read the current `src/server/http/routes/queue.ts` in full before editing to see all function references. Apply the `userId` thread consistently through all handlers.

- [ ] **Step 4.12: Update `src/server/http/routes/plan.ts`**

In every handler (`createGetTodayPlanHandler`, `createRegeneratePlanHandler`, `createReplanSegmentHandler`, `createGapFillHandler`):

1. Add `type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };`
2. Remove `secrets: SecretStore` from options type — LLM config will come from `getConfig()` in Task 7; for now keep the `secrets` param but it'll be removed in Task 7.
3. Extract `userId` from `req as AuthedRequest`
4. Pass `userId` to all `loadLatestPlan`, `savePlan`, `getRecentPlays`, `buildPlanFragments` calls

For `buildPlanFragments`, add `userId` as first param:
```ts
export async function buildPlanFragments(userId: string, date: string, ncmClient: NcmClient): Promise<Fragments> {
  // ... existing code, but pass userId to getRecentPlays:
  const recentPlays = getRecentPlays(userId, 50);
```

- [ ] **Step 4.13: Update `src/server/http/routes/chat.ts`**

Read the full file, then add `userId` threading:
1. Add `type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };`
2. Change `createChatMessageHandler` options: remove `secrets: SecretStore`, keep `ncmClient: NcmClient` (or get from req)
3. The WS handler gets `userId` from `ws.userId` (added in Task 6's ws.ts changes)
4. Pass `userId` to: `getRecentPlays`, `getRecentMessages`, `saveMessage`, `getPreferenceContext`, `saveChatPreference`
5. Pass `userId` to queue functions: `getQueue(userId)`, `getCurrentIndex(userId)`, `addToQueue(userId, ...)`, `swapNext(userId, ...)`

> **Note:** `cancelChatRecommend` and `activeRecommendJobs` need per-user isolation too. For now, keep them as module globals — this is a known limitation for the first version.

- [ ] **Step 4.14: Update `src/server/http/routes/djNext.ts`**

1. Add `type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };`
2. Pass `userId` to: `getRecentPlays`, `getRecentMessages`, `getRecentSegues`, `getPreferenceContext`, `getQueue`, `addToQueue`
3. `isRunning` and `likedIdsCache` — make them `Map<string, ...>` keyed by userId:

```ts
const isRunning = new Map<string, boolean>();
type LikedIdsCache = { ids: string[]; fetchedAt: number };
const likedIdsCache = new Map<string, LikedIdsCache>();
```

Replace `if (isRunning)` → `if (isRunning.get(userId))`, etc.

- [ ] **Step 4.15: Update `src/server/http/routes/segue.ts`**

1. Add `type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };`
2. Extract `userId` from req
3. Pass `userId` to: `getRecentPlays`, `getRecentMessages`, `saveSegue`, `getRecentSegues`, `loadLikedTracksForPlanning`

- [ ] **Step 4.16: Update `src/server/http/routes/now-next.ts`**

Open the file — check if it calls any store functions. If it uses `getQueue` or `getCurrentIndex`, add userId. Use `req as AuthedRequest` to get `userId`.

- [ ] **Step 4.17: Remove scheduler from `src/server/index.ts`**

Remove these two lines:
```ts
import { startScheduler, stopScheduler } from './scheduler.js';
```
and the calls to `startScheduler(...)` and `stopScheduler()`.

- [ ] **Step 4.18: Update `tests/unit/plays.spec.ts`**

Add `userId` param to all store function calls in the test:

```ts
const id = startPlay('test-user', { songId: '123', songName: 'Test Song', artistName: 'Artist' });
// ...
const updated = endPlay('test-user', id, 'completed');
// ...
const rows = getRecentPlays('test-user', 10);
```

- [ ] **Step 4.19: Type check**

```bash
pnpm check
```

Expected: 0 errors. Fix any remaining issues before proceeding.

- [ ] **Step 4.20: Run tests**

```bash
pnpm test
```

Expected: existing tests pass.

- [ ] **Step 4.21: Commit**

```bash
git add -p  # stage all modified files
git commit -m "refactor(store): 所有 DB store 函数添加 userId 参数，路由 handler 同步更新"
```

---

## Task 5: NcmAuthService + Schema + Login Route

**Files:**
- Modify: `src/shared/schema.ts`
- Modify: `src/server/ncm/auth.ts`
- Modify: `src/server/http/routes/ncm-login.ts`

- [ ] **Step 5.1: Update `src/shared/schema.ts` — add `'forbidden'` hint**

Find:
```ts
export const NCM_QR_HINT = {
  [NCM_QR_CODE.EXPIRED]: 'expired',
  [NCM_QR_CODE.WAITING]: 'waiting',
  [NCM_QR_CODE.SCANNED]: 'scanned',
  [NCM_QR_CODE.AUTHORIZED]: 'authorized'
} as const satisfies Record<NcmQrCode, string>;

export type NcmQrHint = (typeof NCM_QR_HINT)[NcmQrCode];
```

Change to:

```ts
export const NCM_QR_HINT = {
  [NCM_QR_CODE.EXPIRED]: 'expired',
  [NCM_QR_CODE.WAITING]: 'waiting',
  [NCM_QR_CODE.SCANNED]: 'scanned',
  [NCM_QR_CODE.AUTHORIZED]: 'authorized'
} as const satisfies Record<NcmQrCode, string>;

export type NcmQrHint = (typeof NCM_QR_HINT)[NcmQrCode] | 'forbidden';
```

Also update `ncmQrStatusSchema` to include optional `token` field:

```ts
export const ncmQrStatusSchema = z.object({
  code: z.union([
    z.literal(NCM_QR_CODE.EXPIRED),
    z.literal(NCM_QR_CODE.WAITING),
    z.literal(NCM_QR_CODE.SCANNED),
    z.literal(NCM_QR_CODE.AUTHORIZED)
  ]),
  hint: z.enum(['expired', 'waiting', 'scanned', 'authorized', 'forbidden']),
  message: z.string(),
  hasCookie: z.boolean(),
  token: z.string().optional()
});
```

- [ ] **Step 5.2: Rewrite `src/server/ncm/auth.ts`**

```ts
import { SignJWT } from 'jose';
import type { NcmClient } from './client.js';
import { NCM_QR_CODE, NCM_QR_HINT, type NcmQrCode, type NcmQrHint } from '../../shared/schema.js';
import { getConfig } from '../config.js';
import { deriveKey, encrypt } from '../crypto.js';
import { upsertUser, recordBlockedAttempt } from '../store/users.js';
import { isAllowed } from '../allowlist.js';
import { ensureUserCorpus } from '../user-corpus/bootstrap.js';

const QR_MESSAGE: Record<NcmQrCode, string> = {
  [NCM_QR_CODE.EXPIRED]: '二维码已过期，请刷新重试',
  [NCM_QR_CODE.WAITING]: '等待扫码',
  [NCM_QR_CODE.SCANNED]: '已扫码，请在网易云 App 确认登录',
  [NCM_QR_CODE.AUTHORIZED]: '登录成功'
};

export type NcmQrStatusResult = {
  code: NcmQrCode;
  hint: NcmQrHint;
  message: string;
  hasCookie: boolean;
  token?: string;
};

export class NcmAuthService {
  constructor(private readonly client: NcmClient) {}

  async createQr(): Promise<{ key: string; qrimg: string; qrurl: string }> {
    return this.client.createLoginQr();
  }

  async checkQr(key: string): Promise<NcmQrStatusResult> {
    const result = await this.client.checkLoginQr(key);
    const code = normalizeQrCode(result.code);

    if (code !== NCM_QR_CODE.AUTHORIZED || !result.cookie) {
      return {
        code,
        hint: NCM_QR_HINT[code],
        message: result.message || QR_MESSAGE[code],
        hasCookie: false
      };
    }

    // QR authorized — get NCM user ID
    const loginStatus = await this.client.getLoginStatus();
    const profile = (loginStatus as any)?.data?.profile ?? null;
    const ncmId = String((profile as any)?.userId ?? '');

    if (!ncmId) {
      return {
        code: NCM_QR_CODE.EXPIRED,
        hint: 'expired',
        message: '无法获取用户信息，请重试',
        hasCookie: false
      };
    }

    // Whitelist check
    if (!isAllowed(ncmId)) {
      const profileJson = profile ? JSON.stringify(profile) : null;
      recordBlockedAttempt({ ncmId, profileJson });
      return {
        code: NCM_QR_CODE.AUTHORIZED,
        hint: 'forbidden',
        message: '您没有访问权限，请联系管理员',
        hasCookie: false
      };
    }

    // Persist encrypted cookie
    const config = getConfig();
    const key2 = deriveKey(config.jwtSecret);
    const encryptedCookie = encrypt(result.cookie, key2);
    const profileJson = profile ? JSON.stringify(profile) : null;
    upsertUser({ ncmId, encryptedCookie, profileJson });
    ensureUserCorpus(ncmId);

    // Sign JWT
    const secret = new TextEncoder().encode(config.jwtSecret);
    const ttlDays = config.jwtTtlDays;
    const token = await new SignJWT({ sub: ncmId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${ttlDays}d`)
      .sign(secret);

    return {
      code: NCM_QR_CODE.AUTHORIZED,
      hint: 'authorized',
      message: '登录成功',
      hasCookie: true,
      token
    };
  }
}

function normalizeQrCode(raw: number): NcmQrCode {
  switch (raw) {
    case NCM_QR_CODE.EXPIRED:
    case NCM_QR_CODE.WAITING:
    case NCM_QR_CODE.SCANNED:
    case NCM_QR_CODE.AUTHORIZED:
      return raw;
    default:
      return NCM_QR_CODE.EXPIRED;
  }
}
```

- [ ] **Step 5.3: Rewrite `src/server/http/routes/ncm-login.ts`**

```ts
import type { RequestHandler, Request, Response } from 'express';
import { z } from 'zod';
import type { NcmAuthService } from '../../ncm/auth.js';
import type { NcmClient } from '../../ncm/client.js';
import { NcmApiError } from '../../ncm/client.js';
import { NCM_ERROR_CODE, type NcmErrorCode } from '../../../shared/schema.js';
import { getUserById, deleteUser } from '../../store/users.js';
import { deriveKey, decrypt } from '../../crypto.js';
import { getConfig } from '../../config.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const qrQuerySchema = z.object({
  key: z.string().min(1)
});

export function createNcmQrHandler(auth: NcmAuthService): RequestHandler {
  return async (_req, res) => {
    try {
      const payload = await auth.createQr();
      res.json({ ok: true, ...payload });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNcmQrStatusHandler(auth: NcmAuthService): RequestHandler {
  return async (req, res) => {
    const parsed = qrQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: NCM_ERROR_CODE.BAD_RESPONSE, message: 'missing key' });
      return;
    }
    try {
      const result = await auth.checkQr(parsed.data.key);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendNcmError(res, error);
    }
  };
}

export function createNcmSessionHandler(): RequestHandler {
  return async (req, res) => {
    const { userId, ncmClient } = req as AuthedRequest;
    try {
      const loginStatus = await ncmClient.getLoginStatus();
      const profile = (loginStatus as any)?.data?.profile ?? null;
      res.json({ ok: true, hasCookie: true, profile });
    } catch {
      res.json({ ok: true, hasCookie: false, profile: null });
    }
  };
}

export function createNcmLogoutHandler(): RequestHandler {
  return async (req, res) => {
    const { userId, ncmClient } = req as AuthedRequest;
    try {
      await ncmClient.logout();
    } catch {
      // best effort
    } finally {
      deleteUser(userId);
    }
    res.json({ ok: true });
  };
}

function sendNcmError(res: Response, error: unknown): void {
  const { code, message } = classifyError(error);
  res.status(httpStatusFor(code)).json({ ok: false, error: code, message });
}

function classifyError(error: unknown): { code: NcmErrorCode; message: string } {
  if (error instanceof NcmApiError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : 'unknown error';
  return { code: NCM_ERROR_CODE.UNKNOWN, message };
}

function httpStatusFor(code: NcmErrorCode): number {
  switch (code) {
    case NCM_ERROR_CODE.UNAUTHORIZED:
    case NCM_ERROR_CODE.COOKIE_EXPIRED: return 401;
    case NCM_ERROR_CODE.RATE_LIMITED: return 429;
    case NCM_ERROR_CODE.TIMEOUT: return 504;
    case NCM_ERROR_CODE.UNAVAILABLE: return 503;
    case NCM_ERROR_CODE.BAD_RESPONSE: return 502;
    default: return 500;
  }
}
```

- [ ] **Step 5.4: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 5.5: Commit**

```bash
git add src/shared/schema.ts src/server/ncm/auth.ts src/server/http/routes/ncm-login.ts
git commit -m "feat(auth): NcmAuthService 重构为无状态 JWT 签发，QR 登录加白名单检查"
```

---

## Task 6: Auth Middleware + HTTP Server Wiring

**Files:**
- Create: `src/server/http/middleware/auth.ts`
- Create: `src/server/http/middleware/userScope.ts`
- Modify: `src/server/http/index.ts`
- Modify: `src/server/http/ws.ts`
- Modify: `src/server/http/routes/runtime.ts`

- [ ] **Step 6.1: Create `src/server/http/middleware/auth.ts`**

```ts
import { jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: '缺少认证令牌' });
    return;
  }

  const token = header.slice(7);
  try {
    const config = getConfig();
    const secret = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('invalid sub');
    }
    (req as Request & { userId: string }).userId = payload.sub;
    next();
  } catch (err) {
    getLogger().debug({ err }, 'JWT verification failed');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '令牌无效或已过期' });
  }
}
```

- [ ] **Step 6.2: Create `src/server/http/middleware/userScope.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import type { NcmClient as NcmClientType } from '../../ncm/client.js';
import { NcmClient } from '../../ncm/client.js';
import { getUserById } from '../../store/users.js';
import { deriveKey, decrypt } from '../../crypto.js';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

export async function userScopeMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const user = getUserById(userId);
  if (!user) {
    getLogger().warn({ userId }, 'Authed user not found in DB — cookie may have been cleared');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户记录不存在，请重新登录' });
    return;
  }

  try {
    const config = getConfig();
    const key = deriveKey(config.jwtSecret);
    const cookie = decrypt(user.ncm_cookie, key);
    const ncmBaseUrl = req.app.locals.ncmBaseUrl as string;
    const ncmClient = new NcmClient(ncmBaseUrl, { getCookie: () => cookie });
    (req as Request & { userId: string; ncmClient: NcmClientType }).ncmClient = ncmClient;
    next();
  } catch (err) {
    getLogger().error({ err, userId }, 'Failed to decrypt user cookie');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户凭证解密失败，请重新登录' });
  }
}
```

- [ ] **Step 6.3: Create middleware directory**

```bash
mkdir -p src/server/http/middleware
```

- [ ] **Step 6.4: Rewrite `src/server/http/index.ts`**

```ts
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { getConfig } from '../config.js';
import { getHealthHandler } from './routes/health.js';
import { setupWsServer } from './ws.js';
import type { NcmProcessManager } from '../ncm/spawn.js';
import { createNcmStatusHandler } from './routes/ncm.js';
import type { NcmAuthService } from '../ncm/auth.js';
import {
  createNcmLogoutHandler,
  createNcmQrHandler,
  createNcmQrStatusHandler,
  createNcmSessionHandler
} from './routes/ncm-login.js';
import { createNextHandler, createNowHandler } from './routes/now-next.js';
import { createStartPlayHandler, createEndPlayHandler } from './routes/plays.js';
import {
  createGetSettingsHandler,
  createSaveSettingsHandler
} from './routes/settings.js';
import {
  createGetTodayPlanHandler,
  createRegeneratePlanHandler,
  createReplanSegmentHandler,
  createGapFillHandler
} from './routes/plan.js';
import { createSegueTriggerHandler, createSegueAudioHandler } from './routes/segue.js';
import { createChatMessageHandler, cancelChatRecommend } from './routes/chat.js';
import { createDjPickNextHandler } from './routes/djNext.js';
import { createGetRecentMessagesHandler } from './routes/messages.js';
import { createSetLocationHandler } from './routes/location.js';
import { createRuntimeHandler } from './routes/runtime.js';
import {
  createGetLikedIdsHandler,
  createGetLikedQueueHandler,
  createLikeTrackHandler,
  createSetQueueStateHandler
} from './routes/queue.js';
import { authMiddleware } from './middleware/auth.js';
import { userScopeMiddleware } from './middleware/userScope.js';

export type LocalServer = {
  port: number;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
};

type StartLocalServerOptions = {
  ncm: NcmProcessManager;
  ncmAuth: NcmAuthService;
  ncmBaseUrl: string;
  host: string;
  port: number;
  staticDir?: string | null;
};

export async function startLocalServer(options: StartLocalServerOptions): Promise<LocalServer> {
  const config = getConfig();
  const app = express();

  // Store NCM base URL for middleware
  app.locals.ncmBaseUrl = options.ncmBaseUrl;

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === 'null') { callback(null, true); return; }
        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) { callback(null, true); return; }
        if (config.allowedOrigins.some((o) => o === origin)) { callback(null, true); return; }
        callback(new Error(`CORS blocked origin: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // ── Public routes ─────────────────────────────────────────────────────────
  app.get('/api/runtime', createRuntimeHandler());
  app.get('/api/health', getHealthHandler);
  app.get('/api/ncm/status', createNcmStatusHandler(options.ncm));
  app.get('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.post('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.get('/api/ncm/login/status', createNcmQrStatusHandler(options.ncmAuth));
  app.get('/api/segue/audio/*', createSegueAudioHandler());

  // ── Protected routes ──────────────────────────────────────────────────────
  const protect = [authMiddleware, userScopeMiddleware];

  app.get('/api/ncm/login/session', protect, createNcmSessionHandler());
  app.post('/api/ncm/login/logout', protect, createNcmLogoutHandler());
  app.post('/api/ncm/logout', protect, createNcmLogoutHandler());
  app.get('/api/now', protect, createNowHandler());
  app.get('/api/next', protect, createNextHandler());
  app.post('/api/plays', protect, createStartPlayHandler());
  app.patch('/api/plays/:id', protect, createEndPlayHandler());
  app.get('/api/settings', protect, createGetSettingsHandler());
  app.put('/api/settings', protect, createSaveSettingsHandler());
  app.get('/api/plan/today', protect, createGetTodayPlanHandler());
  app.post('/api/plan/regenerate', protect, createRegeneratePlanHandler());
  app.post('/api/plan/replan-segment', protect, createReplanSegmentHandler());
  app.post('/api/plan/gap-fill', protect, createGapFillHandler());
  app.get('/api/queue/liked/ids', protect, createGetLikedIdsHandler());
  app.get('/api/queue/liked', protect, createGetLikedQueueHandler());
  app.post('/api/queue/like', protect, createLikeTrackHandler());
  app.put('/api/queue/state', protect, createSetQueueStateHandler());
  app.post('/api/segue/trigger', protect, createSegueTriggerHandler());
  app.post('/api/dj/pick-next', protect, createDjPickNextHandler());
  app.get('/api/messages/recent', protect, createGetRecentMessagesHandler());
  app.post('/api/location', protect, createSetLocationHandler());

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api(?:\/|$)|\/ws(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    res.status(500).json({ ok: false, error: message });
  });

  const server = createServer(app);
  const chatHandler = createChatMessageHandler();
  setupWsServer(server, { ncmBaseUrl: options.ncmBaseUrl, onChatMessage: chatHandler, onCancelRecommend: cancelChatRecommend });

  const port = await listen(server, options.host, options.port);
  const baseUrl = `http://${options.host}:${port}`;
  const wsUrl = `ws://${options.host}:${port}/ws`;

  return {
    port,
    baseUrl,
    wsUrl,
    close: async () => closeServer(server)
  };
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Failed to acquire port.')); return; }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

- [ ] **Step 6.5: Update route handlers that receive `secrets` or `ncmClient` from options**

In `plan.ts`, `chat.ts`, `djNext.ts`, `segue.ts`, `queue.ts`, `now-next.ts` — remove the `secrets: SecretStore` and `ncmClient: NcmClient` from their options types. All protected handlers now get `ncmClient` from `req.ncmClient` (set by userScope middleware).

For each handler factory that had `options: { secrets, ncmClient }`:
- Remove the options parameter entirely (or just `ncmClient` if secrets was already removed)
- Extract from req: `const { userId, ncmClient } = req as AuthedRequest;`

- [ ] **Step 6.6: Update `src/server/http/ws.ts`**

```ts
import { jwtVerify } from 'jose';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { wsAuthSchema } from '../../shared/schema.js';
import { registerWss } from './broadcast.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { getUserById } from '../store/users.js';
import { deriveKey, decrypt } from '../crypto.js';
import { NcmClient } from '../ncm/client.js';

export type ChatMessageHandler = (ws: WebSocket & { userId: string; ncmClient: NcmClient }, text: string) => void;
export type CancelRecommendHandler = (jobId: string) => void;

type WsOptions = {
  ncmBaseUrl: string;
  onChatMessage?: ChatMessageHandler;
  onCancelRecommend?: CancelRecommendHandler;
};

export function setupWsServer(server: Server, options: WsOptions): WebSocketServer {
  const logger = getLogger();
  const wss = new WebSocketServer({ noServer: true });
  registerWss(wss);

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') { socket.destroy(); return; }

    wss.handleUpgrade(request, socket, head, (ws) => {
      type ExtWs = WebSocket & { authenticated?: boolean; userId?: string; ncmClient?: NcmClient };
      const extWs = ws as ExtWs;
      extWs.authenticated = false;

      ws.on('message', async (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as unknown;

          if (!extWs.authenticated) {
            const authResult = wsAuthSchema.safeParse(parsed);
            if (!authResult.success) { ws.close(4001, 'unauthorized'); return; }

            const token = authResult.data.token;
            try {
              const config = getConfig();
              const secret = new TextEncoder().encode(config.jwtSecret);
              const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
              if (typeof payload.sub !== 'string') throw new Error('no sub');

              const user = getUserById(payload.sub);
              if (!user) { ws.close(4001, 'user not found'); return; }

              const key = deriveKey(config.jwtSecret);
              const cookie = decrypt(user.ncm_cookie, key);
              extWs.userId = payload.sub;
              extWs.ncmClient = new NcmClient(options.ncmBaseUrl, { getCookie: () => cookie });
              extWs.authenticated = true;
              ws.send(JSON.stringify({ type: 'auth.ok' }));
            } catch {
              ws.close(4001, 'unauthorized');
            }
            return;
          }

          const msg = parsed as Record<string, unknown>;
          if (msg.type === 'chat' && typeof msg.text === 'string') {
            options.onChatMessage?.(extWs as WebSocket & { userId: string; ncmClient: NcmClient }, msg.text);
            return;
          }
          if (msg.type === 'chat.cancel-recommend' && typeof msg.jobId === 'string') {
            options.onCancelRecommend?.(msg.jobId);
            return;
          }
          ws.send(JSON.stringify({ type: 'noop', received: msg.type ?? 'unknown' }));
        } catch {
          logger.warn('WS bad message, closing');
          ws.close(1003, 'bad message');
        }
      });

      ws.on('error', () => ws.close());
    });
  });

  return wss;
}
```

- [ ] **Step 6.7: Update `src/server/http/routes/runtime.ts`**

```ts
import type { RequestHandler } from 'express';

export function createRuntimeHandler(): RequestHandler {
  return (_req, res) => {
    res.json({ ok: true, version: '2.0.0' });
  };
}
```

- [ ] **Step 6.8: Update `src/server/http/routes/chat.ts`** to use WS-carried userId

The chat handler receives a `WebSocket & { userId, ncmClient }` instead of the HTTP req. Update the signature:

```ts
export function createChatMessageHandler() {
  return async (ws: WebSocket & { userId: string; ncmClient: NcmClient }, text: string): Promise<void> => {
    const { userId, ncmClient } = ws;
    // ... rest of handler uses userId and ncmClient from ws object
  };
}
```

- [ ] **Step 6.9: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 6.10: Commit**

```bash
git add src/server/http/middleware/ src/server/http/index.ts src/server/http/ws.ts src/server/http/routes/runtime.ts src/server/http/routes/chat.ts
git commit -m "feat(auth): JWT 中间件、userScope 中间件、受保护路由和 WS 认证"
```

---

## Task 7: LLM/TTS Config From Env + Settings Route Rewrite

**Files:**
- Modify: `src/server/llm/config.ts`
- Modify: `src/server/tts/config.ts`
- Modify: `src/server/http/routes/settings.ts`

- [ ] **Step 7.1: Rewrite `src/server/llm/config.ts`**

```ts
import { getConfig } from '../config.js';
import type { LlmConfig } from './client.js';

export function resolveLlmConfig(): LlmConfig {
  const config = getConfig();
  return {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey
  };
}
```

- [ ] **Step 7.2: Rewrite `src/server/tts/config.ts`**

```ts
import { getConfig } from '../config.js';
import { getPref } from '../store/prefs.js';
import type { TtsConfig } from './client.js';

export const DEFAULT_TTS_VOICE = 'Cherry';

export const DEFAULT_TTS_CONFIG = {
  provider: 'aliyun-qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  model: 'qwen-tts',
  voice: DEFAULT_TTS_VOICE,
  speed: 1,
  format: 'mp3'
} as const satisfies Omit<TtsConfig, 'apiKey'>;

export function resolveTtsConfig(userId: string): TtsConfig {
  const config = getConfig();
  const userVoice = getPref<string>(userId, 'tts.voice');
  const voice = userVoice || config.tts.voiceDefault || DEFAULT_TTS_VOICE;
  return {
    provider: 'aliyun-qwen',
    baseUrl: config.tts.baseUrl,
    apiKey: config.tts.apiKey,
    model: DEFAULT_TTS_CONFIG.model,
    voice,
    speed: DEFAULT_TTS_CONFIG.speed,
    format: DEFAULT_TTS_CONFIG.format
  };
}
```

- [ ] **Step 7.3: Update all callers of `resolveLlmConfig` and `resolveTtsConfig`**

Find all files that import these functions:
```bash
grep -rn "resolveLlmConfig\|resolveTtsConfig" src/server
```

For each caller:
- `resolveLlmConfig(secrets)` → `resolveLlmConfig()` (remove secrets arg)
- `resolveTtsConfig(secrets)` → `resolveTtsConfig(userId)` (replace secrets with userId from req or ws)
- Remove `if (!llm)` / `if (!tts)` null guards — both functions now always return a value (env vars are required at startup)
- Remove `SecretStore` imports from any callers

- [ ] **Step 7.4: Rewrite `src/server/http/routes/settings.ts`**

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { getPref, setPref } from '../../store/prefs.js';
import { getConfig } from '../../config.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

// ── GET /api/settings ─────────────────────────────────────────────────────────

export function createGetSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const config = getConfig();
    const userVoice = getPref<string>(userId, 'tts.voice');

    res.json({
      ok: true,
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        hasApiKey: Boolean(config.llm.apiKey)
      },
      tts: {
        baseUrl: config.tts.baseUrl,
        hasApiKey: Boolean(config.tts.apiKey),
        voice: userVoice ?? config.tts.voiceDefault ?? 'Cherry',
        voiceDefault: config.tts.voiceDefault
      }
    });
  };
}

// ── PUT /api/settings ─────────────────────────────────────────────────────────

const settingsBodySchema = z.object({
  tts: z.object({ voice: z.string().min(1) }).optional()
});

export function createSaveSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }
    if (parsed.data.tts?.voice) {
      setPref(userId, 'tts.voice', parsed.data.tts.voice);
    }
    res.json({ ok: true });
  };
}
```

- [ ] **Step 7.5: Update `tests/unit/tts-config.spec.ts`** to remove SecretStore dependency

Open the file. Replace any `SecretStore` usage with env vars and `resetConfigForTest()`. The new `resolveTtsConfig(userId)` requires a DB. Either mock the DB or adapt the tests to the new interface. If tests become too complex, delete the old test and write a new one.

- [ ] **Step 7.6: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 7.7: Commit**

```bash
git add src/server/llm/config.ts src/server/tts/config.ts src/server/http/routes/settings.ts
git commit -m "feat(config): LLM/TTS 配置改从环境变量读取，Settings 简化为仅 TTS 音色可选"
```

---

## Task 8: user-corpus Per-User + Bootstrap Cleanup

**Files:**
- Modify: `src/server/app-paths.ts`
- Modify: `src/server/user-corpus/bootstrap.ts`
- Modify: `src/server/user-corpus/loader.ts`
- Modify: `src/server/index.ts`
- Delete: `src/server/security.ts`
- Delete: `src/server/scheduler.ts`
- Delete: `tests/unit/security.spec.ts`

- [ ] **Step 8.1: Add `resolveUserDir` to `src/server/app-paths.ts`**

Add this function:

```ts
export function resolveUserDir(ncmId: string): string {
  const userDir = path.join(resolveAppDataDir(), 'users', ncmId);
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}
```

Keep the existing `resolveUserCorpusDir()` as-is for backward compatibility during migration.

- [ ] **Step 8.2: Update `src/server/user-corpus/bootstrap.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDir, resolveUserTemplateDir } from '../app-paths.js';

export function ensureUserCorpus(ncmId: string): void {
  const userDir = resolveUserDir(ncmId);
  const templateDir = resolveUserTemplateDir();

  if (!fs.existsSync(templateDir)) return;

  const templateEntries = fs.readdirSync(templateDir, { withFileTypes: true });
  for (const entry of templateEntries) {
    if (!entry.isFile()) continue;
    const source = path.join(templateDir, entry.name);
    const target = path.join(userDir, entry.name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}
```

- [ ] **Step 8.3: Update `src/server/user-corpus/loader.ts`**

Change `resolveUserCorpusDir()` calls to `resolveUserDir(ncmId)`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveUserDir } from '../app-paths.js';
import { playlistRefSchema } from '../agent/schema.js';
import { getLogger } from '../logger.js';

// ... keep existing types and schemas ...

export function loadCorpusFile(ncmId: string, filename: string): string {
  const filePath = path.join(resolveUserDir(ncmId), filename);
  if (!fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function loadPlaylists(ncmId: string): PlaylistEntry[] {
  const filePath = path.join(resolveUserDir(ncmId), 'playlists.json');
  // ... same validation logic as before ...
}

export function loadUserCorpus(ncmId: string): UserCorpus {
  return {
    taste: loadCorpusFile(ncmId, 'taste.md'),
    routines: loadCorpusFile(ncmId, 'routines.md'),
    moodRules: loadCorpusFile(ncmId, 'mood-rules.md'),
    djPersona: loadCorpusFile(ncmId, 'dj-persona.md'),
    playlists: loadPlaylists(ncmId)
  };
}
```

- [ ] **Step 8.4: Update all callers of `loadUserCorpus` and `loadCorpusFile`**

```bash
grep -rn "loadUserCorpus\|loadCorpusFile\|loadPlaylists" /Users/justynchen/Documents/code/crossfadio-dev/src/server
```

For each caller, extract `userId` from req or ws object, and pass it as the first arg.

- [ ] **Step 8.5: Rewrite `src/server/index.ts`**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer, type LocalServer } from './http/index.js';
import { initDb } from './store/db.js';
import { getLogger } from './logger.js';
import { loadConfig } from './config.js';
import { loadAllowlist } from './allowlist.js';
import { NcmProcessManager } from './ncm/spawn.js';
import { NcmClient } from './ncm/client.js';
import { NcmAuthService } from './ncm/auth.js';
import { resolveStaticDir as resolveRuntimeStaticDir } from './runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let localServer: LocalServer | null = null;
let ncm: NcmProcessManager | null = null;

async function bootstrap(): Promise<void> {
  const logger = getLogger();

  try {
    // Validate required env vars at startup
    loadConfig();
    loadAllowlist();
    initDb();

    ncm = new NcmProcessManager();
    await ncm.start();

    const ncmBaseUrl = ncm.getStatus().baseUrl;
    const ncmClient = new NcmClient(ncmBaseUrl, { getCookie: () => null });
    const ncmAuth = new NcmAuthService(ncmClient);

    localServer = await startLocalServer({
      ncm,
      ncmAuth,
      ncmBaseUrl,
      host: resolveHost(),
      port: resolveServerPort(),
      staticDir: resolveStaticDir()
    });

    logger.info({ baseUrl: localServer.baseUrl }, 'Crossfadio web server started');
  } catch (error) {
    logger.error({ err: error }, 'Failed to bootstrap Crossfadio web server');
    await shutdown();
    process.exitCode = 1;
  }
}

async function shutdown(): Promise<void> {
  const logger = getLogger();
  if (ncm) {
    try { await ncm.stop(); } catch (error) { logger.warn({ err: error }, 'Failed to stop NCM'); }
    finally { ncm = null; }
  }
  if (localServer) {
    try { await localServer.close(); } catch (error) { logger.warn({ err: error }, 'Failed to close server'); }
    finally { localServer = null; }
  }
}

function resolveServerPort(): number {
  const rawPort = Number(process.env.CROSSFADIO_PORT ?? '4318');
  return Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 4318;
}

function resolveHost(): string {
  return process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1';
}

function resolveStaticDir(): string | null {
  return resolveRuntimeStaticDir({ rootDir: path.resolve(__dirname, '../..'), nodeEnv: process.env.NODE_ENV });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown().finally(() => process.exit(0)));
}

void bootstrap();
```

- [ ] **Step 8.6: Delete files**

```bash
rm src/server/security.ts src/server/scheduler.ts tests/unit/security.spec.ts
```

- [ ] **Step 8.7: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 8.8: Run all tests**

```bash
pnpm test
```

Fix any failing tests.

- [ ] **Step 8.9: Commit**

```bash
git add -A
git commit -m "refactor: user-corpus 按 ncmId 隔离目录，移除 SecretStore 和 scheduler"
```

---

## Task 9: Frontend — JWT Storage + Auth Header + Settings UI

**Files:**
- Modify: `src/renderer/api.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/views/Settings/SettingsView.tsx`

- [ ] **Step 9.1: Update `src/renderer/api.ts`**

Add JWT storage helpers and auth header injection:

```ts
// JWT storage
const JWT_KEY = 'crossfadio_jwt';

export function getStoredToken(): string | null {
  return localStorage.getItem(JWT_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(JWT_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(JWT_KEY);
}
```

Update `requestJson` to add Authorization header when token is present:

```ts
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const runtime = resolveRuntimeConfig();
  const token = getStoredToken();

  let response: Response;
  try {
    response = await fetch(new URL(path, runtime.baseUrl), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network error';
    throw new Error(`请求 ${path} 失败（baseUrl=${runtime.baseUrl}）：${message}`);
  }
  // ... rest unchanged
```

Update `RuntimeInfo` type:
```ts
type RuntimeInfo = {
  ok: boolean;
};
```

Update the QR status polling function to store the JWT token when `authorized`:
```ts
export async function pollNcmQrStatus(key: string): Promise<NcmQrStatus> {
  const payload = await requestJson<unknown>(`/api/ncm/login/status?key=${encodeURIComponent(key)}`);
  const result = ncmQrStatusSchema.parse(payload);
  if (result.hint === 'authorized' && result.token) {
    storeToken(result.token);
  }
  return result;
}
```

Update logout to clear token:
```ts
export async function ncmLogout(): Promise<void> {
  const payload = await requestJson<{ ok?: boolean }>('/api/ncm/login/logout', { method: 'POST' });
  clearToken();
  if (!payload?.ok) throw new Error('Logout failed');
}
```

- [ ] **Step 9.2: Update `src/renderer/App.tsx`**

Replace the `getRuntimeInfo().then(initWsClient)` pattern:

```ts
useEffect(() => {
  const token = getStoredToken();
  if (token) {
    initWsClient(token);
  }
  // Still ping runtime to check service health, but ignore sessionToken
  void getRuntimeInfo().catch(() => {});
}, []);
```

Import `getStoredToken` from api.

- [ ] **Step 9.3: Update `src/renderer/views/Settings/SettingsView.tsx`**

Read the current file first to understand the UI structure. Then:
1. Remove the LLM/TTS key input fields and test buttons
2. Remove any calls to `saveSettings` for LLM/TTS keys
3. Keep TTS voice selector — update it to call `PUT /api/settings` with `{ tts: { voice } }`
4. Add a read-only section showing LLM baseUrl + masked key status from `GET /api/settings`
5. Ensure logout button calls `ncmLogout()` which now also clears localStorage JWT
6. After logout, optionally redirect to a login-required state (e.g., show the QR code UI)

- [ ] **Step 9.4: Type check**

```bash
pnpm check
```

Expected: 0 errors.

- [ ] **Step 9.5: Run all tests**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 9.6: Commit**

```bash
git add src/renderer/api.ts src/renderer/App.tsx src/renderer/views/Settings/SettingsView.tsx
git commit -m "feat(frontend): JWT 存储、请求认证头、Settings UI 简化"
```

---

## Self-Review Checklist

After all 9 tasks are complete, verify:

- [ ] `pnpm check` — 0 TypeScript errors
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm build` — production build succeeds
- [ ] Manual smoke test: create `allowlist.json` with your NCM ID, start server with required env vars, scan QR code, verify JWT received and stored, verify API requests work, verify `/api/segue/audio/*` accessible without auth, verify second user is blocked if not in allowlist
- [ ] Verify blocked login attempts table records unauthorized attempts
- [ ] Verify logout clears DB cookie and localStorage JWT

---

## Environment Variables Required for Testing

```bash
export CROSSFADIO_JWT_SECRET="your-strong-secret-at-least-32-chars"
export CROSSFADIO_LLM_BASE_URL="https://api.openai.com"
export CROSSFADIO_LLM_API_KEY="sk-..."
export CROSSFADIO_LLM_MODEL="gpt-4o"
export CROSSFADIO_TTS_BASE_URL="https://dashscope.aliyuncs.com/..."
export CROSSFADIO_TTS_API_KEY="sk-..."
export CROSSFADIO_ALLOWED_ORIGINS="http://localhost:5173"
```

Create `{data_dir}/allowlist.json`:
```json
["your_ncm_user_id"]
```
