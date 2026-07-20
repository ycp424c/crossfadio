import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() })
}));

beforeEach(() => {
  vi.resetModules();
  loggerWarn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(id: string | null) {
  return {
    searchSongs: vi.fn().mockResolvedValue(id ? [{ id, name: 'Test Song', artists: ['Test Artist'] }] : [])
  };
}

describe('resolveTrackQuery', () => {
  it('returns ncmId for found track', async () => {
    const { resolveTrackQuery, clearResolverCache } = await import('../../src/server/ncm/resolver');
    clearResolverCache();
    const client = makeClient('42');
    const result = await resolveTrackQuery('some song', client as never);
    expect(result?.ncmId).toBe('42');
    expect(client.searchSongs).toHaveBeenCalledTimes(1);
  });

  it('returns null when no results', async () => {
    const { resolveTrackQuery, clearResolverCache } = await import('../../src/server/ncm/resolver');
    clearResolverCache();
    const client = makeClient(null);
    const result = await resolveTrackQuery('missing song', client as never);
    expect(result).toBeNull();
  });

  it('caches the result on second call', async () => {
    const { resolveTrackQuery, clearResolverCache } = await import('../../src/server/ncm/resolver');
    clearResolverCache();
    const client = makeClient('99');
    await resolveTrackQuery('cached song', client as never);
    await resolveTrackQuery('cached song', client as never);
    expect(client.searchSongs).toHaveBeenCalledTimes(1);
  });

  it('returns null on client error', async () => {
    const { resolveTrackQuery, clearResolverCache } = await import('../../src/server/ncm/resolver');
    clearResolverCache();
    const client = { searchSongs: vi.fn().mockRejectedValue(new Error('network')) };
    const result = await resolveTrackQuery('bad song', client as never);
    expect(result).toBeNull();
  });
});

describe('resolveTrackIdentity', () => {
  it('logs only a stable error code and query hash when the provider fails', async () => {
    const { resolveTrackIdentity } = await import('../../src/server/ncm/resolver');
    const client = {
      searchSongs: vi.fn().mockRejectedValue(Object.assign(
        new Error('PRIVATE provider echo: Secret Ban Song by Private Artist'),
        {
          status: 502,
          responseBody: '{"echo":"PRIVATE provider response"}'
        }
      ))
    };

    await expect(resolveTrackIdentity({
      title: 'Secret Ban Song',
      artist: 'Private Artist'
    }, client as never)).resolves.toEqual({ status: 'unavailable' });

    expect(loggerWarn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(loggerWarn.mock.calls);
    expect(logged).toContain('provider_server_error');
    expect(logged).toMatch(/queryHash[^a-f0-9]+[a-f0-9]{64}/i);
    expect(logged).not.toContain('Secret Ban Song');
    expect(logged).not.toContain('Private Artist');
    expect(logged).not.toContain('PRIVATE');
    expect(logged).not.toContain('responseBody');
  });

  it('keeps a title-only lookup ambiguous when multiple exact tracks match', async () => {
    const { resolveTrackIdentity } = await import('../../src/server/ncm/resolver');
    const client = {
      searchSongs: vi.fn().mockResolvedValue([
        { id: '1', name: 'Hello', artists: ['Adele'] },
        { id: '2', name: 'Hello', artists: ['Lionel Richie'] }
      ])
    };

    await expect(resolveTrackIdentity({ title: 'Ｈｅｌｌｏ' }, client as never)).resolves.toEqual({
      status: 'ambiguous'
    });
    expect(client.searchSongs).toHaveBeenCalledWith('Ｈｅｌｌｏ', 10);
  });

  it('uses the artist to select one exact identity among same-title candidates', async () => {
    const { resolveTrackIdentity } = await import('../../src/server/ncm/resolver');
    const client = {
      searchSongs: vi.fn().mockResolvedValue([
        { id: '1', name: 'Hello', artists: ['Adele'] },
        { id: '2', name: 'Hello', artists: ['Lionel Richie'] }
      ])
    };

    await expect(resolveTrackIdentity({
      title: ' hello ',
      artist: 'ＡＤＥＬＥ'
    }, client as never)).resolves.toEqual({
      status: 'resolved',
      track: { ncmId: '1', name: 'Hello', artists: ['Adele'] }
    });
  });

  it('does not turn a fuzzy search result into a hard identity', async () => {
    const { resolveTrackIdentity } = await import('../../src/server/ncm/resolver');
    const client = {
      searchSongs: vi.fn().mockResolvedValue([
        { id: '1', name: 'Hello (Live)', artists: ['Adele'] }
      ])
    };

    await expect(resolveTrackIdentity({ title: 'Hello' }, client as never)).resolves.toEqual({
      status: 'not_found'
    });
  });

  it('keeps duplicate provider versions ambiguous even when title and artist match', async () => {
    const { resolveTrackIdentity } = await import('../../src/server/ncm/resolver');
    const client = {
      searchSongs: vi.fn().mockResolvedValue([
        { id: '1', name: 'Hello', artists: ['Adele'] },
        { id: '2', name: 'Hello', artists: ['Adele'] }
      ])
    };

    await expect(resolveTrackIdentity({
      title: 'Hello',
      artist: 'Adele'
    }, client as never)).resolves.toEqual({ status: 'ambiguous' });
  });
});
