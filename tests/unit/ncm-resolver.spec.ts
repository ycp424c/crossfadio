import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(id: string | null) {
  return {
    searchSongs: vi.fn().mockResolvedValue(id ? [{ id }] : [])
  };
}

describe('resolveTrackQuery', () => {
  it('returns ncmId for found track', async () => {
    const { resolveTrackQuery, clearResolverCache } = await import('../../src/server/ncm/resolver');
    clearResolverCache();
    const client = makeClient('42');
    const result = await resolveTrackQuery('some song', client as never);
    expect(result).toBe('42');
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
