import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySelectionIntent,
  parseSelectionIntent
} from '../../src/server/music-agent/selection-intent';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import {
  createExplicitExclusion,
  findMatchingExplicitExclusion,
  listActiveExplicitExclusions
} from '../../src/server/store/explicit-exclusions';
import { listEffectivePreferenceEvidence } from '../../src/server/store/preference-evidence';
import {
  beginExplicitExclusionResolutionAttempt,
  completeExplicitExclusionResolution,
  createPendingExplicitTrackExclusion,
  getExplicitExclusionResolutionByExclusionId
} from '../../src/server/store/explicit-exclusion-resolutions';

describe('selection intent parsing', () => {
  it('keeps “不喜欢周杰伦” as soft Expressed Preference Evidence', () => {
    expect(parseSelectionIntent('我不喜欢周杰伦')).toEqual({
      type: 'preference_evidence',
      evidenceKind: 'expressed',
      subject: {
        type: 'artist',
        key: '周杰伦',
        label: '周杰伦'
      },
      polarity: 'negative',
      strength: 'medium',
      revokeMatchingExclusion: false
    });
  });

  it('treats “不要再放周杰伦” as an Explicit Exclusion', () => {
    expect(parseSelectionIntent('不要再放周杰伦')).toEqual({
      type: 'explicit_exclusion',
      subject: {
        type: 'artist',
        key: '周杰伦',
        label: '周杰伦'
      },
      revokeMatchingExclusion: false
    });
  });

  it('treats “还是放周杰伦吧” as an exact request that revokes its exclusion', () => {
    expect(parseSelectionIntent('还是放周杰伦吧')).toEqual({
      type: 'explicit_request',
      subject: {
        type: 'artist',
        key: '周杰伦',
        label: '周杰伦'
      },
      revokeMatchingExclusion: true
    });
  });

  it('parses a quoted track with an artist qualifier as one exact track subject', () => {
    expect(parseSelectionIntent('不要再放《Hello》 - Adele')).toEqual({
      type: 'explicit_exclusion',
      subject: {
        type: 'track',
        key: 'hello::adele',
        label: 'Hello',
        artist: 'Adele'
      },
      revokeMatchingExclusion: false
    });
  });

  it.each([
    ['放Hello — Adele', 'Hello', 'Adele', 'hello::adele'],
    ['放晴天—周杰伦', '晴天', '周杰伦', '晴天::周杰伦'],
    ['放晴天–周杰伦', '晴天', '周杰伦', '晴天::周杰伦']
  ])('parses an unquoted title and artist separated by a Unicode dash: %s', (
    input,
    label,
    artist,
    key
  ) => {
    expect(parseSelectionIntent(input)).toEqual({
      type: 'explicit_request',
      subject: {
        type: 'track',
        key,
        label,
        artist
      },
      revokeMatchingExclusion: true
    });
  });

  it('does not revoke an entity exclusion for a generalized request', () => {
    expect(parseSelectionIntent('还是放点华语歌吧')).toEqual({
      type: 'active_directive',
      text: '还是放点华语歌吧',
      revokeMatchingExclusion: false
    });
  });

  it('routes time-bounded wording to an Active Directive', () => {
    expect(parseSelectionIntent('今天不想听摇滚')).toEqual({
      type: 'active_directive',
      text: '今天不想听摇滚',
      revokeMatchingExclusion: false
    });
  });

  it('distinguishes a generalized style directive from a concrete artist request', () => {
    expect(parseSelectionIntent('来点爵士')).toEqual({
      type: 'active_directive',
      text: '来点爵士',
      revokeMatchingExclusion: false
    });
    expect(parseSelectionIntent('放周杰伦')).toEqual({
      type: 'explicit_request',
      subject: {
        type: 'artist', key: '周杰伦', label: '周杰伦'
      },
      revokeMatchingExclusion: true
    });
  });
});

