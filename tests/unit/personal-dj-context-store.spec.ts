import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import {
  cleanupExpiredPersonalDjContexts,
  getCurrentPersonalDjContext,
  getPersonalDjContextSnapshot,
  listPersonalDjContexts,
  revokeCurrentPersonalDjContext,
  savePersonalDjContext
} from '../../src/server/store/personal-dj-context';
import {
  PERSONAL_DJ_CONTEXT_ACTIVE_TOKEN_LIMIT,
  createPersonalDjContextToken,
  listPersonalDjContextTokens,
  resolvePersonalDjContextToken,
  revokePersonalDjContextToken
} from '../../src/server/store/personal-dj-context-tokens';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-personal-dj-context-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('personal DJ context store', () => {
  it('keeps latest as current and recent prior records as trend signals', () => {
    const now = new Date();
    const old = savePersonalDjContext({
      userId: 'user-1',
      uploadedAt: hoursBefore(now, 26),
      payload: createPayload('old bundle')
    });
    const trend = savePersonalDjContext({
      userId: 'user-1',
      uploadedAt: hoursBefore(now, 4),
      payload: createPayload('morning bundle')
    });
    const current = savePersonalDjContext({
      userId: 'user-1',
      uploadedAt: hoursBefore(now, 1),
      payload: createPayload('current bundle')
    });

    cleanupExpiredPersonalDjContexts('user-1', now);
    const snapshot = getPersonalDjContextSnapshot('user-1', now);

    expect(snapshot.current?.id).toBe(current.id);
    expect(snapshot.trend.map((item) => item.id)).toEqual([trend.id]);
    expect(listPersonalDjContexts('user-1').map((item) => item.id)).not.toContain(old.id);
  });

  it('revokes active context window without deleting retained records', () => {
    savePersonalDjContext({ userId: 'user-1', payload: createPayload('first') });
    const current = savePersonalDjContext({ userId: 'user-1', payload: createPayload('second') });

    expect(getCurrentPersonalDjContext('user-1')?.id).toBe(current.id);
    expect(revokeCurrentPersonalDjContext('user-1')).toBe(true);
    expect(getCurrentPersonalDjContext('user-1')).toBeNull();
    expect(listPersonalDjContexts('user-1')).toHaveLength(2);
    expect(getPersonalDjContextSnapshot('user-1').trend).toEqual([]);
  });
});

describe('personal DJ context tokens store', () => {
  it('creates named hash-only tokens and resolves active tokens', () => {
    const created = createPersonalDjContextToken('user-1', 'Local bridge');

    expect(created.token).toMatch(/^cfdj_ctx_/);
    const listed = listPersonalDjContextTokens('user-1');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(resolvePersonalDjContextToken(created.token)).toMatchObject({
      id: created.id,
      userId: 'user-1',
      name: 'Local bridge'
    });
  });

  it('does not resolve revoked tokens', () => {
    const created = createPersonalDjContextToken('user-1');

    expect(revokePersonalDjContextToken('user-1', created.id)).toBe(true);
    expect(resolvePersonalDjContextToken(created.token)).toBeNull();
  });

  it('enforces the active token cap per user', () => {
    for (let index = 0; index < PERSONAL_DJ_CONTEXT_ACTIVE_TOKEN_LIMIT; index += 1) {
      createPersonalDjContextToken('user-1', `Bridge ${index + 1}`);
    }

    expect(() => createPersonalDjContextToken('user-1', 'one too many'))
      .toThrow('personal_dj_context_token_limit_reached');
  });
});

function createPayload(bundleId: string) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-08T10:00:00+08:00',
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

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}
