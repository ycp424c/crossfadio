import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startLocalServer, type LocalServer } from '../../src/server/http/index';
import { resetConfigForTest } from '../../src/server/config';
import { qrCreateLimiter } from '../../src/server/http/middleware/ip-rate-limit';

const originalEnv = { ...process.env };

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-trust-proxy-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  delete process.env.CROSSFADIO_TRUSTED_PROXY_CIDRS;
  resetConfigForTest();
  qrCreateLimiter._resetForTest();
});

afterEach(async () => {
  qrCreateLimiter._resetForTest();
  process.env = { ...originalEnv };
});

async function startServer(): Promise<LocalServer> {
  return startLocalServer({
    ncm: {
      getStatus: () => ({ running: true })
    } as never,
    ncmAuth: {
      createQr: async () => ({ key: 'key-1', qrimg: 'img', qrurl: 'url' }),
      checkQr: async () => ({ code: 801, hint: 'waiting', message: '等待扫码', hasCookie: false })
    } as never,
    ncmBaseUrl: 'http://localhost:3000',
    host: '127.0.0.1',
    port: 0,
    staticDir: null
  });
}

async function withServer(
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = await startServer();
  try {
    await run(server.baseUrl);
  } finally {
    await server.close();
  }
}

async function getQr(baseUrl: string, forwardedFor: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/ncm/login/qr`, {
    headers: { 'x-forwarded-for': forwardedFor }
  });
  return response.status;
}

describe('trust proxy integration with the QR IP limiter', () => {
  it('isolates rate-limit buckets per X-Forwarded-For client when the socket peer is in the trusted proxy CIDR allowlist', async () => {
    process.env.CROSSFADIO_TRUSTED_PROXY_CIDRS = '127.0.0.1/32';
    resetConfigForTest();

    await withServer(async (baseUrl) => {
      // Client A: 5 allowed, 6th blocked.
      for (let index = 0; index < 5; index += 1) {
        expect(await getQr(baseUrl, '203.0.113.10')).toBe(200);
      }
      expect(await getQr(baseUrl, '203.0.113.10')).toBe(429);
      // Client B (same socket IP, different X-Forwarded-For): its own bucket —
      // the 6th request of A must not have consumed B's budget.
      for (let index = 0; index < 5; index += 1) {
        expect(await getQr(baseUrl, '198.51.100.20')).toBe(200);
      }
      expect(await getQr(baseUrl, '198.51.100.20')).toBe(429);
    });
  });

  it('keeps trusting only the socket IP by default: different X-Forwarded-For clients share one bucket', async () => {
    // CROSSFADIO_TRUSTED_PROXY_CIDRS is unset (empty allowlist) — the header is ignored.
    await withServer(async (baseUrl) => {
      for (let index = 0; index < 5; index += 1) {
        expect(await getQr(baseUrl, `203.0.113.${10 + index}`)).toBe(200);
      }
      // The sixth request is blocked even with a brand-new X-Forwarded-For
      // value, proving the header was never trusted.
      expect(await getQr(baseUrl, '198.51.100.99')).toBe(429);
    });
  });

  it('fails closed on an invalid trusted proxy CIDR: server start rejects instead of trusting blindly', async () => {
    process.env.CROSSFADIO_TRUSTED_PROXY_CIDRS = '127.0.0.1/32,not-an-ip';
    resetConfigForTest();

    await expect(startServer()).rejects.toThrow(/CROSSFADIO_TRUSTED_PROXY_CIDRS/);
  });
});
