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

  it('aborts timed out runs, notifies immediately, and keeps the lock until the job settles', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let finishJob!: () => void;
    const onTimeout = vi.fn();
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 4,
      getJobTimeoutMs: () => 5_000,
      onTimeout,
      // The job does NOT settle in response to the abort: the lock must stay
      // held until it eventually settles.
      runPickNext: vi.fn(({ signal }) => {
        observedSignal = signal;
        return new Promise<void>((resolve) => {
          finishJob = resolve;
        });
      })
    });

    const run = runner.run({ userId: 'u1', ncmClient });
    await vi.advanceTimersByTimeAsync(5_000);

    // The client was notified at the timeout instant…
    expect(observedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith({ userId: 'u1', targetPickCount: 4, jobTimeoutMs: 5_000 });
    // …but the lock must stay held until the underlying job settles.
    expect(runner.isRunning('u1')).toBe(true);
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // The job eventually settles: the run resolves and the lock is released.
    finishJob();
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toEqual({ status: 'timeout' });
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

  it('isolates a throwing timeout notification: still waits for the job to settle, swallows its rejection, and returns timeout', async () => {
    let rejectJob!: (err: Error) => void;
    const onTimeout = vi.fn(() => {
      throw new Error('notification failed');
    });
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 10,
      onTimeout,
      // The job ignores the abort and later REJECTS: the runner must still wait
      // for the underlying promise to settle and must not leak an unhandled
      // rejection — neither from the job nor from the throwing callback.
      runPickNext: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectJob = reject;
      }))
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = runner.run({ userId: 'u1', ncmClient });
      await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));

      // The running lock must stay held until the underlying job settles…
      expect(runner.isRunning('u1')).toBe(true);
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);

      // The job settles by REJECTING: the runner swallows it and returns timeout.
      rejectJob(new Error('job blew up'));
      await expect(run).resolves.toEqual({ status: 'timeout' });
      expect(runner.isRunning('u1')).toBe(false);

      // Give Node a tick to surface any unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('allows timeout handling to be provided per run', async () => {
    vi.useFakeTimers();
    const defaultOnTimeout = vi.fn();
    const runOnTimeout = vi.fn();
    let finishJob!: () => void;
    const runner = createDjPickNextRunner({
      getTargetPickCount: () => 2,
      getJobTimeoutMs: () => 100,
      onTimeout: defaultOnTimeout,
      // The job ignores the abort; the timeout notification fires immediately
      // while the lock stays held until the job settles.
      runPickNext: vi.fn(() => new Promise<void>((resolve) => {
        finishJob = resolve;
      }))
    });

    const run = runner.run({ userId: 'u1', ncmClient, onTimeout: runOnTimeout });
    await vi.advanceTimersByTimeAsync(100);

    expect(runOnTimeout).toHaveBeenCalledWith({ userId: 'u1', targetPickCount: 2, jobTimeoutMs: 100 });
    expect(defaultOnTimeout).not.toHaveBeenCalled();
    expect(runner.isRunning('u1')).toBe(true);

    finishJob();
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toEqual({ status: 'timeout' });
    expect(runner.isRunning('u1')).toBe(false);
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
