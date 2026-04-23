import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app } from 'electron';

export type NcmStatus = {
  enabled: boolean;
  running: boolean;
  baseUrl: string;
  pid: number | null;
  lastError: string | null;
  startedAt: string | null;
};

export class NcmProcessManager {
  private readonly command: string;
  private readonly args: string[];
  private readonly baseUrl: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private status: NcmStatus;
  private shouldStop = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.command = process.env.CROSSFADIO_NCM_COMMAND ?? '';
    this.args = splitArgs(process.env.CROSSFADIO_NCM_ARGS ?? '');
    const port = Number(process.env.CROSSFADIO_NCM_PORT ?? '3000');
    this.baseUrl = `http://127.0.0.1:${port}`;

    this.status = {
      enabled: Boolean(this.command),
      running: false,
      baseUrl: this.baseUrl,
      pid: null,
      lastError: this.command ? null : 'CROSSFADIO_NCM_COMMAND is not configured',
      startedAt: null
    };
  }

  async start(): Promise<void> {
    if (!this.status.enabled || this.process) {
      return;
    }
    this.shouldStop = false;

    const userData = app.getPath('userData');

    this.process = spawn(this.command, this.args, {
      cwd: userData,
      env: {
        ...process.env,
        PORT: this.baseUrl.split(':').pop() ?? '3000'
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

    await this.waitForHealth();
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

    this.status.running = false;
    this.status.pid = null;
  }

  getStatus(): NcmStatus {
    return { ...this.status };
  }

  private async waitForHealth(): Promise<void> {
    const startAt = Date.now();
    const timeoutMs = 8_000;

    while (Date.now() - startAt < timeoutMs) {
      try {
        const response = await fetch(`${this.baseUrl}/health`, { method: 'GET' });
        if (response.ok) {
          return;
        }
      } catch {
        // retry until timeout
      }

      await sleep(300);
    }

    this.status.lastError = 'NCM health check timeout';
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1_000);
  }
}

function splitArgs(args: string): string[] {
  if (!args.trim()) {
    return [];
  }

  return args
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
