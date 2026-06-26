import { describe, expect, it, vi, afterEach } from 'vitest';
import { createDjPickNextRunner } from '../../src/server/dj/pickNextRunner';
import type { NcmClient } from '../../src/server/ncm/client';

const ncmClient = {} as NcmClient;

describe('DJ pick-next runner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects concurrent runs for the same user and releases the lock after completion', async () => {
    let finishRun: (() => void) | undefined;
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 10_000,
      runPickNext: vi.fn(() => new Promise<void>((resolve) => {
        finishRun = resolve;
      }))
    });

    const firstRun = runner.run({ userId: 'u1', ncmClient });

    expect(runner.isRunning('u1')).toBe(true);
    await expect(runner.run({ userId: 'u1', ncmClient })).resolves.toEqual({ status: 'already-running' });

    finishRun?.();
    await expect(firstRun).resolves.toEqual({ status: 'done' });
    expect(runner.isRunning('u1')).toBe(false);
  });

  it('aborts timed out runs and releases the lock', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 4,
      getJobTimeoutMs: () => 5_000,
      onTimeout,
      runPickNext: vi.fn(({ signal }) => {
        observedSignal = signal;
        return new Promise<void>(() => {});
      })
    });

    const run = runner.run({ userId: 'u1', ncmClient });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(run).resolves.toEqual({ status: 'timeout' });
    expect(observedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith({ userId: 'u1', targetPickCount: 4, jobTimeoutMs: 5_000 });
    expect(runner.isRunning('u1')).toBe(false);
  });

  it('passes the event sink through to the pick-next implementation', async () => {
    const emit = vi.fn();
    const runPickNext = vi.fn(async ({ emit: receivedEmit }) => {
      receivedEmit?.({ type: 'dj.debug' });
    });
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 10_000,
      runPickNext
    });

    await expect(runner.run({ userId: 'u1', ncmClient, emit })).resolves.toEqual({ status: 'done' });

    expect(emit).toHaveBeenCalledWith({ type: 'dj.debug' });
  });

  it('allows timeout handling to be provided per run', async () => {
    vi.useFakeTimers();
    const defaultOnTimeout = vi.fn();
    const runOnTimeout = vi.fn();
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 100,
      onTimeout: defaultOnTimeout,
      runPickNext: vi.fn(() => new Promise<void>(() => {}))
    });

    const run = runner.run({ userId: 'u1', ncmClient, onTimeout: runOnTimeout });
    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toEqual({ status: 'timeout' });
    expect(runOnTimeout).toHaveBeenCalledWith({ userId: 'u1', targetPickCount: 2, jobTimeoutMs: 100 });
    expect(defaultOnTimeout).not.toHaveBeenCalled();
  });

  it('releases the lock when target count resolution fails', async () => {
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => {
        throw new Error('prefs unavailable');
      },
      getJobTimeoutMs: () => 10_000,
      runPickNext: vi.fn(async () => {})
    });

    await expect(runner.run({ userId: 'u1', ncmClient })).rejects.toThrow('prefs unavailable');

    expect(runner.isRunning('u1')).toBe(false);
  });

  it('releases the lock when the pick-next implementation rejects', async () => {
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 10_000,
      runPickNext: vi.fn(async () => {
        throw new Error('pick failed');
      })
    });

    await expect(runner.run({ userId: 'u1', ncmClient })).rejects.toThrow('pick failed');

    expect(runner.isRunning('u1')).toBe(false);
  });

  it('propagates parent abort signals to the pick-next implementation and releases the lock', async () => {
    const parentController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let finishRun: (() => void) | undefined;
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 10_000,
      runPickNext: vi.fn(({ signal }) => {
        observedSignal = signal;
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      })
    });

    const run = runner.run({ userId: 'u1', ncmClient, signal: parentController.signal });

    parentController.abort(new Error('client-disconnected'));
    expect(observedSignal?.aborted).toBe(true);
    finishRun?.();
    await expect(run).resolves.toEqual({ status: 'done' });
    expect(runner.isRunning('u1')).toBe(false);
  });
});
