import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import {
  claimNextSelectionNarration,
  completeSelectionNarration,
  enqueueSelectionNarration,
  expireSelectionNarrations,
  failSelectionNarration,
  getSelectionNarration
} from '../../src/server/store/selection-narration-outbox';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-narration-outbox-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CROSSFADIO_DATA_DIR;
});

const base = {
  journeyId: 'journey-1',
  userId: 'user-1',
  runId: 'run-1',
  journeyVersion: 1,
  factsHash: 'facts-1'
};

describe('selection narration outbox', () => {
  it('enqueues idempotently by run, version and facts hash', () => {
    const now = new Date('2026-07-17T10:00:00.000Z');
    const first = enqueueSelectionNarration({ ...base, now });
    const repeated = enqueueSelectionNarration({ ...base, now: new Date(now.getTime() + 5_000) });

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ status: 'pending', attemptCount: 0, nextAttemptAt: now.toISOString() });
  });

  it('isolates the same run, version and facts hash by user', () => {
    const now = new Date('2026-07-17T10:00:00.000Z');
    const first = enqueueSelectionNarration({ ...base, now });
    const second = enqueueSelectionNarration({
      ...base,
      journeyId: 'journey-2',
      userId: 'user-2',
      now
    });

    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({ journeyId: 'journey-1', userId: 'user-1' });
    expect(second).toMatchObject({ journeyId: 'journey-2', userId: 'user-2' });
  });

  it('leases due work and only accepts completion from the current lease', () => {
    const now = new Date('2026-07-17T10:00:00.000Z');
    const queued = enqueueSelectionNarration({ ...base, now });
    const firstLease = claimNextSelectionNarration({ now, leaseMs: 60_000 });

    expect(firstLease).toMatchObject({ id: queued.id, status: 'processing', attemptCount: 1 });
    expect(claimNextSelectionNarration({ now, leaseMs: 60_000 })).toBeNull();

    const recovered = claimNextSelectionNarration({
      now: new Date(now.getTime() + 60_001),
      leaseMs: 60_000
    });
    expect(recovered).toMatchObject({ id: queued.id, attemptCount: 2 });
    expect(completeSelectionNarration({
      id: queued.id,
      leaseUntil: firstLease!.leaseUntil!,
      now: new Date(now.getTime() + 60_002)
    })).toBe(false);
    expect(completeSelectionNarration({
      id: queued.id,
      leaseUntil: recovered!.leaseUntil!,
      now: new Date(now.getTime() + 60_002)
    })).toBe(true);
  });

  it('uses the fixed retry delays and stops after five attempts', () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    enqueueSelectionNarration({ ...base, now: started });
    const attemptOffsets = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
    let attemptAt = started;

    for (const [index, offset] of attemptOffsets.entries()) {
      const claim = claimNextSelectionNarration({ now: attemptAt, leaseMs: 30_000 })!;
      expect(claim.attemptCount).toBe(index + 1);
      const result = failSelectionNarration({
        id: claim.id,
        leaseUntil: claim.leaseUntil!,
        errorCode: 'narration_failed',
        now: attemptAt
      });
      expect(result).toMatchObject({ status: 'pending' });
      expect(Date.parse(result!.nextAttemptAt) - started.getTime()).toBe(offset);
      attemptAt = new Date(started.getTime() + offset);
    }

    const finalClaim = claimNextSelectionNarration({ now: attemptAt, leaseMs: 30_000 })!;
    expect(finalClaim.attemptCount).toBe(5);
    expect(failSelectionNarration({
      id: finalClaim.id,
      leaseUntil: finalClaim.leaseUntil!,
      errorCode: 'narration_failed',
      now: attemptAt
    })).toMatchObject({ status: 'dead', attemptCount: 5 });
  });

  it('never leases or republishes work after its 24 hour deadline', () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    const queued = enqueueSelectionNarration({ ...base, now: started });

    const deadline = new Date(started.getTime() + 24 * 60 * 60_000);
    expect(expireSelectionNarrations(deadline)).toEqual([
      expect.objectContaining({ id: queued.id, status: 'dead', lastError: 'narration_deadline_exceeded' })
    ]);
    expect(claimNextSelectionNarration({ now: deadline, leaseMs: 60_000 })).toBeNull();
  });
});
