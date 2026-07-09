import { describe, expect, it } from 'vitest';
import {
  defaultWebDiscoveryFreshness,
  defaultWebDiscoveryLocale,
  filterWebDiscoveryHintsForRecall,
  isHardMismatchedWebArtist,
  objectArrayValue,
  parseMusicEntityHints,
  webDiscoveryIntentText,
  webHintArtistName
} from '../../src/server/music-agent/web-discovery-hints';
import type { MusicAgentContextSummary, MusicEntityHint } from '../../src/server/music-agent/schema';

describe('MusicAgent web discovery hints', () => {
  it('parses sourced hints with invalid-hint diagnostics and a valid-hint limit', () => {
    const result = parseMusicEntityHints([
      { kind: 'artist', name: 'Missing Source' },
      sourcedHint({ kind: 'artist', name: 'First Artist' }),
      sourcedHint({ kind: 'track', name: 'Second Track', artist: 'Second Artist' })
    ], 1);

    expect(result.hints.map((hint) => hint.name)).toEqual(['First Artist']);
    expect(result.problems).toEqual(['web hint skipped: invalid sourced hint']);
  });

  it('filters avoided artists and hard style mismatches while preserving invalid raw hints for later diagnostics', () => {
    const invalidHint = { kind: 'artist', name: 'Invalid Raw Hint' };
    const result = filterWebDiscoveryHintsForRecall([
      sourcedHint({ kind: 'artist', name: 'Repeated Singer' }),
      sourcedHint({ kind: 'relationship', name: 'Scene Link', relatedName: 'Ben Howard' }),
      sourcedHint({ kind: 'artist', name: 'Slipknot', styles: ['cantopop'] }),
      sourcedHint({ kind: 'track', name: 'Fresh Song', artist: 'Fresh Singer', styles: ['cantopop'] }),
      invalidHint
    ], {
      avoidArtists: new Set(['repeated singer', 'ben howard']),
      expectedStyle: 'cantopop'
    });

    expect(result.hints).toEqual([
      expect.objectContaining({ name: 'Fresh Song' }),
      invalidHint
    ]);
    expect(result.problems).toEqual([
      'web hint skipped: recently repeated artist Repeated Singer',
      'web hint skipped: recently repeated artist Ben Howard',
      'web hint skipped: hard style mismatch for Slipknot'
    ]);
    expect(isHardMismatchedWebArtist('Slipknot', 'cantopop')).toBe(true);
    expect(isHardMismatchedWebArtist('Slipknot', 'heavy metal')).toBe(false);
  });

  it('keeps only plain objects when reading raw hint arrays', () => {
    const plainObject = { kind: 'artist', name: 'Plain Object' };
    expect(objectArrayValue([plainObject, null, ['nested'], 'text', 1])).toEqual([plainObject]);
    expect(objectArrayValue({ kind: 'artist' })).toEqual([]);
  });

  it('derives default discovery intent, locale, freshness, and recall artist names', () => {
    const zhContext = context({
      currentUserText: '想找一些粤语新歌',
      actionQueries: ['卫兰'],
      activeDirective: '不要太吵',
    });
    const globalContext = context({ currentUserText: 'recent indie folk releases' });

    expect(webDiscoveryIntentText(zhContext)).toBe('想找一些粤语新歌 卫兰 不要太吵');
    expect(defaultWebDiscoveryLocale(zhContext)).toBe('zh-CN');
    expect(defaultWebDiscoveryLocale(globalContext)).toBe('global');
    expect(defaultWebDiscoveryFreshness('recent indie folk releases')).toBe('recent');
    expect(defaultWebDiscoveryFreshness('durable city pop scene')).toBe('durable');
    expect(webHintArtistName(sourcedHint({ kind: 'relationship', name: 'Scene', relatedName: 'Related Artist' }))).toBe('Related Artist');
    expect(webHintArtistName(sourcedHint({ kind: 'track', name: 'Track', artist: 'Track Artist' }))).toBe('Track Artist');
  });
});

function sourcedHint(overrides: Partial<MusicEntityHint> & { kind: MusicEntityHint['kind']; name: string }): MusicEntityHint {
  return {
    kind: overrides.kind,
    name: overrides.name,
    styles: [],
    sourceUrl: 'https://example.com/source',
    sourceTitle: 'source title',
    snippet: 'source snippet',
    confidence: 0.8,
    freshness: 'durable',
    observedAt: '2026-06-26T00:00:00.000Z',
    ...overrides
  } as MusicEntityHint;
}

function context(overrides: Partial<MusicAgentContextSummary>): MusicAgentContextSummary {
  return {
    request: 'chat-recommend',
    currentUserText: '',
    currentMoment: { localTime: '周五 15:00', daypart: '下午', weather: null },
    activeDirective: '',
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}
