import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import {
  claimPreferenceExtractionBatch,
  createPreferenceExtractionBatch,
  deadLetterPreferenceExtractionBatch,
  getPreferenceExtractionBatch,
  markPreferenceExtractionBatchRetryable,
  releasePreferenceExtractionBatch
} from '../../src/server/store/preference-extraction-batches';
import { listEffectivePreferenceEvidence } from '../../src/server/store/preference-evidence';
import {
  applyPreferenceExtractionOutput,
  enqueuePreferenceExtractionMessage,
  recordPreferenceExtractionFailure,
  runPreferenceExtractionBatch
} from '../../src/server/music-agent/preference-extraction';
import { getUnextractedMessages, saveMessage } from '../../src/server/store/messages';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-preference-extraction-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('structured preference extraction', () => {
  it('runs a persisted chat batch through the extractor and marks only terminal messages complete', async () => {
    const messageId = saveMessage('user-1', 'user', '我最近越来越喜欢 Radiohead');
    const { batch } = enqueuePreferenceExtractionMessage({ userId: 'user-1', messageId });
    const attempt = claimForTest(batch);

    const result = await runPreferenceExtractionBatch({
      batch: attempt,
      client: {
        async complete() {
          return {
            model: 'test-model',
            content: JSON.stringify({
              result: 'evidence',
              evidence: [{
                evidenceKind: 'expressed',
                subject: { type: 'artist', key: 'Radiohead', label: 'Radiohead' },
                polarity: 'positive',
                strength: 'medium',
                confidence: 0.96,
                sourceRefs: [{ messageId }],
                observedAt: '2026-07-17T10:00:00.000Z'
              }]
            })
          };
        }
      },
      attemptedAt: '2026-07-17T10:00:02.000Z'
    });

    expect(result).toMatchObject({ status: 'succeeded', evidenceIds: [expect.any(String)] });
    expect(getUnextractedMessages('user-1')).toEqual([]);
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([
      expect.objectContaining({
        subjectType: 'artist',
        subjectKey: 'radiohead',
        polarity: 'positive',
        sourceRefs: [{ messageId }]
      })
    ]);
  });

  it('idempotently opens one pending batch per source and extractor version', () => {
    const input = {
      userId: 'user-1',
      sourceKey: 'messages:11-12',
      messageIds: [12, 11, 12],
      extractorVersion: 'preference-v2',
      createdAt: '2026-07-17T10:00:00.000Z'
    };
    const first = createPreferenceExtractionBatch(input);
    const retry = createPreferenceExtractionBatch(input);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.batch.id).toBe(first.batch.id);
    expect(getPreferenceExtractionBatch('user-1', first.batch.id)).toMatchObject({
      messageIds: [11, 12],
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: null,
      completedAt: null
    });
  });

  it('completes only a schema-valid, source-attributed evidence result', () => {
    saveMessageWithId(11, '2026-07-17T09:58:00.000Z');
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:11', messageIds: [11],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    const applied = applyPreferenceExtractionOutput({
      userId: 'user-1',
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: '周杰伦', label: '周杰伦' },
          polarity: 'negative',
          strength: 'medium',
          confidence: 0.94,
          sourceRefs: [{ messageId: 11 }],
          observedAt: '2026-07-17T09:59:00.000Z'
        }]
      },
      completedAt: '2026-07-17T10:00:02.000Z'
    });

    expect(applied).toMatchObject({ status: 'succeeded', evidenceIds: [expect.any(String)] });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
      errorCode: null,
      completedAt: '2026-07-17T10:00:02.000Z'
    });
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([
      expect.objectContaining({
        subjectKey: '周杰伦',
        confidence: 0.94,
        sourceRefs: [{ messageId: 11 }],
        extractorVersion: 'preference-v2',
        observedAt: '2026-07-17T09:58:00.000Z',
        expiresAt: null
      })
    ]);
  });

  it('rejects an expired lease even when no other worker has reclaimed it', () => {
    saveMessageWithId(13, '2026-07-17T09:58:00.000Z');
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:13', messageIds: [13],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: new Date('2026-07-17T10:00:01.000Z'),
      leaseMs: 1_000
    })!;

    expect(applyPreferenceExtractionOutput({
      userId: batch.userId,
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      completedAt: '2026-07-17T10:00:02.001Z',
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: 'Radiohead' },
          polarity: 'positive', strength: 'strong', confidence: 1,
          sourceRefs: [{ messageId: 13 }],
          observedAt: '2026-07-17T09:58:00.000Z'
        }]
      }
    })).toEqual({ status: 'stale_attempt', evidenceIds: [] });
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([]);
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'processing', leaseToken: attempt.leaseToken
    });
  });

  it('rolls back evidence when the completion CAS loses ownership', () => {
    saveMessageWithId(14, '2026-07-17T09:58:00.000Z');
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:14', messageIds: [14],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);
    getDb().exec(`
      CREATE TRIGGER inject_preference_completion_cas_loss
      BEFORE UPDATE OF status ON preference_extraction_batches
      WHEN NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    expect(applyPreferenceExtractionOutput({
      userId: batch.userId,
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      completedAt: '2026-07-17T10:00:02.000Z',
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: 'Radiohead' },
          polarity: 'positive', strength: 'strong', confidence: 1,
          sourceRefs: [{ messageId: 14 }],
          observedAt: '2026-07-17T09:58:00.000Z'
        }]
      }
    })).toEqual({ status: 'stale_attempt', evidenceIds: [] });
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([]);
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'processing', leaseToken: attempt.leaseToken
    });
  });

  it('derives evidence time and expiry from source messages instead of model fields', () => {
    saveMessageWithId(12, '2026-07-17T08:00:00.000Z');
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:12', messageIds: [12],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    expect(applyPreferenceExtractionOutput({
      userId: 'user-1',
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      completedAt: '2026-07-17T10:00:02.000Z',
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: 'Radiohead' },
          polarity: 'positive', strength: 'strong', confidence: 1,
          sourceRefs: [{ messageId: 12 }],
          observedAt: '2099-01-01T00:00:00.000Z',
          expiresAt: '2026-07-17T08:00:01.000Z'
        }]
      }
    })).toMatchObject({ status: 'succeeded' });

    expect(listEffectivePreferenceEvidence('user-1')).toEqual([
      expect.objectContaining({
        observedAt: '2026-07-17T08:00:00.000Z',
        expiresAt: null
      })
    ]);
  });

  it('keeps malformed output retryable instead of completing the source messages', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:21', messageIds: [21],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    expect(applyPreferenceExtractionOutput({
      userId: 'user-1',
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      output: '{not json',
      attemptedAt: '2026-07-17T10:00:02.000Z'
    })).toEqual({
      status: 'retryable',
      evidenceIds: [],
      errorCode: 'malformed_output'
    });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'retryable',
      attemptCount: 1,
      nextAttemptAt: '2026-07-17T10:01:02.000Z',
      errorCode: 'malformed_output',
      completedAt: null
    });
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([]);
  });

  it('keeps a transport timeout retryable with its extractor version intact', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:31', messageIds: [31],
      extractorVersion: 'preference-v3', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    expect(recordPreferenceExtractionFailure({
      userId: 'user-1',
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      errorCode: 'timeout',
      attemptedAt: '2026-07-17T10:00:05.000Z'
    })).toEqual({
      status: 'retryable',
      evidenceIds: [],
      errorCode: 'timeout'
    });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      extractorVersion: 'preference-v3',
      status: 'retryable',
      attemptCount: 1,
      nextAttemptAt: '2026-07-17T10:01:05.000Z',
      completedAt: null
    });
  });

  it('rejects an expired transport failure owner before it can schedule a retry', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:expired-transport', messageIds: [32],
      extractorVersion: 'preference-v3', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: new Date('2026-07-17T10:00:01.000Z'),
      leaseMs: 1_000
    })!;

    expect(recordPreferenceExtractionFailure({
      userId: batch.userId,
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      errorCode: 'transport_error',
      attemptedAt: '2026-07-17T10:00:02.001Z'
    })).toEqual({ status: 'stale_attempt', evidenceIds: [] });
    expect(getPreferenceExtractionBatch(batch.userId, batch.id)).toMatchObject({
      status: 'processing',
      attemptCount: 1,
      leaseToken: attempt.leaseToken,
      errorCode: null
    });
  });

  it('rejects an expired retryable transition at the store CAS boundary', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:expired-retry', messageIds: [33],
      extractorVersion: 'preference-v3', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: new Date('2026-07-17T10:00:01.000Z'),
      leaseMs: 1_000
    })!;

    expect(markPreferenceExtractionBatchRetryable({
      userId: batch.userId,
      id: batch.id,
      leaseToken: attempt.leaseToken!,
      errorCode: 'transport_error',
      attemptedAt: '2026-07-17T10:00:02.001Z',
      nextAttemptAt: '2026-07-17T10:01:02.001Z'
    })).toBeNull();
    expect(getPreferenceExtractionBatch(batch.userId, batch.id)).toMatchObject({
      status: 'processing', leaseToken: attempt.leaseToken, errorCode: null
    });
  });

  it('rejects an expired dead-letter transition at the store CAS boundary', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:expired-dead', messageIds: [34],
      extractorVersion: 'preference-v3', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: new Date('2026-07-17T10:00:01.000Z'),
      leaseMs: 1_000
    })!;

    expect(deadLetterPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      leaseToken: attempt.leaseToken!,
      errorCode: 'transport_error',
      attemptedAt: '2026-07-17T10:00:02.001Z'
    })).toBeNull();
    expect(getPreferenceExtractionBatch(batch.userId, batch.id)).toMatchObject({
      status: 'processing', leaseToken: attempt.leaseToken, errorCode: null, completedAt: null
    });
  });

  it('does not let an expired owner release and refund its attempt', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:expired-release', messageIds: [35],
      extractorVersion: 'preference-v3', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimPreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      now: new Date('2026-07-17T10:00:01.000Z'),
      leaseMs: 1_000
    })!;

    expect(releasePreferenceExtractionBatch({
      userId: batch.userId,
      id: batch.id,
      leaseToken: attempt.leaseToken!,
      releasedAt: '2026-07-17T10:00:02.001Z'
    })).toBe(false);
    expect(getPreferenceExtractionBatch(batch.userId, batch.id)).toMatchObject({
      status: 'processing', attemptCount: 1, leaseToken: attempt.leaseToken
    });
  });

  it('rejects evidence that cites messages outside its extraction batch', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:41', messageIds: [41],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    expect(applyPreferenceExtractionOutput({
      userId: 'user-1',
      batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: '周杰伦' },
          polarity: 'positive', strength: 'strong', confidence: 0.9,
          sourceRefs: [{ messageId: 99 }],
          observedAt: '2026-07-17T10:00:00.000Z'
        }]
      },
      attemptedAt: '2026-07-17T10:00:03.000Z'
    })).toEqual({
      status: 'retryable', evidenceIds: [], errorCode: 'source_mismatch'
    });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'retryable',
      errorCode: 'source_mismatch',
      completedAt: null
    });
    expect(listEffectivePreferenceEvidence('user-1')).toEqual([]);
  });

  it('accepts an explicit no-evidence result as a completed extraction', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:51', messageIds: [51],
      extractorVersion: 'preference-v2', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = claimForTest(batch);

    expect(applyPreferenceExtractionOutput({
      userId: 'user-1', batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      output: { result: 'no_evidence' },
      completedAt: '2026-07-17T10:00:04.000Z'
    })).toEqual({ status: 'no_evidence', evidenceIds: [] });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'no_evidence',
      attemptCount: 1,
      completedAt: '2026-07-17T10:00:04.000Z'
    });
  });

  it('keeps schema-mismatched evidence retryable', () => {
    const { batch } = createPreferenceExtractionBatch({
      userId: 'user-1', sourceKey: 'messages:61', messageIds: [61],
      extractorVersion: 'preference-v2'
    });
    const attempt = claimForTest(batch);

    expect(applyPreferenceExtractionOutput({
      userId: 'user-1', batchId: batch.id,
      leaseToken: attempt.leaseToken!,
      output: {
        result: 'evidence',
        evidence: [{
          evidenceKind: 'expressed',
          subject: { type: 'artist', key: '周杰伦' },
          polarity: 'positive', strength: 'strong', confidence: 1.2,
          sourceRefs: [{ messageId: 61 }],
          observedAt: '2026-07-17T10:00:00.000Z'
        }]
      },
      attemptedAt: '2026-07-17T10:00:06.000Z'
    })).toEqual({
      status: 'retryable', evidenceIds: [], errorCode: 'schema_mismatch'
    });
    expect(getPreferenceExtractionBatch('user-1', batch.id)).toMatchObject({
      status: 'retryable', errorCode: 'schema_mismatch', completedAt: null
    });
  });
});

function saveMessageWithId(id: number, createdAt: string): void {
  const savedId = saveMessage('user-1', 'user', `message-${id}`);
  getDb().prepare('UPDATE messages SET id = ?, created_at = ? WHERE id = ?')
    .run(id, createdAt, savedId);
}

function claimForTest(batch: { userId: string; id: string }) {
  return claimPreferenceExtractionBatch({
    userId: batch.userId,
    id: batch.id,
    now: new Date('2026-07-17T10:00:01.000Z'),
    leaseMs: 60_000
  })!;
}
