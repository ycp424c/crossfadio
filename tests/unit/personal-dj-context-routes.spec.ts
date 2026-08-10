import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { resetConfigForTest } from '../../src/server/config';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { loadAllowlist } from '../../src/server/allowlist';
import { upsertUser } from '../../src/server/store/users';
import { setUserAccessStatus } from '../../src/server/store/user-access-controls';
import {
  createPersonalDjContextToken,
  listPersonalDjContextTokens,
  revokePersonalDjContextToken
} from '../../src/server/store/personal-dj-context-tokens';
import { authMiddleware } from '../../src/server/http/middleware/auth';
import { personalDjContextBridgeAuth } from '../../src/server/http/middleware/personalDjContextBridgeAuth';
import {
  createCreatePersonalDjContextTokenHandler,
  createListPersonalDjContextTokensHandler,
  createPostPersonalDjContextHandler,
  createRevokePersonalDjContextTokenHandler
} from '../../src/server/http/routes/personal-dj-context';
import { getPersonalDjContextSnapshot } from '../../src/server/store/personal-dj-context';
import { getRecentDjEvents } from '../../src/server/store/dj-events';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-personal-dj-context-routes-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  resetConfigForTest();
  initDb();
  fs.writeFileSync(path.join(dataDir, 'allowlist.json'), JSON.stringify(['user-1']));
  loadAllowlist();
  upsertUser({ ncmId: 'user-1', encryptedCookie: 'encrypted-cookie', profileJson: null });
});

afterEach(() => {
  _resetDbForTest();
  process.env = { ...originalEnv };
  if (originalDataDir !== undefined) process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  resetConfigForTest();
});

describe('personal DJ context settings token routes', () => {
  it('creates, lists and revokes Bridge Tokens without exposing plaintext after creation', () => {
    const createHandler = createCreatePersonalDjContextTokenHandler();
    const createRes = createJsonResponse();
    createHandler({ userId: 'user-1', body: { name: 'Local bridge' } } as never, createRes as never);

    expect(createRes.statusCode).toBe(200);
    const created = createRes.body as { token: { id: string; token: string } };
    expect(created.token.token).toMatch(/^cfdj_ctx_/);

    const listHandler = createListPersonalDjContextTokensHandler();
    const listRes = createJsonResponse();
    listHandler({ userId: 'user-1' } as never, listRes as never);
    expect(JSON.stringify(listRes.body)).not.toContain(created.token.token);
    expect(listRes.body).toMatchObject({
      ok: true,
      tokens: [{ id: created.token.id, name: 'Local bridge' }]
    });

    const revokeHandler = createRevokePersonalDjContextTokenHandler();
    const revokeRes = createJsonResponse();
    revokeHandler({ userId: 'user-1', params: { id: created.token.id } } as never, revokeRes as never);
    expect(revokeRes.body).toEqual({ ok: true, revoked: true });
  });
});

