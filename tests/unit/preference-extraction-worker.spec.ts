import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { saveMessage } from '../../src/server/store/messages';
import {
  applyPreferenceExtractionOutput,
  enqueuePreferenceExtractionMessage,
  recordPreferenceExtractionFailure,
  runPreferenceExtractionBatch
} from '../../src/server/music-agent/preference-extraction';
import { listEffectivePreferenceEvidence } from '../../src/server/store/preference-evidence';
import {
  claimPreferenceExtractionBatch,
  createPreferenceExtractionBatch,
  completePreferenceExtractionBatch,
  getPreferenceExtractionBatch,
  listDuePreferenceExtractionBatches,
  markPreferenceExtractionBatchRetryable
} from '../../src/server/store/preference-extraction-batches';
import { createPreferenceExtractionWorker } from '../../src/server/jobs/preference-extraction-worker';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-preference-worker-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Preference Extraction worker', () => {
  it('consumes a pending chat batch and completes valid no-evidence output', async () => {
    const messageId = saveMessage('worker-user', 'user', '今天天气不错');
    const { batch } = enqueuePreferenceExtractionMessage({ userId: 'worker-user', messageId });
    const worker = createPreferenceExtractionWorker({
      processBatch: (record, signal) => runPreferenceExtractionBatch({
        batch: record,
        signal,
        attemptedAt: '2026-07-17T10:00:00.000Z',
        client: {
          async complete() {
            return { content: '{"result":"no_evidence"}' };
          }
        }
      }),
      now: () => new Date('2026-07-17T10:00:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(getPreferenceExtractionBatch('worker-user', batch.id)).toMatchObject({
      status: 'no_evidence',
      attemptCount: 1
    });
  });

  it('preempts an active batch without consuming an attempt', async () => {
    const messageId = saveMessage('worker-user', 'user', '我喜欢 Radiohead');
    const { batch } = enqueuePreferenceExtractionMessage({ userId: 'worker-user', messageId });
    let started!: () => void;
    const processStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = createPreferenceExtractionWorker({
      processBatch: vi.fn(async (_record, signal) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }),
      now: () => new Date('2026-07-17T10:00:00.000Z')
    });

    const running = worker.runOnce();
    await processStarted;
    worker.preempt();
    await expect(running).resolves.toBe('preempted');
    expect(getPreferenceExtractionBatch('worker-user', batch.id)).toMatchObject({
      status: 'pending', attemptCount: 0, errorCode: null
    });
  });

  it('times out a hung batch and schedules one retry', async () => {
    const messageId = saveMessage('worker-user', 'user', '我喜欢 Radiohead');
    const { batch } = enqueuePreferenceExtractionMessage({ userId: 'worker-user', messageId });
    const worker = createPreferenceExtractionWorker({
      processBatch: vi.fn(async () => new Promise<never>(() => undefined)),
      timeoutMs: 10,
      now: () => new Date('2026-07-17T10:00:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    expect(getPreferenceExtractionBatch('worker-user', batch.id)).toMatchObject({
      status: 'retryable', attemptCount: 1, errorCode: 'timeout',
      nextAttemptAt: '2026-07-17T10:01:00.000Z'
    });
  });

  it('keeps the worker timeout strictly inside its ownership lease', async () => {
    const messageId = saveMessage('worker-user', 'user', '我喜欢 Radiohead');
    enqueuePreferenceExtractionMessage({ userId: 'worker-user', messageId });
    let observedLeaseMs = 0;
    const claimedAt = new Date('2026-07-17T10:00:00.000Z');
    const worker = createPreferenceExtractionWorker({
      timeoutMs: 10,
      now: () => claimedAt,
      processBatch: vi.fn(async (claimed) => {
        observedLeaseMs = Date.parse(claimed.leaseUntil!) - claimedAt.getTime();
        return { status: 'no_evidence', evidenceIds: [] };
      })
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(observedLeaseMs).toBeGreaterThan(10);
  });

  it('rejects evidence from a process that returns after its timeout lease was revoked', async () => {
    const messageId = saveMessage('worker-user', 'user', '我喜欢 Radiohead');
    const { batch } = enqueuePreferenceExtractionMessage({ userId: 'worker-user', messageId });
    let started!: () => void;
    let release!: () => void;
    const processStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseProcess = new Promise<void>((resolve) => { release = resolve; });
    let lateResult!: Promise<ReturnType<typeof applyPreferenceExtractionOutput>>;
    const worker = createPreferenceExtractionWorker({
      processBatch: (claimed) => {
        started();
        lateResult = releaseProcess.then(() => applyPreferenceExtractionOutput({
          userId: claimed.userId,
          batchId: claimed.id,
          leaseToken: claimed.leaseToken!,
          output: {
            result: 'evidence',
            evidence: [{
              evidenceKind: 'expressed',
              subject: { type: 'artist', key: 'Radiohead' },
              polarity: 'positive', strength: 'strong', confidence: 1,
              sourceRefs: [{ messageId }],
              observedAt: '2026-07-17T10:00:00.000Z'
            }]
          }
        }));
        return lateResult;
      },
      timeoutMs: 10,
      now: () => new Date('2026-07-17T10:00:00.000Z')
    });

    const running = worker.runOnce();
    await processStarted;
    await expect(running).resolves.toBe('retry');
    expect(getPreferenceExtractionBatch('worker-user', batch.id)).toMatchObject({
      status: 'retryable', attemptCount: 1, errorCode: 'timeout'
    });

    release();
    await expect(lateResult).resolves.toEqual({ status: 'stale_attempt', evidenceIds: [] });
    expect(listEffectivePreferenceEvidence('worker-user')).toEqual([]);
    expect(getPreferenceExtractionBatch('worker-user', batch.id)).toMatchObject({
      status: 'retryable', attemptCount: 1, errorCode: 'timeout'
    });
  });

  it('orders an older due retry ahead of fresh pending work without letting legacy backlog dominate', () => {
    const retry = createPreferenceExtractionBatch({
      userId: 'worker-user', sourceKey: 'message:201', messageIds: [201],
      extractorVersion: 'v1', createdAt: '2026-07-17T09:00:00.000Z'
    }).batch;
    const retryAttempt = claimPreferenceExtractionBatch({
      userId: retry.userId,
      id: retry.id,
      now: new Date('2026-07-17T09:01:00.000Z'),
      leaseMs: 60_000
    })!;
    markPreferenceExtractionBatchRetryable({
      userId: retry.userId, id: retry.id, leaseToken: retryAttempt.leaseToken!, errorCode: 'timeout',
      attemptedAt: '2026-07-17T09:01:00.000Z', nextAttemptAt: '2026-07-17T09:02:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'worker-user', sourceKey: 'message:202', messageIds: [202],
      extractorVersion: 'v1', createdAt: '2026-07-17T09:30:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'worker-user', sourceKey: 'legacy-chat-preference:1', messageIds: [203],
      extractorVersion: 'v1', createdAt: '2026-07-01T09:00:00.000Z'
    });

    expect(listDuePreferenceExtractionBatches({
      now: new Date('2026-07-17T10:00:00.000Z'), limit: 3
    }).map((item) => item.sourceKey)).toEqual([
      'message:201', 'message:202', 'legacy-chat-preference:1'
    ]);
  });

  it('alternates current and legacy source classes when both remain due', async () => {
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'message:401', messageIds: [401], extractorVersion: 'v1',
      createdAt: '2026-07-17T09:00:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'message:402', messageIds: [402], extractorVersion: 'v1',
      createdAt: '2026-07-17T09:01:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'legacy-chat-preference:401', messageIds: [403], extractorVersion: 'v1',
      createdAt: '2026-07-01T09:00:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'legacy-chat-preference:402', messageIds: [404], extractorVersion: 'v1',
      createdAt: '2026-07-01T09:01:00.000Z'
    });
    const processed: string[] = [];
    const worker = createCompletingWorker(processed);

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(processed.map(sourceClass)).toEqual(['current', 'legacy', 'current', 'legacy']);
  });

  it('round-robins users within one source class instead of draining one user first', async () => {
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'message:501', messageIds: [501], extractorVersion: 'v1',
      createdAt: '2026-07-17T09:00:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'user-a', sourceKey: 'message:502', messageIds: [502], extractorVersion: 'v1',
      createdAt: '2026-07-17T09:01:00.000Z'
    });
    createPreferenceExtractionBatch({
      userId: 'user-b', sourceKey: 'message:503', messageIds: [503], extractorVersion: 'v1',
      createdAt: '2026-07-17T09:02:00.000Z'
    });
    const processed: string[] = [];
    const worker = createCompletingWorker(processed);

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(processed.map((item) => item.split('|')[0])).toEqual(['user-a', 'user-b', 'user-a']);
  });

  it('dead-letters a permanently failing batch after the bounded attempt budget', () => {
    const batch = createPreferenceExtractionBatch({
      userId: 'worker-user', sourceKey: 'message:301', messageIds: [301], extractorVersion: 'v1'
    }).batch;
    let attemptAt = new Date('2026-07-17T10:00:00.000Z');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claimed = claimPreferenceExtractionBatch({
        userId: batch.userId,
        id: batch.id,
        now: attemptAt,
        leaseMs: 60_000
      })!;
      recordPreferenceExtractionFailure({
        userId: batch.userId,
        batchId: batch.id,
        leaseToken: claimed.leaseToken!,
        errorCode: 'transport_error',
        attemptedAt: attemptAt.toISOString()
      });
      const updated = getPreferenceExtractionBatch(batch.userId, batch.id)!;
      if (updated.nextAttemptAt) attemptAt = new Date(updated.nextAttemptAt);
    }

    expect(getPreferenceExtractionBatch(batch.userId, batch.id)).toMatchObject({
      status: 'dead', attemptCount: 8, errorCode: 'transport_error', nextAttemptAt: null
    });
    expect(listDuePreferenceExtractionBatches({
      now: new Date('2026-07-18T10:00:00.000Z')
    }).some((item) => item.id === batch.id)).toBe(false);
  });
});

function createCompletingWorker(processed: string[]) {
  return createPreferenceExtractionWorker({
    now: () => new Date('2026-07-17T10:00:00.000Z'),
    async processBatch(batch) {
      processed.push(`${batch.userId}|${batch.sourceKey}`);
      completePreferenceExtractionBatch({
        userId: batch.userId,
        id: batch.id,
        leaseToken: batch.leaseToken!,
        outcome: 'no_evidence',
        completedAt: '2026-07-17T10:00:00.000Z'
      });
      return { status: 'no_evidence', evidenceIds: [] };
    }
  });
}

function sourceClass(value: string): 'current' | 'legacy' {
  return value.split('|')[1].startsWith('legacy-chat-preference:') ? 'legacy' : 'current';
}
