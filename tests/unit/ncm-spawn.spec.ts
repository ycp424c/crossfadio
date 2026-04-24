import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { NcmProcessManager, parseCommandArgs, resolveNcmLaunchConfig } from '../../src/server/ncm/spawn';

class FakeChildProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  pid: number;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit('exit', 0, signal ?? null);
    return true;
  }
}

describe('parseCommandArgs', () => {
  it('parses quoted args and spaces', () => {
    expect(parseCommandArgs(`--port 3000 --name "cross fadio" --flag='x y'`)).toEqual([
      '--port',
      '3000',
      '--name',
      'cross fadio',
      '--flag=x y'
    ]);
  });
});

describe('resolveNcmLaunchConfig', () => {
  it('uses explicit command from env first', () => {
    const config = resolveNcmLaunchConfig({
      CROSSFADIO_NCM_COMMAND: 'node',
      CROSSFADIO_NCM_ARGS: 'server.js --port 3000'
    });

    expect(config).toEqual({
      command: 'node',
      args: ['server.js', '--port', '3000'],
      enabled: true,
      reason: null
    });
  });

  it('supports disabling auto launch fallback', () => {
    const config = resolveNcmLaunchConfig({
      CROSSFADIO_NCM_DISABLE_AUTO: '1'
    });

    expect(config.enabled).toBe(false);
    expect(config.command).toBe('');
  });
});

describe('NcmProcessManager', () => {
  it('starts and passes health check', async () => {
    const proc = new FakeChildProcess(1234);
    const manager = new NcmProcessManager({
      env: {
        CROSSFADIO_NCM_COMMAND: 'mock-cmd',
        CROSSFADIO_NCM_ARGS: '--x 1',
        CROSSFADIO_NCM_PORT: '3333',
        CROSSFADIO_NCM_DISABLE_AUTO: '1'
      },
      spawnImpl: () => proc as any,
      fetchImpl: async () => new Response(null, { status: 200 }),
      getAppPath: () => process.cwd(),
      getUserDataPath: () => process.cwd(),
      healthTimeoutMs: 30,
      healthIntervalMs: 5
    });

    await manager.start();
    const status = manager.getStatus();

    expect(status.running).toBe(true);
    expect(status.pid).toBe(1234);
    expect(status.baseUrl).toBe('http://127.0.0.1:3333');
  });

  it('throws when health check times out', async () => {
    const proc = new FakeChildProcess(1001);
    const manager = new NcmProcessManager({
      env: {
        CROSSFADIO_NCM_COMMAND: 'mock-cmd',
        CROSSFADIO_NCM_DISABLE_AUTO: '1'
      },
      spawnImpl: () => proc as any,
      fetchImpl: async () => {
        throw new Error('not ready');
      },
      getAppPath: () => process.cwd(),
      getUserDataPath: () => process.cwd(),
      healthTimeoutMs: 20,
      healthIntervalMs: 5
    });

    await expect(manager.start()).rejects.toThrow('NCM health check timeout');
    expect(manager.getStatus().running).toBe(false);
  });

  it('limits restart attempts in a rolling window', async () => {
    const spawned: FakeChildProcess[] = [];
    let pid = 2000;
    const manager = new NcmProcessManager({
      env: {
        CROSSFADIO_NCM_COMMAND: 'mock-cmd',
        CROSSFADIO_NCM_DISABLE_AUTO: '1'
      },
      spawnImpl: () => {
        const proc = new FakeChildProcess(pid++);
        spawned.push(proc);
        return proc as any;
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
      getAppPath: () => process.cwd(),
      getUserDataPath: () => process.cwd(),
      restartDelayMs: 5,
      restartWindowMs: 1000,
      restartMaxAttempts: 2,
      healthTimeoutMs: 20,
      healthIntervalMs: 5
    });

    await manager.start();
    spawned[0].emit('exit', 1, null);
    await sleep(30);

    spawned[1].emit('exit', 1, null);
    await sleep(30);

    spawned[2].emit('exit', 1, null);
    await sleep(30);

    expect(spawned).toHaveLength(3);
    expect(manager.getStatus().lastError).toContain('retries exceeded');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
