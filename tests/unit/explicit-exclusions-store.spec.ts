import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import {
  createExplicitExclusion,
  findMatchingExplicitExclusion,
  listActiveExplicitExclusions,
  revokeExplicitExclusion
} from '../../src/server/store/explicit-exclusions';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-explicit-exclusions-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Explicit Exclusion store', () => {
  it('idempotently creates a durable artist exclusion with provenance', () => {
    const input = {
      userId: 'user-1',
      entityType: 'artist' as const,
      entityKey: ' 周杰伦 ',
      provider: 'ncm',
      providerId: '6452',
      displayName: '周杰伦',
      sourceKind: 'listener_instruction',
      sourceRef: { messageId: 9 },
      createdAt: '2026-07-17T10:00:00.000Z'
    };
    const first = createExplicitExclusion(input);
    const retry = createExplicitExclusion(input);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.exclusion.id).toBe(first.exclusion.id);
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({
        entityType: 'artist',
        entityKey: '周杰伦',
        providerId: '6452',
        sourceRef: { messageId: 9 },
        revokedAt: null
      })
    ]);
  });

  it('keeps an exclusion durable until an explicit matching revocation', () => {
    const created = createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: '周杰伦',
      displayName: '周杰伦', sourceKind: 'listener_instruction',
      sourceRef: { messageId: 9 }, createdAt: '2026-07-17T10:00:00.000Z'
    }).exclusion;

    const revoked = revokeExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: '周杰伦',
      sourceRef: { messageId: 10 }, revokedAt: '2026-07-17T11:00:00.000Z'
    });

    expect(revoked).toMatchObject({
      id: created.id,
      revokedAt: '2026-07-17T11:00:00.000Z',
      revocationSourceRef: { messageId: 10 }
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('isolates exclusions and revocations by user', () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: '周杰伦',
      sourceKind: 'listener_instruction', sourceRef: { messageId: 9 }
    });

    expect(revokeExplicitExclusion({
      userId: 'user-2', entityType: 'artist', entityKey: '周杰伦',
      sourceRef: { messageId: 10 }
    })).toBeNull();
    expect(listActiveExplicitExclusions('user-1')).toHaveLength(1);
    expect(listActiveExplicitExclusions('user-2')).toEqual([]);
  });

  it('matches tracks by provider identity or title plus primary artist without title-only overblocking', () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'ncm:1',
      provider: 'ncm', providerId: '1', displayName: 'Hello',
      sourceKind: 'agent_action', sourceRef: { messageId: 1 }
    });
    createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'creep___radiohead',
      displayName: 'Creep', sourceKind: 'legacy_pref_migration',
      sourceRef: { sourceId: 'legacy' }
    });
    createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'hello',
      displayName: 'Hello', sourceKind: 'legacy_pref_migration',
      sourceRef: { sourceId: 'ambiguous-legacy' }
    });
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: 'ＡＢＢＡ',
      displayName: 'ＡＢＢＡ', sourceKind: 'listener_instruction',
      sourceRef: { sourceId: 'fullwidth-artist' }
    });

    expect(findMatchingExplicitExclusion('user-1', {
      id: '1', name: 'Hello', artists: ['Adele']
    })?.providerId).toBe('1');
    expect(findMatchingExplicitExclusion('user-1', {
      id: '2', name: 'Hello', artists: ['Lionel Richie']
    })).toBeNull();
    expect(findMatchingExplicitExclusion('user-1', {
      id: '3', name: 'Creep', artists: ['Radiohead']
    })?.entityKey).toBe('creep___radiohead');
    expect(findMatchingExplicitExclusion('user-1', {
      id: '4', name: 'Creep', artists: ['Stone Temple Pilots']
    })).toBeNull();
    expect(findMatchingExplicitExclusion('user-1', {
      id: '5', name: 'Dancing Queen', artists: ['ABBA']
    })?.entityType).toBe('artist');
  });

  it('keeps old active exclusions authoritative beyond projection list limits', () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: 'Old Blocked Artist',
      sourceKind: 'listener_instruction', sourceRef: { sourceId: 'oldest' },
      createdAt: '2026-07-16T00:00:00.000Z'
    });
    for (let index = 0; index < 500; index += 1) {
      createExplicitExclusion({
        userId: 'user-1', entityType: 'artist', entityKey: `new-artist-${index}`,
        sourceKind: 'listener_instruction', sourceRef: { sourceId: `new-${index}` },
        createdAt: '2026-07-17T00:00:00.000Z'
      });
    }

    expect(listActiveExplicitExclusions('user-1')).toHaveLength(500);
    expect(findMatchingExplicitExclusion('user-1', {
      id: 'candidate', name: 'Candidate', artists: ['Old Blocked Artist']
    })?.entityKey).toBe('old blocked artist');
  });
});
