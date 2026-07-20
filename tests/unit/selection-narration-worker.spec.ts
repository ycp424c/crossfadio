import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionDecisionTrace, SelectionJourneySnapshot } from '../../src/shared/selection';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import {
  completeSelectionJourneyNarration,
  failSelectionJourneyNarrationTerminal,
  getSelectionJourney,
  saveSelectionJourney
} from '../../src/server/store/selection-journeys';
import {
  claimNextSelectionNarration,
  enqueueSelectionNarration,
  failSelectionNarration,
  getSelectionNarration
} from '../../src/server/store/selection-narration-outbox';
import { createSelectionJourneyNarrationWorker } from '../../src/server/jobs/selection-journey-narration-worker';
import { recordSelectionReplayRun } from '../../src/server/store/selection-replay';
import { LlmError } from '../../src/server/llm/client';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-narration-worker-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CROSSFADIO_DATA_DIR;
});

const trace: SelectionDecisionTrace = {
  schemaVersion: 1,
  runId: 'run-1',
  mode: 'autonomous',
  createdAt: '2026-07-17T10:00:00.000Z',
  decisions: [{
    stage: 'final', action: 'selected', reasonCode: 'final_eligible',
    candidateId: 'track-1', provenance: { source: 'system' }, evidenceRefs: []
  }]
};

function snapshot(overrides: Partial<SelectionJourneySnapshot> = {}): SelectionJourneySnapshot {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    journeyVersion: 1,
    revision: 1,
    status: 'completed',
    summary: '这一轮已经选好。',
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:03.000Z',
    completedAt: '2026-07-17T10:00:03.000Z',
    stages: [{
      stage: 'finalizing', status: 'completed', title: '确定选择',
      detail: '完成最后选择。', reasonCodes: ['final_eligible']
    }],
    candidates: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや', state: 'selected' }],
    selections: [{
      trackId: 'track-1', trackName: 'Plastic Love', artist: '竹内まりや', reason: '整体搭配更平衡。'
    }],
    narration: { status: 'pending' },
    ...overrides
  };
}

function arrangeJourney(now: Date) {
  recordSelectionReplayRun({
    userId: 'user-1',
    runId: 'run-1',
    selectedTrackIds: ['track-1'],
    candidateCount: 1,
    eligibleCount: 1,
    appendedCount: 1,
    latencyMs: 1_000,
    hardViolationCount: 0,
    promptJsonStatus: 'valid',
    journeyPublished: true,
    outcome: 'succeeded',
    reasonCodes: ['final_eligible'],
    startedAt: now.toISOString(),
    completedAt: now.toISOString()
  });
  const journey = saveSelectionJourney({ userId: 'user-1', factsHash: 'facts-1', snapshot: snapshot() });
  const queued = enqueueSelectionNarration({
    journeyId: journey.id,
    userId: 'user-1',
    runId: 'run-1',
    journeyVersion: 1,
    factsHash: 'facts-1',
    now
  });
  return { journey, queued };
}

function arrangeJourneyWithProvisionalReplay(now: Date) {
  recordSelectionReplayRun({
    userId: 'user-1',
    runId: 'run-1',
    selectedTrackIds: [],
    candidateCount: 0,
    eligibleCount: 0,
    appendedCount: 0,
    latencyMs: 0,
    hardViolationCount: 0,
    promptJsonStatus: 'not_observed',
    journeyPublished: false,
    outcome: 'failed',
    reasonCodes: ['selection_run_started'],
    startedAt: now.toISOString(),
    completedAt: null
  });
  const journey = saveSelectionJourney({ userId: 'user-1', factsHash: 'facts-1', snapshot: snapshot() });
  const queued = enqueueSelectionNarration({
    journeyId: journey.id,
    userId: 'user-1',
    runId: 'run-1',
    journeyVersion: 1,
    factsHash: 'facts-1',
    now
  });
  return { journey, queued };
}

function replayNarrationStatus(): string | undefined {
  return (getDb().prepare(
    'SELECT narration_status AS status FROM selection_replay_runs WHERE user_id = ? AND run_id = ?'
  ).get('user-1', 'run-1') as { status?: string } | undefined)?.status;
}

