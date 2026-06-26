import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchArtistsForStyle: vi.fn()
}));

vi.mock('../../src/server/web-search.js', () => ({
  searchArtistsForStyle: mocks.searchArtistsForStyle
}));

describe('default web music discovery provider', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.searchArtistsForStyle.mockReset();
  });

  it('uses explicit style anchors and filters hard mismatched public artist hints', async () => {
    mocks.searchArtistsForStyle.mockResolvedValue([
      'Slipknot',
      'Madness',
      'The Hooters',
      'The Tragically Hip',
      'Drive-By Truckers'
    ]);

    const { createDefaultWebMusicDiscoveryProvider } = await import('../../src/server/music-agent/web-discovery.js');
    const provider = createDefaultWebMusicDiscoveryProvider();

    const hints = await provider.discover({
      intent: '探索一些适合现在的粤语/港乐',
      focus: 'style_artists',
      anchors: [{ type: 'style', name: 'cantopop' }],
      locale: 'zh-CN',
      freshness: 'durable',
      maxHints: 3
    });

    expect(mocks.searchArtistsForStyle).toHaveBeenCalledWith('cantopop');
    expect(hints).toHaveLength(3);
    expect(hints.map((hint) => hint.name)).not.toContain('Slipknot');
    expect(hints.every((hint) => hint.kind === 'artist')).toBe(true);
    expect(hints.every((hint) => hint.styles.includes('cantopop'))).toBe(true);
    expect(hints.every((hint) => hint.confidence >= 0.7)).toBe(true);
  });
});