describe('personal DJ context upload route', () => {
  it('accepts a valid Bridge Token upload and records a DJ event', () => {
    const token = createPersonalDjContextToken('user-1');
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: createPayload('bundle-1')
    } as unknown as Request;
    const authRes = createJsonResponse();
    const next = vi.fn();

    personalDjContextBridgeAuth(req, authRes as unknown as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(listPersonalDjContextTokens('user-1')[0]?.lastUsedAt).toEqual(expect.any(String));

    const handler = createPostPersonalDjContextHandler();
    const res = createJsonResponse();
    handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const body = res.body as { contextId: string };
    expect(body.contextId).toEqual(expect.any(String));
    expect(getPersonalDjContextSnapshot('user-1').current?.id).toBe(body.contextId);
    const event = getRecentDjEvents('user-1')[0];
    expect(event).toMatchObject({
      type: 'personal_context_uploaded',
      correlationId: body.contextId
    });
    expect(event.payload).toEqual({
      contextId: body.contextId,
      generatedAt: (req.body as { generatedAt: string }).generatedAt,
      uploadedAt: expect.any(String),
      source: { kind: 'lifemesh_bundle' },
      musicHintCount: 1
    });
    expect(JSON.stringify(event.payload)).not.toContain('最近在密集写代码');
    expect(JSON.stringify(event.payload)).not.toContain('bundle-1');
  });

  it('rejects uploads with unknown top-level fields', () => {
    const token = createPersonalDjContextToken('user-1');
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: { ...createPayload('bundle-1'), rawSlices: [] }
    } as unknown as Request;
    const authRes = createJsonResponse();
    const next = vi.fn();
    personalDjContextBridgeAuth(req, authRes as unknown as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();

    const handler = createPostPersonalDjContextHandler();
    const res = createJsonResponse();
    handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid body' });
  });

  it('rejects a context generated more than five minutes in the future', () => {
    const req = {
      userId: 'user-1',
      body: {
        ...createPayload('future-bundle'),
        generatedAt: new Date(Date.now() + 5 * 60 * 1000 + 1_000).toISOString()
      }
    } as unknown as Request;
    const handler = createPostPersonalDjContextHandler();
    const res = createJsonResponse();

    handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: 'personal_dj_context_generated_in_future'
    });
  });

  it('rejects oversized uploads before schema validation', () => {
    const token = createPersonalDjContextToken('user-1');
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: { oversized: 'x'.repeat(17 * 1024) }
    } as unknown as Request;
    const authRes = createJsonResponse();
    const next = vi.fn();
    personalDjContextBridgeAuth(req, authRes as unknown as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();

    const handler = createPostPersonalDjContextHandler();
    const res = createJsonResponse();
    handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ ok: false, error: 'payload too large' });
  });

  it('rejects invalid Bridge Tokens before upload handling', () => {
    const req = {
      headers: { authorization: 'Bearer cfdj_ctx_invalid' },
      body: createPayload('bundle-1')
    } as unknown as Request;
    const res = createJsonResponse();
    const next = vi.fn();

    personalDjContextBridgeAuth(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects revoked Bridge Tokens before upload handling', () => {
    const token = createPersonalDjContextToken('user-1');
    revokePersonalDjContextToken('user-1', token.id);
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: createPayload('bundle-1')
    } as unknown as Request;
    const res = createJsonResponse();
    const next = vi.fn();

    personalDjContextBridgeAuth(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('does not accept a Bridge Token as normal JWT auth', async () => {
    const token = createPersonalDjContextToken('user-1');
    const req = {
      query: {},
      headers: { authorization: `Bearer ${token.token}` }
    } as unknown as Request;
    const res = createJsonResponse();
    const next = vi.fn();

    await authMiddleware(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid Bridge Token from an ordinary user not in the allowlist', () => {
    // user-2 is not in the allowlist, but the Bridge token alone must authorize.
    upsertUser({ ncmId: 'user-2', encryptedCookie: 'encrypted-cookie', profileJson: null });
    const token = createPersonalDjContextToken('user-2');
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: createPayload('bundle-2')
    } as unknown as Request;
    const res = createJsonResponse();
    const next = vi.fn();

    personalDjContextBridgeAuth(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('rejects a suspended user at the Bridge-token boundary even with a valid token', () => {
    upsertUser({ ncmId: 'user-3', encryptedCookie: 'encrypted-cookie', profileJson: null });
    setUserAccessStatus('user-3', 'suspended');
    const token = createPersonalDjContextToken('user-3');
    const req = {
      headers: { authorization: `Bearer ${token.token}` },
      body: createPayload('bundle-3')
    } as unknown as Request;
    const res = createJsonResponse();
    const next = vi.fn();

    personalDjContextBridgeAuth(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

function createJsonResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  };
  return res;
}

function createPayload(bundleId: string) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: '最近在密集写代码，适合低干扰、稳定节奏的音乐。',
    currentState: {
      activity: 'coding',
      energy: 'medium',
      attention: 'low_distraction',
      mood: 'focused'
    },
    musicGuidance: {
      energyCurve: 'steady',
      preferredTextures: ['steady rhythm'],
      avoidTextures: ['too noisy'],
      vocalPreference: 'mixed',
      novelty: 'balanced'
    },
    musicHints: [
      {
        kind: 'style',
        label: 'low-distraction city pop',
        strength: 'medium',
        reason: 'fits current focus state'
      }
    ],
    segueGuidance: {
      tone: 'familiar but discreet',
      privacyRule: 'Acknowledge broad state only; do not reveal concrete private details.'
    },
    source: {
      kind: 'lifemesh_bundle',
      bundleId,
      sliceRefs: [
        {
          sliceId: `${bundleId}-slice`,
          evidenceRole: 'context',
          citationLabel: 'manual-input-v1:test'
        }
      ]
    }
  };
}
