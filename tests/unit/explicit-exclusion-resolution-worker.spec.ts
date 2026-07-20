import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExplicitExclusionResolutionWorker } from '../../src/server/jobs/explicit-exclusion-resolution-worker';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import {
  beginExplicitExclusionResolutionAttempt,
  completeExplicitExclusionResolution,
  createPendingExplicitTrackExclusion,
  getExplicitExclusionResolutionByExclusionId
} from '../../src/server/store/explicit-exclusion-resolutions';
import {
  createExplicitExclusion,
  findMatchingExplicitExclusion,
  listActiveExplicitExclusions
} from '../../src/server/store/explicit-exclusions';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-exclusion-resolution-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Explicit Exclusion resolution worker', () => {
  it('stops promptly, aborts an ignored resolver, and releases the active lease', async () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:hung', displayName: 'Hung',
      aliases: ['hung'], sourceKind: 'listener_instruction', sourceRef: { messageId: 11 },
      queryTitle: 'Hung', createdAt: '2026-07-17T10:00:00.000Z'
    });
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => { started = resolve; });
    let resolverSignal: AbortSignal | undefined;
    const worker = createExplicitExclusionResolutionWorker({
      resolve: async (_record, signal) => {
        resolverSignal = signal;
        started();
        return new Promise(() => undefined);
      },
      now: () => new Date('2026-07-17T10:01:00.000Z')
    });

    const running = worker.runOnce();
    await resolverStarted;
    const stopOutcome = await Promise.race([
      worker.stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ]);

    expect(stopOutcome).toBe('stopped');
    expect(resolverSignal?.aborted).toBe(true);
    await expect(running).resolves.toBe('preempted');
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      leaseToken: null,
      leaseUntil: null
    });
  });

  it('times out an ignored resolver and persists a stable retry code', async () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:timeout', displayName: 'Timeout',
      aliases: ['timeout'], sourceKind: 'listener_instruction', sourceRef: { messageId: 12 },
      queryTitle: 'Timeout', createdAt: '2026-07-17T10:00:00.000Z'
    });
    let resolverSignal: AbortSignal | undefined;
    const worker = createExplicitExclusionResolutionWorker({
      resolve: async (_record, signal) => {
        resolverSignal = signal;
        return new Promise(() => undefined);
      },
      attemptTimeoutMs: 5,
      now: () => new Date('2026-07-17T10:01:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    expect(resolverSignal?.aborted).toBe(true);
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'retryable',
      attemptCount: 1,
      lastErrorCode: 'resolution_timeout'
    });
  });

  it('rejects a stale completion after an expired lease is reclaimed', () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:hello', displayName: 'Hello',
      aliases: ['hello'], sourceKind: 'listener_instruction', sourceRef: { messageId: 8 },
      queryTitle: 'Hello', createdAt: '2026-07-17T10:00:00.000Z'
    });

    const first = beginExplicitExclusionResolutionAttempt({
      id: getExplicitExclusionResolutionByExclusionId(created.exclusion.id)!.id,
      now: new Date('2026-07-17T10:01:00.000Z')
    })!;
    expect(first).toMatchObject({ status: 'processing', attemptCount: 1 });
    expect(first.leaseToken).toEqual(expect.any(String));
    expect(beginExplicitExclusionResolutionAttempt({
      id: first.id,
      now: new Date('2026-07-17T10:05:59.999Z')
    })).toBeNull();

    const second = beginExplicitExclusionResolutionAttempt({
      id: first.id,
      now: new Date('2026-07-17T10:06:00.001Z')
    })!;
    expect(second).toMatchObject({ status: 'processing', attemptCount: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);

    expect(completeExplicitExclusionResolution({
      id: first.id,
      leaseToken: first.leaseToken!,
      track: { ncmId: 'stale', name: 'Wrong Hello', artists: ['Wrong Artist'] },
      now: new Date('2026-07-17T10:06:01.000Z')
    })).toBeNull();
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ provider: null, providerId: null })
    ]);

    expect(completeExplicitExclusionResolution({
      id: second.id,
      leaseToken: second.leaseToken!,
      track: { ncmId: '123', name: 'Hello', artists: ['Adele'] },
      now: new Date('2026-07-17T10:06:02.000Z')
    })).toMatchObject({ status: 'succeeded', resolvedExclusionId: created.exclusion.id });
  });

  it('rejects an expired lease before reclaim without modifying the exclusion', () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:lease-expired', displayName: 'Lease Expired',
      aliases: ['lease expired'], sourceKind: 'listener_instruction', sourceRef: { messageId: 9 },
      queryTitle: 'Lease Expired', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const attempt = beginExplicitExclusionResolutionAttempt({
      id: getExplicitExclusionResolutionByExclusionId(created.exclusion.id)!.id,
      now: new Date('2026-07-17T10:01:00.000Z')
    })!;

    expect(completeExplicitExclusionResolution({
      id: attempt.id,
      leaseToken: attempt.leaseToken!,
      track: { ncmId: 'expired', name: 'Wrong Result', artists: ['Wrong Artist'] },
      now: new Date('2026-07-17T10:06:00.001Z')
    })).toBeNull();
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({
        id: created.exclusion.id,
        entityKey: 'unresolved:lease-expired',
        provider: null,
        providerId: null
      })
    ]);
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'processing',
      leaseToken: attempt.leaseToken,
      leaseUntil: attempt.leaseUntil
    });
  });

  it('caps attempt timeout below the claimed lease', async () => {
    vi.useFakeTimers();
    try {
      const created = createPendingExplicitTrackExclusion({
        userId: 'user-1', entityKey: 'unresolved:timeout-cap', displayName: 'Timeout Cap',
        aliases: ['timeout cap'], sourceKind: 'listener_instruction', sourceRef: { messageId: 13 },
        queryTitle: 'Timeout Cap', createdAt: '2026-07-17T10:00:00.000Z'
      });
      const worker = createExplicitExclusionResolutionWorker({
        resolve: async () => new Promise(() => undefined),
        leaseMs: 20,
        attemptTimeoutMs: 1_000,
        now: () => new Date('2026-07-17T10:01:00.000Z')
      });

      const running = worker.runOnce();
      await vi.advanceTimersByTimeAsync(19);

      await expect(running).resolves.toBe('retry');
      expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
        status: 'retryable',
        attemptCount: 1,
        lastErrorCode: 'resolution_timeout'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically upgrades a pending exclusion to the unique provider identity', async () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1',
      entityKey: 'unresolved:hello',
      displayName: 'Hello',
      aliases: ['hello'],
      sourceKind: 'listener_instruction',
      sourceRef: { messageId: 1 },
      queryTitle: 'Hello',
      createdAt: '2026-07-17T10:00:00.000Z'
    });
    const resolve = vi.fn(async () => ({
      status: 'resolved' as const,
      track: { ncmId: '123', name: 'Hello', artists: ['Adele'] }
    }));
    const worker = createExplicitExclusionResolutionWorker({
      resolve,
      now: () => new Date('2026-07-17T10:01:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBe('completed');

    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
      resolvedExclusionId: created.exclusion.id
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ entityKey: 'ncm:123', provider: 'ncm', providerId: '123' })
    ]);
    expect(findMatchingExplicitExclusion('user-1', {
      id: '123', name: 'Hello', artists: ['Adele']
    })?.id).toBe(created.exclusion.id);
  });

  it('retries transient failures and becomes dead at the persisted deadline', async () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:missing', displayName: 'Missing',
      aliases: ['missing'], sourceKind: 'listener_instruction', sourceRef: { messageId: 2 },
      queryTitle: 'Missing', createdAt: '2026-07-17T10:00:00.000Z',
      deadlineAt: '2026-07-17T10:03:00.000Z'
    });
    let current = new Date('2026-07-17T10:01:00.000Z');
    const worker = createExplicitExclusionResolutionWorker({
      resolve: async () => ({ status: 'unavailable' }),
      now: () => current
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'retryable', attemptCount: 1,
      nextAttemptAt: '2026-07-17T10:02:00.000Z',
      lastErrorCode: 'resolution_unavailable'
    });

    current = new Date('2026-07-17T10:02:00.000Z');
    await expect(worker.runOnce()).resolves.toBe('dead');
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'dead', attemptCount: 2, lastErrorCode: 'resolution_unavailable',
      completedAt: '2026-07-17T10:02:00.000Z'
    });
  });

  it('turns unexpected resolver errors into persisted retries', async () => {
    const created = createPendingExplicitTrackExclusion({
      userId: 'user-1', entityKey: 'unresolved:broken', displayName: 'Broken',
      aliases: ['broken'], sourceKind: 'listener_instruction', sourceRef: { messageId: 5 },
      queryTitle: 'Broken', createdAt: '2026-07-17T10:00:00.000Z'
    });
    const onError = vi.fn();
    const worker = createExplicitExclusionResolutionWorker({
      resolve: async () => { throw new Error('credential decrypt failed'); },
      now: () => new Date('2026-07-17T10:01:00.000Z'),
      onError
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    expect(onError).toHaveBeenCalledOnce();
    expect(getExplicitExclusionResolutionByExclusionId(created.exclusion.id)).toMatchObject({
      status: 'retryable',
      attemptCount: 1,
      nextAttemptAt: '2026-07-17T10:02:00.000Z',
      lastErrorCode: 'resolution_unavailable'
    });
  });

  it('atomically merges a pending request into an existing provider exclusion', async () => {
    const existing = createExplicitExclusion({
      userId: 'user-1',
      entityType: 'track',
      entityKey: 'ncm:123',
      provider: 'ncm',
      providerId: '123',
      displayName: 'Hello',
      aliases: ['hello::adele'],
      sourceKind: 'listener_instruction',
      sourceRef: { messageId: 3 },
      createdAt: '2026-07-17T09:00:00.000Z'
    });
    const pending = createPendingExplicitTrackExclusion({
      userId: 'user-1',
      entityKey: 'unresolved:hello',
      displayName: 'Hello',
      aliases: ['hello'],
      sourceKind: 'listener_instruction',
      sourceRef: { messageId: 4 },
      queryTitle: 'Hello',
      createdAt: '2026-07-17T10:00:00.000Z'
    });
    const worker = createExplicitExclusionResolutionWorker({
      resolve: async () => ({
        status: 'resolved',
        track: { ncmId: '123', name: 'Hello', artists: ['Adele'] }
      }),
      now: () => new Date('2026-07-17T10:01:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBe('completed');

    expect(getExplicitExclusionResolutionByExclusionId(pending.exclusion.id)).toMatchObject({
      status: 'succeeded',
      resolvedExclusionId: existing.exclusion.id
    });
    expect(listActiveExplicitExclusions('user-1')).toEqual([
      expect.objectContaining({ id: existing.exclusion.id, entityKey: 'ncm:123' })
    ]);
    expect(listActiveExplicitExclusions('user-1')[0]?.aliases).toEqual(expect.arrayContaining([
      'hello',
      'hello::adele'
    ]));
  });
});
