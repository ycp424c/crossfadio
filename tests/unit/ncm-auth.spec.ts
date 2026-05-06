import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NCM_QR_CODE } from '../../src/shared/schema';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalJwtSecret = process.env.CROSSFADIO_JWT_SECRET;

let dataDir: string;

type ClientMock = {
  createLoginQr: ReturnType<typeof vi.fn>;
  checkLoginQr: ReturnType<typeof vi.fn>;
  getLoginStatus: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  withCookie: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<ClientMock> = {}): ClientMock {
  const client = {
    createLoginQr: vi.fn(),
    checkLoginQr: vi.fn(),
    getLoginStatus: vi.fn(),
    logout: vi.fn(),
    withCookie: vi.fn(),
    ...overrides
  };
  client.withCookie.mockReturnValue(client);
  return client;
}

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-auth-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
  process.env.CROSSFADIO_LLM_BASE_URL = 'http://localhost:8080/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'gpt-test';
  process.env.CROSSFADIO_TTS_BASE_URL = 'http://localhost:8080/tts';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  const { initDb } = await import('../../src/server/store/db');
  const { loadAllowlist } = await import('../../src/server/allowlist');
  const { resetConfigForTest } = await import('../../src/server/config');
  resetConfigForTest();
  initDb();
  // Create empty allowlist
  fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '[]');
  loadAllowlist();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  if (originalJwtSecret === undefined) delete process.env.CROSSFADIO_JWT_SECRET;
  else process.env.CROSSFADIO_JWT_SECRET = originalJwtSecret;
});

describe('NcmAuthService.checkQr', () => {
  // Uses dynamic import because NcmAuthService transitively depends on DB store modules
  // which must be loaded afresh after vi.resetModules() reinitializes the DB singleton.
  async function createService(client: ClientMock) {
    const { NcmAuthService } = await import('../../src/server/ncm/auth');
    return new NcmAuthService(client as any);
  }

  it('returns waiting hint on 801 without persisting cookie', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 801, message: '', cookie: null })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-801');

    expect(result).toEqual({
      code: NCM_QR_CODE.WAITING,
      hint: 'waiting',
      hasCookie: false,
      message: '等待扫码'
    });
  });

  it('returns scanned hint on 802 without cookie', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 802, message: '', cookie: null })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-802');

    expect(result.code).toBe(NCM_QR_CODE.SCANNED);
    expect(result.hint).toBe('scanned');
    expect(result.hasCookie).toBe(false);
  });

  it('returns expired hint on 800', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 800, message: '', cookie: null })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-800');

    expect(result.code).toBe(NCM_QR_CODE.EXPIRED);
    expect(result.hint).toBe('expired');
  });

  it('does not authorize when code 803 missing cookie payload', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 803, message: 'ok', cookie: null })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-803-missing');

    expect(result.code).toBe(NCM_QR_CODE.AUTHORIZED);
    expect(result.hasCookie).toBe(false);
  });

  it('degrades unknown numeric codes to expired', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 999, message: 'weird', cookie: null })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-unknown');

    expect(result.code).toBe(NCM_QR_CODE.EXPIRED);
    expect(result.hint).toBe('expired');
  });

  it('returns JWT token and persists user on authorized with whitelisted ncmId', async () => {
    // Add test user to allowlist
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["12345"]');
    const { loadAllowlist } = await import('../../src/server/allowlist');
    loadAllowlist();

    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({
        code: 803,
        message: 'authorized',
        cookie: 'MUSIC_U=abc;'
      }),
      getLoginStatus: vi.fn().mockResolvedValue({
        data: { profile: { userId: 12345, nickname: 'justyn' } }
      })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-803');

    expect(result.code).toBe(NCM_QR_CODE.AUTHORIZED);
    expect(result.hint).toBe('authorized');
    expect(result.hasCookie).toBe(true);
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe('string');
    expect(result.token!.length).toBeGreaterThan(10);
    expect(client.withCookie).toHaveBeenCalledWith('MUSIC_U=abc;');
  });

  it('returns forbidden when ncmId not in allowlist', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({
        code: 803,
        message: 'authorized',
        cookie: 'MUSIC_U=abc;'
      }),
      getLoginStatus: vi.fn().mockResolvedValue({
        data: { profile: { userId: 99999, nickname: 'stranger' } }
      })
    });
    const service = await createService(client);

    const result = await service.checkQr('key-803-blocked');

    expect(result.code).toBe(NCM_QR_CODE.AUTHORIZED);
    expect(result.hint).toBe('forbidden');
    expect(result.hasCookie).toBe(false);
    expect(result.token).toBeUndefined();
  });
});