const context = {
  userId: 'user-1',
  trace,
  djPersona: '温暖简洁的 DJ',
  toneTags: ['warm'],
  entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
};

describe('selection narration worker', () => {
  it('does not let an expired lease persist polished Journey text', () => {
    const started = new Date('2026-07-17T10:01:00.000Z');
    const { journey } = arrangeJourney(started);
    const stale = claimNextSelectionNarration({ now: started, leaseMs: 1_000 })!;
    const recoveredAt = new Date(started.getTime() + 1_001);
    const recovered = claimNextSelectionNarration({ now: recoveredAt, leaseMs: 60_000 })!;

    expect(completeSelectionJourneyNarration({
      outboxId: stale.id,
      journeyId: journey.id,
      userId: stale.userId,
      runId: stale.runId,
      journeyVersion: stale.journeyVersion,
      factsHash: stale.factsHash,
      leaseUntil: stale.leaseUntil!,
      expectedRevision: journey.snapshot.revision,
      snapshot: {
        ...journey.snapshot,
        revision: journey.snapshot.revision + 1,
        updatedAt: recoveredAt.toISOString(),
        narration: { status: 'polished', text: '过期 attempt 的文案' }
      },
      completedAt: recoveredAt
    })).toBeNull();
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot.narration).toEqual({ status: 'pending' });
    expect(getSelectionNarration(stale.id)).toMatchObject({
      status: 'processing',
      leaseUntil: recovered.leaseUntil
    });
  });

  it('polishes the current Journey and publishes the exact saved shared snapshot', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    const publish = vi.fn();
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockResolvedValue('今晚从熟悉的律动出发，也留了一点变化。'),
      publish
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(replayNarrationStatus()).toBe('succeeded');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'completed', attemptCount: 1 });
    expect(publish).toHaveBeenCalledWith('user-1', {
      type: 'selection.journey',
      snapshot: expect.objectContaining({
        revision: 2,
        narration: { status: 'polished', text: '今晚从熟悉的律动出发，也留了一点变化。' }
      })
    });
  });

  it('recovers a pre-fix outbox whose replay row is still provisional', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourneyWithProvisionalReplay(now);
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockResolvedValue('这条旧任务已经安全恢复。')
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(replayNarrationStatus()).toBe('succeeded');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'completed' });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot.narration).toEqual({
      status: 'polished', text: '这条旧任务已经安全恢复。'
    });
  });

  it('rolls back outbox and Journey when the replay success update fails', () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { journey, queued } = arrangeJourney(now);
    const claim = claimNextSelectionNarration({ now, leaseMs: 60_000 })!;
    getDb().exec(`
      CREATE TRIGGER inject_replay_success_failure
      BEFORE UPDATE OF narration_status ON selection_replay_runs
      WHEN NEW.narration_status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'injected replay success failure');
      END
    `);

    expect(() => completeSelectionJourneyNarration({
      outboxId: queued.id,
      journeyId: journey.id,
      userId: queued.userId,
      runId: queued.runId,
      journeyVersion: queued.journeyVersion,
      factsHash: queued.factsHash,
      leaseUntil: claim.leaseUntil!,
      expectedRevision: journey.snapshot.revision,
      snapshot: {
        ...journey.snapshot,
        revision: journey.snapshot.revision + 1,
        updatedAt: now.toISOString(),
        narration: { status: 'polished', text: '不应部分提交的文案。' }
      },
      completedAt: now
    })).toThrow(/injected replay success failure/i);
    expect(getSelectionNarration(queued.id)).toMatchObject({
      status: 'processing',
      leaseUntil: claim.leaseUntil
    });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot).toMatchObject({
      revision: 1,
      narration: { status: 'pending' }
    });
    expect(replayNarrationStatus()).toBe('pending');
  });

  it('rolls back expired outbox and Journey when the replay failure update fails', () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    const failedAt = new Date(started.getTime() + 24 * 60 * 60_000);
    const { journey, queued } = arrangeJourney(started);
    getDb().exec(`
      CREATE TRIGGER inject_replay_failure_failure
      BEFORE UPDATE OF narration_status ON selection_replay_runs
      WHEN NEW.narration_status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected replay failure failure');
      END
    `);

    expect(() => failSelectionJourneyNarrationTerminal({
      outboxId: queued.id,
      journeyId: journey.id,
      userId: queued.userId,
      runId: queued.runId,
      journeyVersion: queued.journeyVersion,
      factsHash: queued.factsHash,
      expectedOutboxStatus: 'pending',
      expectedAttemptCount: 0,
      expectedLeaseUntil: null,
      expectedRevision: journey.snapshot.revision,
      snapshot: {
        ...journey.snapshot,
        revision: journey.snapshot.revision + 1,
        updatedAt: failedAt.toISOString(),
        narration: { status: 'failed' }
      },
      errorCode: 'narration_deadline_exceeded',
      terminalCause: 'expiration',
      failedAt
    })).toThrow(/injected replay failure failure/i);
    expect(getSelectionNarration(queued.id)).toMatchObject({
      status: 'pending',
      lastError: null
    });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot).toMatchObject({
      revision: 1,
      narration: { status: 'pending' }
    });
    expect(replayNarrationStatus()).toBe('pending');
  });

  it('does not retry an already persisted narration when ephemeral broadcast fails', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    const onError = vi.fn();
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockResolvedValue('这份手记已经可靠保存。'),
      publish: vi.fn().mockRejectedValue(new Error('socket closed')),
      onError
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'completed' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket closed' }));
  });

  it('discards old journey versions and facts hashes without calling narration', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    saveSelectionJourney({
      userId: 'user-1',
      factsHash: 'facts-2',
      snapshot: snapshot({ revision: 2, updatedAt: '2026-07-17T10:00:04.000Z' })
    });
    saveSelectionJourney({
      userId: 'user-1',
      factsHash: 'facts-v2',
      snapshot: snapshot({ journeyVersion: 2, revision: 1, updatedAt: '2026-07-17T10:00:05.000Z' })
    });
    const narrate = vi.fn();
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate
    });

    await expect(worker.runOnce()).resolves.toBe('stale');
    expect(narrate).not.toHaveBeenCalled();
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'dead' });
  });

  it('isolates an expired stale row and continues with healthy narration work', async () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    const now = new Date(started.getTime() + 24 * 60 * 60_000);
    const { queued: stale } = arrangeJourney(started);
    saveSelectionJourney({
      userId: 'user-1',
      factsHash: 'facts-v2',
      snapshot: snapshot({ journeyVersion: 2, revision: 1, updatedAt: now.toISOString() })
    });

    recordSelectionReplayRun({
      userId: 'user-2', runId: 'run-2', selectedTrackIds: ['track-1'],
      candidateCount: 1, eligibleCount: 1, appendedCount: 1, latencyMs: 1_000,
      hardViolationCount: 0, promptJsonStatus: 'valid', journeyPublished: true,
      outcome: 'succeeded', reasonCodes: ['final_eligible'],
      startedAt: now.toISOString(), completedAt: now.toISOString()
    });
    const healthyJourney = saveSelectionJourney({
      userId: 'user-2',
      factsHash: 'facts-2',
      snapshot: snapshot({
        runId: 'run-2',
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        completedAt: now.toISOString()
      })
    });
    const healthy = enqueueSelectionNarration({
      journeyId: healthyJourney.id,
      userId: 'user-2',
      runId: 'run-2',
      journeyVersion: 1,
      factsHash: 'facts-2',
      now
    });
    const narrate = vi.fn().mockResolvedValue('健康任务不应被旧行阻塞。');
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockImplementation((record) => ({
        ...context,
        userId: record.userId,
        trace: { ...trace, runId: record.runId }
      })),
      narrate
    });

    await expect(worker.runOnce()).resolves.toBe('completed');
    expect(getSelectionNarration(stale.id)).toMatchObject({
      status: 'dead', lastError: 'narration_journey_stale'
    });
    expect(getSelectionNarration(healthy.id)).toMatchObject({ status: 'completed' });
    expect(narrate).toHaveBeenCalledTimes(1);
  });

  it('lets foreground LLM work preempt narration without consuming an attempt', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    let started!: () => void;
    const narrationStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockImplementation(() => new Promise(() => {
        started();
      }))
    });

    const running = worker.runOnce();
    await narrationStarted;
    worker.preempt();
    await expect(running).resolves.toBe('preempted');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('times out an attempt even when narration ignores its AbortSignal', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      attemptTimeoutMs: 5,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockImplementation(() => new Promise(() => undefined))
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    expect(getSelectionNarration(queued.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastError: 'narration_timeout'
    });
  });

  it('drops a result that finishes at the 24 hour deadline', async () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    let clock = new Date(started.getTime() + 23 * 60 * 60_000 + 59 * 60_000);
    const { queued } = arrangeJourney(started);
    const publish = vi.fn();
    const worker = createSelectionJourneyNarrationWorker({
      now: () => clock,
      leaseMs: 2 * 60_000,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockImplementation(async () => {
        clock = new Date(started.getTime() + 24 * 60 * 60_000);
        return '这段结果已经过时。';
      }),
      publish
    });

    await expect(worker.runOnce()).resolves.toBe('dead');
    expect(replayNarrationStatus()).toBe('failed');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'dead' });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot.narration).toEqual({ status: 'failed' });
    expect(publish).toHaveBeenCalledWith('user-1', expect.objectContaining({
      snapshot: expect.objectContaining({ narration: { status: 'failed' } })
    }));
  });

  it('marks the Journey failed when pending narration reaches its 24 hour deadline', async () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    const { queued } = arrangeJourney(started);
    const publish = vi.fn();
    const worker = createSelectionJourneyNarrationWorker({
      now: () => new Date(started.getTime() + 24 * 60 * 60_000),
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn(),
      publish
    });

    await expect(worker.runOnce()).resolves.toBe('dead');
    expect(replayNarrationStatus()).toBe('failed');
    expect(getSelectionNarration(queued.id)).toMatchObject({
      status: 'dead', lastError: 'narration_deadline_exceeded'
    });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot.narration).toEqual({ status: 'failed' });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stops promptly when active narration ignores its AbortSignal', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    let started!: () => void;
    const narrationStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockImplementation(() => new Promise(() => {
        started();
      }))
    });

    const running = worker.runOnce();
    await narrationStarted;
    await worker.stop();
    await expect(running).resolves.toBe('preempted');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('marks the deterministic Journey failed after the final retry is exhausted', async () => {
    const started = new Date('2026-07-17T10:00:00.000Z');
    const { queued } = arrangeJourney(started);
    let attemptAt = started;
    for (const offset of [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000]) {
      const claim = claimNextSelectionNarration({ now: attemptAt, leaseMs: 30_000 })!;
      failSelectionNarration({
        id: claim.id, leaseUntil: claim.leaseUntil!, errorCode: 'narration_failed', now: attemptAt
      });
      attemptAt = new Date(started.getTime() + offset);
    }
    const worker = createSelectionJourneyNarrationWorker({
      now: () => attemptAt,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockRejectedValue(new Error('final failure'))
    });

    await expect(worker.runOnce()).resolves.toBe('dead');
    expect(replayNarrationStatus()).toBe('failed');
    expect(getSelectionNarration(queued.id)).toMatchObject({ status: 'dead', attemptCount: 5 });
    expect(getSelectionJourney('user-1', 'run-1')?.snapshot.narration).toEqual({ status: 'failed' });
  });

  it('stores only a stable provider failure code without leaking the provider response', async () => {
    const now = new Date('2026-07-17T10:01:00.000Z');
    const { queued } = arrangeJourney(now);
    const worker = createSelectionJourneyNarrationWorker({
      now: () => now,
      loadContext: vi.fn().mockResolvedValue(context),
      narrate: vi.fn().mockRejectedValue(new LlmError(
        'LLM request failed: 429; response body: {"echo":"PRIVATE PERSONA"}',
        { status: 429, responseBody: '{"echo":"PRIVATE PERSONA"}' }
      ))
    });

    await expect(worker.runOnce()).resolves.toBe('retry');
    const record = getSelectionNarration(queued.id);
    expect(record).toMatchObject({
      status: 'pending',
      lastError: 'narration_provider_rate_limited'
    });
    expect(JSON.stringify(record)).not.toContain('PRIVATE PERSONA');
    expect(JSON.stringify(record)).not.toContain('response body');
  });
});
