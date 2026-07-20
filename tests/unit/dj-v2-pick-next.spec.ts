import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { setQueueState } from '../../src/server/store/queue';
import { getDjPickReason, runDjPickNext } from '../../src/server/dj/pickNextRun';

vi.mock('../../src/server/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-v2-pick-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
  setQueueState('v2-user', [{ ncmId: 'current', name: 'Current', artists: ['Artist'] }], 0);
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('DJ v2 pick-next orchestration', () => {
  it('returns an explicit no-selection result when LLM config is unavailable', async () => {
    const emit = vi.fn();
    const createAgent = vi.fn();
    await runDjPickNext('v2-user', {} as never, emit, undefined, {
      resolveLlmConfig: () => null,
      createAgent
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      targetCount: 2,
      reason: 'llm-not-configured'
    });
  });

  it('does not start an alternative selection pipeline after an aborted v2 run', async () => {
    const emit = vi.fn();
    const pickNext = vi.fn(async () => ({
      status: 'aborted',
      debugBroadcastSent: false,
      output: { status: 'aborted' },
      runId: 'run-aborted',
      selectionStartedEventId: 'event-aborted'
    }));
    await runDjPickNext('v2-user', {} as never, emit, undefined, {
      resolveLlmConfig: () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'sk', model: 'model' }),
      createAgent: () => ({ pickNext } as never)
    });

    expect(pickNext).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      reason: 'aborted'
    }));
  });

  it('isolates the cached pick reason by user when two users select the same track', async () => {
    const runFor = async (userId: string, reason: string) => {
      await runDjPickNext(userId, {} as never, vi.fn(), undefined, {
        resolveLlmConfig: () => ({ baseUrl: 'https://llm.example/v1', apiKey: 'sk', model: 'model' }),
        createAgent: () => ({
          pickNext: async (input: { setPickReason(trackId: string, value: string): void }) => {
            input.setPickReason('shared-track', reason);
            return { status: 'handled' } as never;
          }
        } as never)
      });
    };

    await runFor('user-a', 'reason-for-a');
    await runFor('user-b', 'reason-for-b');

    expect(getDjPickReason('user-a', 'shared-track')).toBe('reason-for-a');
    expect(getDjPickReason('user-b', 'shared-track')).toBe('reason-for-b');
  });
});
