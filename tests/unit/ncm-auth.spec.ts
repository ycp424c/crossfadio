import { describe, expect, it, vi } from 'vitest';
import { NcmAuthService } from '../../src/main/ncm/auth';
import { NCM_QR_CODE } from '../../src/shared/schema';

type ClientMock = {
  createLoginQr: ReturnType<typeof vi.fn>;
  checkLoginQr: ReturnType<typeof vi.fn>;
  getLoginStatus: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

type SecretsMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<ClientMock> = {}): ClientMock {
  return {
    createLoginQr: vi.fn(),
    checkLoginQr: vi.fn(),
    getLoginStatus: vi.fn(),
    logout: vi.fn(),
    ...overrides
  };
}

function makeSecrets(initial: string | null = null): SecretsMock {
  return {
    get: vi.fn().mockReturnValue(initial),
    set: vi.fn(),
    remove: vi.fn()
  };
}

describe('NcmAuthService.checkQr', () => {
  it('returns waiting hint on 801 without persisting cookie', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 801, message: '', cookie: null })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-801');

    expect(result).toEqual({
      code: NCM_QR_CODE.WAITING,
      hint: 'waiting',
      hasCookie: false,
      message: '等待扫码'
    });
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('returns scanned hint on 802 without cookie', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 802, message: '', cookie: null })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-802');

    expect(result.code).toBe(NCM_QR_CODE.SCANNED);
    expect(result.hint).toBe('scanned');
    expect(result.hasCookie).toBe(false);
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('returns expired hint on 800', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 800, message: '', cookie: null })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-800');

    expect(result.code).toBe(NCM_QR_CODE.EXPIRED);
    expect(result.hint).toBe('expired');
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('stores cookie on 803 authorized', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({
        code: 803,
        message: 'authorized',
        cookie: 'MUSIC_U=abc;'
      }),
      getLoginStatus: vi.fn().mockResolvedValue({ data: { profile: { nickname: 'justyn' } } })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-803');

    expect(result.code).toBe(NCM_QR_CODE.AUTHORIZED);
    expect(result.hint).toBe('authorized');
    expect(result.hasCookie).toBe(true);
    expect(secrets.set).toHaveBeenCalledWith('ncm.cookie', 'MUSIC_U=abc;');

    const session = await service.getSession();
    expect(session.hasCookie).toBe(true);
    expect((session.profile as { nickname: string }).nickname).toBe('justyn');
  });

  it('does not persist cookie when code 803 missing cookie payload', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 803, message: 'ok', cookie: null })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-803-missing');

    expect(result.code).toBe(NCM_QR_CODE.AUTHORIZED);
    expect(result.hasCookie).toBe(false);
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('degrades unknown numeric codes to expired', async () => {
    const client = makeClient({
      checkLoginQr: vi.fn().mockResolvedValue({ code: 999, message: 'weird', cookie: null })
    });
    const secrets = makeSecrets();
    const service = new NcmAuthService(client as any, secrets as any);

    const result = await service.checkQr('key-unknown');

    expect(result.code).toBe(NCM_QR_CODE.EXPIRED);
    expect(result.hint).toBe('expired');
  });
});

describe('NcmAuthService.logout', () => {
  it('clears cookie and secret on logout', async () => {
    const client = makeClient({ logout: vi.fn().mockResolvedValue(undefined) });
    const secrets = makeSecrets('MUSIC_U=old;');
    const service = new NcmAuthService(client as any, secrets as any);

    await service.logout();

    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(secrets.remove).toHaveBeenCalledWith('ncm.cookie');
    expect(service.getCookie()).toBe(null);
  });

  it('still clears local secret when upstream logout throws', async () => {
    const client = makeClient({ logout: vi.fn().mockRejectedValue(new Error('network')) });
    const secrets = makeSecrets('MUSIC_U=old;');
    const service = new NcmAuthService(client as any, secrets as any);

    await expect(service.logout()).rejects.toThrow('network');
    expect(secrets.remove).toHaveBeenCalledWith('ncm.cookie');
    expect(service.getCookie()).toBe(null);
  });
});
