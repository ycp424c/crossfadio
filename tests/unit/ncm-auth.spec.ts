import { describe, expect, it, vi } from 'vitest';
import { NcmAuthService } from '../../src/main/ncm/auth';

describe('NcmAuthService', () => {
  it('stores cookie when qr check succeeds with code 803', async () => {
    const client = {
      createLoginQr: vi.fn(),
      checkLoginQr: vi.fn().mockResolvedValue({
        code: 803,
        message: 'authorized',
        cookie: 'MUSIC_U=abc;'
      }),
      getLoginStatus: vi.fn().mockResolvedValue({ data: { profile: { nickname: 'justyn' } } }),
      logout: vi.fn()
    };

    const secrets = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      remove: vi.fn()
    };

    const service = new NcmAuthService(client as any, secrets as any);

    const qrResult = await service.checkQr('key-1');
    expect(qrResult.code).toBe(803);
    expect(qrResult.hasCookie).toBe(true);
    expect(secrets.set).toHaveBeenCalledWith('ncm.cookie', 'MUSIC_U=abc;');

    const session = await service.getSession();
    expect(session.hasCookie).toBe(true);
    expect((session.profile as { nickname: string }).nickname).toBe('justyn');
  });

  it('clears cookie and secret on logout', async () => {
    const client = {
      createLoginQr: vi.fn(),
      checkLoginQr: vi.fn(),
      getLoginStatus: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined)
    };

    const secrets = {
      get: vi.fn().mockReturnValue('MUSIC_U=old;'),
      set: vi.fn(),
      remove: vi.fn()
    };

    const service = new NcmAuthService(client as any, secrets as any);

    await service.logout();

    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(secrets.remove).toHaveBeenCalledWith('ncm.cookie');
    expect(service.getCookie()).toBe(null);
  });
});
