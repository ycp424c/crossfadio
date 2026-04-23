import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { app } from 'electron';

export type NcmStatus = {
  enabled: boolean;
  running: boolean;
  baseUrl: string;
  pid: number | null;
  lastError: string | null;
  startedAt: string | null;
  restartCount: number;
  command: string;
  args: string[];
};

type NcmLaunchConfig = {
  command: string;
  args: string[];
  enabled: boolean;
  reason: string | null;
};

type NcmProcessManagerOptions = {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
  fetchImpl?: typeof fetch;
  getAppPath?: () => string;
  getUserDataPath?: () => string;
  restartDelayMs?: number;
  restartWindowMs?: number;
  restartMaxAttempts?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
};

export class NcmProcessManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnImpl: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
  private readonly fetchImpl: typeof fetch;
  private readonly getAppPath: () => string;
  private readonly getUserDataPath: () => string;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly baseUrl: string;
  private readonly healthPath: string;
  private readonly restartDelayMs: number;
  private readonly restartWindowMs: number;
  private readonly restartMaxAttempts: number;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private status: NcmStatus;
  private shouldStop = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartTimestamps: number[] = [];

  constructor(options: NcmProcessManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getAppPath = options.getAppPath ?? (() => app.getAppPath());
    this.getUserDataPath = options.getUserDataPath ?? (() => app.getPath('userData'));
    this.restartDelayMs = options.restartDelayMs ?? 3_000;
    this.restartWindowMs = options.restartWindowMs ?? 60_000;
    this.restartMaxAttempts = options.restartMaxAttempts ?? 3;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 8_000;
    this.healthIntervalMs = options.healthIntervalMs ?? 300;

    const launch = resolveNcmLaunchConfig(this.env);
    this.command = launch.command;
    this.args = launch.args;
    this.cwd = this.env.CROSSFADIO_NCM_CWD || this.getAppPath() || this.getUserDataPath();
    const port = normalizePort(this.env.CROSSFADIO_NCM_PORT);
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.healthPath = normalizeHealthPath(this.env.CROSSFADIO_NCM_HEALTH_PATH ?? '/');

    this.status = {
      enabled: launch.enabled,
      running: false,
      baseUrl: this.baseUrl,
      pid: null,
      lastError: launch.reason,
      startedAt: null,
      restartCount: 0,
      command: this.command,
      args: [...this.args]
    };
  }

  async start(): Promise<void> {
    if (!this.status.enabled || this.process) {
      return;
    }
    this.shouldStop = false;

    this.process = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: {
        ...this.env,
        PORT: this.baseUrl.split(':').pop() ?? '3000',
        HOST: '127.0.0.1'
      },
      stdio: 'pipe'
    });

    this.status.running = true;
    this.status.pid = this.process.pid ?? null;
    this.status.startedAt = new Date().toISOString();
    this.status.lastError = null;

    this.process.stderr.on('data', (chunk) => {
      this.status.lastError = String(chunk).trim().slice(0, 500);
    });

    this.process.on('error', (error) => {
      this.status.running = false;
      this.status.pid = null;
      this.status.lastError = error instanceof Error ? error.message : 'NCM process error';
    });

    this.process.on('exit', (code, signal) => {
      this.status.running = false;
      this.status.pid = null;
      this.process = null;
      this.status.lastError = `NCM exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;

      if (!this.shouldStop) {
        this.scheduleRestart();
      }
    });

    try {
      await this.waitForHealth();
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : 'NCM health check timeout';
      await this.stopProcessOnly();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.shouldStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      return;
    }

    await this.stopProcessOnly();

    this.status.running = false;
    this.status.pid = null;
  }

  getStatus(): NcmStatus {
    return { ...this.status };
  }

  private async waitForHealth(): Promise<void> {
    const startAt = Date.now();
    const probePaths = uniquePaths([this.healthPath, '/login/status', '/']);

    while (Date.now() - startAt < this.healthTimeoutMs) {
      for (const path of probePaths) {
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET' });
          if (response.ok) {
            return;
          }
        } catch {
          // retry until timeout
        }
      }

      await sleep(this.healthIntervalMs);
    }

    throw new Error('NCM health check timeout');
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp <= this.restartWindowMs
    );

    if (this.restartTimestamps.length >= this.restartMaxAttempts) {
      this.status.lastError = `NCM exited too frequently, retries exceeded (${this.restartMaxAttempts}/${this.restartWindowMs}ms)`;
      return;
    }

    this.restartTimestamps.push(now);
    this.status.restartCount = this.restartTimestamps.length;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, this.restartDelayMs);
  }

  private async stopProcessOnly(): Promise<void> {
    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = null;

    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');

      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
        resolve();
      }, 1500);
    });
  }
}

export function resolveNcmLaunchConfig(env: NodeJS.ProcessEnv): NcmLaunchConfig {
  const command = (env.CROSSFADIO_NCM_COMMAND ?? '').trim();
  const args = parseCommandArgs(env.CROSSFADIO_NCM_ARGS ?? '');

  if (command) {
    return {
      command,
      args,
      enabled: true,
      reason: null
    };
  }

  const autoEnabled = env.CROSSFADIO_NCM_DISABLE_AUTO !== '1';
  if (autoEnabled && hasInstalledNcmApi()) {
    return {
      command: 'pnpm',
      args: ['exec', 'NeteaseCloudMusicApi'],
      enabled: true,
      reason: null
    };
  }

  return {
    command: '',
    args: [],
    enabled: false,
    reason: 'NCM launch is not configured (set CROSSFADIO_NCM_COMMAND or install NeteaseCloudMusicApi)'
  };
}

export function parseCommandArgs(args: string): string[] {
  const source = args.trim();
  if (!source) {
    return [];
  }

  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of source) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

function hasInstalledNcmApi(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve('NeteaseCloudMusicApi/package.json');
    return true;
  } catch {
    return false;
  }
}

function normalizePort(rawPort: string | undefined): number {
  const parsed = Number(rawPort ?? '3000');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return 3000;
  }
  return parsed;
}

function normalizeHealthPath(path: string): string {
  if (!path.trim()) {
    return '/';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
