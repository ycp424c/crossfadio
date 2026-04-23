import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { NcmAuthService } from '../../src/main/ncm/auth';
import { NcmClient } from '../../src/main/ncm/client';
import { NCM_QR_CODE } from '../../src/shared/schema';

const runRealSmoke = process.env.CROSSFADIO_REAL_NCM_SMOKE === '1';
const proxy = process.env.CROSSFADIO_REAL_NCM_PROXY ?? 'http://127.0.0.1:7897';
const port = Number(process.env.CROSSFADIO_REAL_NCM_PORT ?? '3699');
const baseUrl = `http://127.0.0.1:${port}`;

let proc: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  if (!proc) {
    return;
  }
  await stopProcess(proc);
  proc = null;
});

describe.skipIf(!runRealSmoke)('NCM real smoke', () => {
  it('runs qr key/create/check through NcmClient and NcmAuthService', async () => {
    proc = spawn('pnpm', ['exec', 'NeteaseCloudMusicApi'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(port),
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1'
      }
    });

    await waitUntilReady(baseUrl);

    const secretMemory = new Map<string, string>();
    const secrets = {
      get: (key: string) => secretMemory.get(key) ?? null,
      set: (key: string, value: string) => {
        secretMemory.set(key, value);
      },
      remove: (key: string) => {
        secretMemory.delete(key);
      }
    };

    const client = new NcmClient(baseUrl);
    const auth = new NcmAuthService(client as any, secrets as any);

    const qr = await auth.createQr();
    expect(qr.key.length).toBeGreaterThan(10);
    expect(qr.qrimg.startsWith('data:image/')).toBe(true);

    const status = await auth.checkQr(qr.key);
    expect([NCM_QR_CODE.WAITING, NCM_QR_CODE.SCANNED, NCM_QR_CODE.EXPIRED]).toContain(status.code);
    expect(status.hint).toBeTypeOf('string');
    expect(status.message.length).toBeGreaterThan(0);
  }, 60_000);
});

async function waitUntilReady(url: string): Promise<void> {
  const start = Date.now();
  const timeoutMs = 20_000;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // keep retrying
    }

    await sleep(300);
  }

  throw new Error('real NCM smoke timeout: service not ready');
}

async function stopProcess(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    processRef.once('exit', () => resolve());
    processRef.kill('SIGTERM');
    setTimeout(() => {
      if (!processRef.killed) {
        processRef.kill('SIGKILL');
      }
      resolve();
    }, 1500);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