describe('selection intent application', () => {
  const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-selection-intent-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    initDb();
  });

  afterEach(() => {
    _resetDbForTest();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  });

  it('revokes the exact exclusion before returning the Explicit Music Request', async () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: '周杰伦',
      sourceKind: 'listener_instruction', sourceRef: { messageId: 9 }
    });

    const result = await applySelectionIntent({
      userId: 'user-1',
      text: '还是放周杰伦吧',
      sourceRef: { messageId: 10 },
      occurredAt: '2026-07-17T10:00:00.000Z'
    });

    expect(result.intent.type).toBe('explicit_request');
    expect(result.revokedExclusionIds).toHaveLength(1);
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('does not revoke a named exclusion when the new request is generalized', async () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: '周杰伦',
      sourceKind: 'listener_instruction', sourceRef: { messageId: 9 }
    });

    const result = await applySelectionIntent({
      userId: 'user-1', text: '还是放点华语歌吧', sourceRef: { messageId: 10 }
    });

    expect(result.intent.type).toBe('active_directive');
    expect(result.revokedExclusionIds).toEqual([]);
    expect(listActiveExplicitExclusions('user-1')).toHaveLength(1);
  });

  it('persists dislike wording as soft evidence without creating an exclusion', async () => {
    const result = await applySelectionIntent({
      userId: 'user-1', text: '我不喜欢周杰伦', sourceRef: { messageId: 11 },
      occurredAt: '2026-07-17T10:00:00.000Z'
    });

    expect(result.preferenceEvidenceId).toEqual(expect.any(String));
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([
      expect.objectContaining({
        evidenceKind: 'expressed',
        polarity: 'negative',
        subjectKey: '周杰伦'
      })
    ]);
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('uses one resolved track identity for ban and exact reversal', async () => {
    const ncmClient = {
      searchSongs: async () => [{ id: '123', name: 'Creep', artists: ['Radiohead'] }]
    } as never;

    const banned = await applySelectionIntent({
      userId: 'user-1', text: '不要再放《Creep》', sourceRef: { messageId: 12 },
      occurredAt: '2026-07-17T10:00:00.000Z', ncmClient
    });
    expect(banned.createdExclusionId).toEqual(expect.any(String));
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ entityKey: 'ncm:123', provider: 'ncm', providerId: '123' })
    ]);

    const reversed = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Creep》', sourceRef: { messageId: 13 },
      occurredAt: '2026-07-17T11:00:00.000Z', ncmClient
    });
    expect(reversed.revokedExclusionIds).toEqual([banned.createdExclusionId]);
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('revokes only the resolved track when multiple exclusions share a title alias', async () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'ncm:123',
      provider: 'ncm', providerId: '123', displayName: 'Hello',
      aliases: ['hello', 'hello::adele'], sourceKind: 'listener_instruction',
      sourceRef: { messageId: 30 }
    });
    createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'ncm:456',
      provider: 'ncm', providerId: '456', displayName: 'Hello',
      aliases: ['hello', 'hello::lionelrichie'], sourceKind: 'listener_instruction',
      sourceRef: { messageId: 31 }
    });

    const result = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Hello》', sourceRef: { messageId: 32 },
      ncmClient: {
        searchSongs: async () => [{ id: '123', name: 'Hello', artists: ['Adele'] }]
      } as never
    });

    expect(result.revokedExclusionIds).toHaveLength(1);
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ entityKey: 'ncm:456', providerId: '456' })
    ]);
  });

  it('atomically cancels a compatible pending exclusion when an exact reversal resolves the track', async () => {
    const resolved = createExplicitExclusion({
      userId: 'user-1', entityType: 'track', entityKey: 'ncm:123',
      provider: 'ncm', providerId: '123', displayName: 'Hello',
      aliases: ['hello', 'hello::adele'], sourceKind: 'listener_instruction',
      sourceRef: { messageId: 40 }
    }).exclusion;
    const pending = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:hello', displayName: 'Hello',
      aliases: ['hello'], sourceKind: 'listener_instruction', sourceRef: { messageId: 41 },
      queryTitle: 'Hello', queryArtist: 'Adele', createdAt: '2026-07-17T10:00:00.000Z'
    }).exclusion;
    const attempt = beginExplicitExclusionResolutionAttempt({
      id: getExplicitExclusionResolutionByExclusionId(pending.id)!.id,
      now: new Date('2026-07-17T10:30:00.000Z')
    })!;

    const reversed = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Hello》', sourceRef: { messageId: 42 },
      occurredAt: '2026-07-17T11:00:00.000Z',
      ncmClient: {
        searchSongs: async () => [{ id: '123', name: 'Hello', artists: ['Adele'] }]
      } as never
    });

    expect(reversed.revokedExclusionIds).toEqual(expect.arrayContaining([resolved.id, pending.id]));
    expect(reversed.revokedExclusionIds).toHaveLength(2);
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
    const cancelledJob = getExplicitExclusionResolutionByExclusionId(pending.id)!;
    expect(cancelledJob).toMatchObject({ status: 'dead', lastErrorCode: 'exclusion_revoked' });

    completeExplicitExclusionResolution({
      id: cancelledJob.id,
      leaseToken: attempt.leaseToken!,
      track: { ncmId: '123', name: 'Hello', artists: ['Adele'] },
      now: new Date('2026-07-17T11:01:00.000Z')
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('persists an explicit unresolved outcome without globally blocking a same-title track', async () => {
    const unavailableClient = { searchSongs: async () => [] } as never;
    const result = await applySelectionIntent({
      userId: 'user-1', text: '不要再放《Hello》', sourceRef: { messageId: 20 },
      occurredAt: '2026-07-17T10:00:00.000Z', ncmClient: unavailableClient
    });

    expect(result).toMatchObject({
      trackResolution: 'pending_resolution', createdExclusionId: expect.any(String)
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ entityKey: 'unresolved:hello', aliases: expect.arrayContaining(['hello']) })
    ]);
    expect(getExplicitExclusionResolutionByExclusionId(result.createdExclusionId!)).toMatchObject({
      userId: 'user-1',
      queryTitle: 'Hello',
      status: 'pending',
      attemptCount: 0
    });
    expect(findMatchingExplicitExclusion('user-1', {
      id: 'other', name: 'Hello', artists: ['Lionel Richie']
    })).toBeNull();
  });

  it('carries a title plus artist through resolution, pending storage, and exact reversal', async () => {
    const pendingResult = await applySelectionIntent({
      userId: 'user-1', text: '不要再放《Hello》 - Adele', sourceRef: { messageId: 50 },
      occurredAt: '2026-07-17T10:00:00.000Z',
      ncmClient: {
        searchSongs: async (query: string) => query === 'Hello Adele'
          ? [
              { id: 'adele-1', name: 'Hello', artists: ['Adele'] },
              { id: 'adele-2', name: 'Hello', artists: ['Adele'] }
            ]
          : []
      } as never
    });

    expect(pendingResult).toMatchObject({
      trackResolution: 'pending_resolution', createdExclusionId: expect.any(String)
    });
    expect(getExplicitExclusionResolutionByExclusionId(pendingResult.createdExclusionId!)).toMatchObject({
      queryTitle: 'Hello', queryArtist: 'Adele', status: 'pending'
    });

    const reversed = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Hello》 - Adele', sourceRef: { messageId: 51 },
      occurredAt: '2026-07-17T11:00:00.000Z',
      ncmClient: {
        searchSongs: async (query: string) => query === 'Hello Adele'
          ? [{ id: 'adele-1', name: 'Hello', artists: ['Adele'] }]
          : []
      } as never
    });

    expect(reversed.revokedExclusionIds).toEqual([pendingResult.createdExclusionId]);
    expect(getExplicitExclusionResolutionByExclusionId(pendingResult.createdExclusionId!)).toMatchObject({
      status: 'dead', lastErrorCode: 'exclusion_revoked'
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });

  it('does not revoke artist-qualified pending exclusions from an unresolved title-only request', async () => {
    const adele = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:hello::adele', displayName: 'Hello',
      aliases: ['hello::adele'], sourceKind: 'listener_instruction', sourceRef: { messageId: 60 },
      queryTitle: 'Hello', queryArtist: 'Adele', createdAt: '2026-07-17T10:00:00.000Z'
    }).exclusion;
    const lionel = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:hello::lionelrichie', displayName: 'Hello',
      aliases: ['hello::lionelrichie'], sourceKind: 'listener_instruction', sourceRef: { messageId: 61 },
      queryTitle: 'Hello', queryArtist: 'Lionel Richie', createdAt: '2026-07-17T10:01:00.000Z'
    }).exclusion;

    const reversed = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Hello》', sourceRef: { messageId: 62 },
      ncmClient: { searchSongs: async () => [] } as never
    });

    expect(reversed.revokedExclusionIds).toEqual([]);
    expect(listActiveExplicitExclusions('user-1').map((item) => item.id)).toEqual(
      expect.arrayContaining([adele.id, lionel.id])
    );
  });

  it('revokes a canonical ban by its persisted title alias when the resolver is unavailable', async () => {
    const availableClient = {
      searchSongs: async () => [{ id: '456', name: 'Hello', artists: ['Adele'] }]
    } as never;
    const banned = await applySelectionIntent({
      userId: 'user-1', text: '不要再放《Hello》', sourceRef: { messageId: 21 },
      ncmClient: availableClient
    });

    const reversed = await applySelectionIntent({
      userId: 'user-1', text: '还是放《Hello》', sourceRef: { messageId: 22 },
      ncmClient: { searchSongs: async () => [] } as never
    });

    expect(reversed.revokedExclusionIds).toEqual([banned.createdExclusionId]);
    expect(listActiveExplicitExclusions('user-1')).toEqual([]);
  });
});
