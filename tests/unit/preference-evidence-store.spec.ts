import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import {
  getEffectivePreferenceSignals,
  getPreferenceEvidenceById,
  listEffectivePreferenceEvidence,
  savePreferenceEvidence
} from '../../src/server/store/preference-evidence';
import { loadEffectivePreferences } from '../../src/server/dj-memory/snapshot';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-preference-evidence-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Preference Evidence store', () => {
  it('stores source-attributed Expressed Preference without a hard expiry', () => {
    const saved = savePreferenceEvidence({
      userId: 'user-1',
      evidenceKind: 'expressed',
      subjectType: 'artist',
      subjectKey: '周杰伦',
      polarity: 'negative',
      strength: 'medium',
      confidence: 0.92,
      sourceKind: 'chat_extraction',
      sourceRefs: [{ messageId: 42 }],
      observedAt: '2026-07-17T10:00:00.000Z',
      extractorVersion: 'preference-v2'
    });

    expect(saved).toMatchObject({
      userId: 'user-1',
      subjectType: 'artist',
      subjectKey: '周杰伦',
      polarity: 'negative',
      confidence: 0.92,
      sourceRefs: [{ messageId: 42 }],
      expiresAt: null,
      supersededById: null
    });
    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-08-17T10:00:00.000Z')
    })).toEqual([saved]);
  });

  it('supersedes contrary evidence for the same subject', () => {
    const first = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: '周杰伦', polarity: 'negative', strength: 'medium', confidence: 0.9,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 1 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'preference-v2'
    });
    const contrary = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: '周杰伦', polarity: 'positive', strength: 'strong', confidence: 0.98,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 2 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'preference-v2'
    });

    expect(getPreferenceEvidenceById('user-1', first.id)?.supersededById).toBe(contrary.id);
    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-07-17T12:00:00.000Z')
    }).map((item) => item.id)).toEqual([contrary.id]);
  });

  it('keeps the newest contrary expressed preference active when batches finish out of order', () => {
    const newer = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 2 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'preference-v2'
    });
    const older = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 1 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'preference-v2'
    });

    expect(getPreferenceEvidenceById('user-1', older.id)?.supersededById).toBe(newer.id);
    expect(getPreferenceEvidenceById('user-1', newer.id)?.supersededById).toBeNull();
    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-07-17T12:00:00.000Z')
    }).map((item) => item.id)).toEqual([newer.id]);
  });

  it('uses chat message order when equal-second evidence batches finish out of order', () => {
    const newer = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 102 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'preference-v2'
    });
    const older = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 101 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'preference-v2'
    });

    expect(getPreferenceEvidenceById('user-1', older.id)?.supersededById).toBe(newer.id);
    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-07-17T12:00:00.000Z')
    }).map((item) => item.id)).toEqual([newer.id]);
  });

  it('canonicalizes Unicode-equivalent subjects before contrary supersession', () => {
    const older = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'ＡＢＢＡ', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 1 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'preference-v2'
    });
    const newer = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'ABBA', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 2 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'preference-v2'
    });

    expect(getPreferenceEvidenceById('user-1', older.id)?.supersededById).toBe(newer.id);
    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-07-17T12:00:00.000Z')
    })).toEqual([expect.objectContaining({ id: newer.id, subjectKey: 'abba', polarity: 'positive' })]);
  });

  it('decays Inferred Preference with a 21-day half-life', () => {
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'inferred', subjectType: 'artist',
      subjectKey: '周杰伦', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'early_skip', sourceRefs: [{ episodeId: 'episode-1' }],
      observedAt: '2026-06-26T10:00:00.000Z'
    });

    expect(getEffectivePreferenceSignals('user-1', {
      now: new Date('2026-07-17T10:00:00.000Z')
    })).toEqual([expect.objectContaining({
      subjectType: 'artist',
      subjectKey: '周杰伦',
      polarity: 'negative',
      score: 0.5,
      evidenceCount: 1
    })]);
  });

  it('expires Inferred Preference after 60 days', () => {
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'inferred', subjectType: 'track',
      subjectKey: 'track-1', polarity: 'negative', strength: 'medium', confidence: 0.8,
      sourceKind: 'early_skip', sourceRefs: [{ episodeId: 'episode-1' }],
      observedAt: '2026-05-18T10:00:00.000Z'
    });

    expect(listEffectivePreferenceEvidence('user-1', {
      now: new Date('2026-07-17T10:00:00.000Z')
    })).toEqual([]);
  });

  it('strengthens same-direction evidence only up to a bounded maximum', () => {
    for (const [index, episodeId] of ['episode-1', 'episode-2'].entries()) {
      savePreferenceEvidence({
        userId: 'user-1', evidenceKind: 'inferred', subjectType: 'artist',
        subjectKey: '周杰伦', polarity: 'negative', strength: 'strong', confidence: 0.9,
        sourceKind: 'early_skip', sourceRefs: [{ episodeId }],
        observedAt: `2026-07-17T10:00:0${index}.000Z`
      });
    }

    expect(getEffectivePreferenceSignals('user-1', {
      now: new Date('2026-07-17T10:00:02.000Z')
    })[0]).toMatchObject({ score: 1, evidenceCount: 2 });
  });

  it('keeps expressed and inferred signals separate for the same subject and polarity', () => {
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: '宇多田光', polarity: 'positive', strength: 'weak', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 42 }],
      observedAt: '2026-07-17T09:00:00.000Z'
    });
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'inferred', subjectType: 'artist',
      subjectKey: '宇多田光', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'listening_pattern', sourceRefs: [{ episodeId: 'episode-42' }],
      observedAt: '2026-07-17T09:00:00.000Z'
    });

    expect(getEffectivePreferenceSignals('user-1', {
      now: new Date('2026-07-17T09:00:00.000Z')
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceKind: 'expressed', score: 0.35 }),
      expect.objectContaining({ evidenceKind: 'inferred', score: 1 })
    ]));
  });

  it('does not duplicate the same source evidence on retry', () => {
    const input = {
      userId: 'user-1', evidenceKind: 'expressed' as const, subjectType: 'artist',
      subjectKey: '周杰伦', polarity: 'negative' as const, strength: 'medium' as const,
      confidence: 0.9, sourceKind: 'listener_instruction',
      sourceRefs: [{ messageId: 42 }], observedAt: '2026-07-17T10:00:00.000Z',
      extractorVersion: 'selection-intent-v1'
    };
    const first = savePreferenceEvidence(input);
    const retry = savePreferenceEvidence(input);

    expect(retry.id).toBe(first.id);
    expect(listEffectivePreferenceEvidence('user-1')).toHaveLength(1);
  });

  it('deduplicates the same message preference across sync intent and async extraction', () => {
    const synchronous = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 77 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'selection-intent-v1'
    });
    const asynchronous = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'radiohead', polarity: 'negative', strength: 'medium', confidence: 0.9,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 77 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'preference-extractor-v1'
    });

    expect(asynchronous.id).toBe(synchronous.id);
    expect(listEffectivePreferenceEvidence('user-1')).toHaveLength(1);
  });

  it('deduplicates a delayed async retry even after the original semantic evidence was superseded', () => {
    const synchronous = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 77 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'selection-intent-v1'
    });
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 88 }],
      observedAt: '2026-07-17T11:00:00.000Z', extractorVersion: 'selection-intent-v1'
    });
    const delayed = savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'Radiohead', polarity: 'negative', strength: 'medium', confidence: 0.9,
      sourceKind: 'chat_extraction', sourceRefs: [{ messageId: 77 }],
      observedAt: '2026-07-17T10:00:00.000Z', extractorVersion: 'preference-extractor-v1'
    });

    expect(delayed.id).toBe(synchronous.id);
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM preference_evidence WHERE user_id = ?'
    ).get('user-1')).toEqual({ count: 2 });
  });

  it('bounds the production snapshot projection to its 100 preference contract', () => {
    for (let index = 0; index < 101; index += 1) {
      savePreferenceEvidence({
        userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
        subjectKey: `artist-${index}`, polarity: 'positive', strength: 'strong', confidence: 1,
        sourceKind: 'listener_instruction', sourceRefs: [{ messageId: index + 1 }],
        observedAt: '2026-07-17T10:00:00.000Z'
      });
    }

    expect(loadEffectivePreferences('user-1', new Date('2026-07-17T10:00:01.000Z'))).toHaveLength(100);
  });

  it('keeps expressed preferences ahead of stronger inferred signals at the snapshot boundary', () => {
    for (let index = 0; index < 100; index += 1) {
      savePreferenceEvidence({
        userId: 'user-1', evidenceKind: 'inferred', subjectType: 'artist',
        subjectKey: `inferred-${index}`, polarity: 'positive', strength: 'strong', confidence: 1,
        sourceKind: 'listening_pattern', sourceRefs: [{ episodeId: `episode-${index}` }],
        observedAt: '2026-07-17T10:00:00.000Z'
      });
    }
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'quiet-explicit', polarity: 'positive', strength: 'weak', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 999 }],
      observedAt: '2026-07-16T10:00:00.000Z'
    });

    const projected = loadEffectivePreferences('user-1', new Date('2026-07-17T10:00:01.000Z'));
    expect(projected).toHaveLength(100);
    expect(projected.some((item) => item.subjectKey === 'quiet-explicit')).toBe(true);
  });

  it('aggregates before bounding so crowded recent evidence cannot hide another subject', () => {
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'artist',
      subjectKey: 'old-distinct', polarity: 'positive', strength: 'strong', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ messageId: 1 }],
      observedAt: '2026-07-16T10:00:00.000Z'
    });
    for (let index = 0; index < 500; index += 1) {
      savePreferenceEvidence({
        userId: 'user-1', evidenceKind: 'inferred', subjectType: 'artist',
        subjectKey: 'crowding-subject', polarity: 'positive', strength: 'weak', confidence: 0.5,
        sourceKind: 'listening_pattern', sourceRefs: [{ episodeId: `episode-${index}` }],
        observedAt: '2026-07-17T10:00:00.000Z'
      });
    }

    expect(getEffectivePreferenceSignals('user-1', {
      now: new Date('2026-07-17T10:00:01.000Z')
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectKey: 'crowding-subject', evidenceCount: 500 }),
      expect.objectContaining({ subjectKey: 'old-distinct', evidenceCount: 1 })
    ]));
  });
});
