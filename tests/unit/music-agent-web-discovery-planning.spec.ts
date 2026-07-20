import { describe, expect, it } from 'vitest';
import {
  autoFillWebDiscoveryInput,
  compactWebDiscoveryIntent,
  isExplicitWebExploreIntent,
  parseWebDiscoveryFocus,
  parseWebMusicDiscoveryInput,
  selectWebDiscoveryStyle
} from '../../src/server/music-agent/web-discovery-planning';
import type { MusicAgentContextSummary, QueryPlan } from '../../src/server/music-agent/schema';

describe('MusicAgent web discovery planning', () => {
  it('parses tool input with default intent, focus, locale, freshness, anchors, and hint bounds', () => {
    const input = parseWebMusicDiscoveryInput({
      anchors: [{ type: 'style', name: 'cantopop' }],
      maxHints: 99
    }, {
      context: context({ currentUserText: '想找一些粤语新歌' }),
      maxWebDiscoveryHints: 4
    });

    expect(input).toEqual({
      intent: '想找一些粤语新歌',
      focus: 'new_releases',
      anchors: [{ type: 'style', name: 'cantopop' }],
      locale: 'zh-CN',
      freshness: 'recent',
      maxHints: 12
    });
    expect(parseWebDiscoveryFocus('similar_artists', 'ignored')).toBe('similar_artists');
    expect(parseWebDiscoveryFocus('', '类似 The Cardigans 的歌')).toBe('similar_tracks');
    expect(parseWebDiscoveryFocus('', '推荐一些歌手')).toBe('style_artists');
    expect(parseWebDiscoveryFocus('', 'ambient scene overview')).toBe('scene_overview');
  });

  it('builds auto-fill discovery input from the strongest style signal', () => {
    const queryPlan = plan({
      exactTrackQueries: ['My Cookie Can — 卫兰'],
      styleHints: ['dream pop'],
      listeningConstraints: ['不吵']
    });
    const input = autoFillWebDiscoveryInput(context({
      currentUserText: '想听近期港乐新歌',
      activeDirective: '不要太吵'
    }), queryPlan);

    expect(input).toEqual(expect.objectContaining({
      focus: 'style_artists',
      anchors: [{ type: 'style', name: 'cantopop' }],
      locale: 'zh-CN',
      freshness: 'recent',
      maxHints: 8
    }));
    expect(String(input.intent)).toContain('style:cantopop');
    expect(selectWebDiscoveryStyle(context({ currentUserText: '红色高跟鞋 蔡健雅' }), null)).toBe('c-pop');
  });

  it('compacts intent text and detects explicit web exploration requests', () => {
    const longContext = context({
      currentUserText: 'x'.repeat(420),
      actionQueries: ['city pop']
    });
    const compacted = compactWebDiscoveryIntent(longContext, plan({
      exactTrackQueries: ['Track One Artist', 'Track Two Artist', 'Track Three Artist', 'Track Four Artist']
    }), 'city pop');

    expect(compacted.length).toBeLessThanOrEqual(360);
    expect(compacted).toContain('<truncated>');
    expect(isExplicitWebExploreIntent({
      intent: '探索类似 city pop 的新音乐',
      focus: 'scene_overview',
      anchors: [],
      locale: 'zh-CN',
      freshness: 'durable',
      maxHints: 6
    }, context({ currentUserText: '' }))).toBe(true);
    expect(isExplicitWebExploreIntent({
      intent: 'regular background music',
      focus: 'scene_overview',
      anchors: [],
      locale: 'global',
      freshness: 'durable',
      maxHints: 6
    }, context({ currentUserText: '' }))).toBe(false);
  });
});

function context(overrides: Partial<MusicAgentContextSummary>): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
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

function plan(overrides: Partial<QueryPlan>): QueryPlan {
  return {
    exactTrackQueries: [],
    artistAnchors: [],
    albumAnchors: [],
    playlistQueries: [],
    intentQueries: [],
    tasteAnchorQueries: [],
    trendQueries: [],
    explorationQueries: [],
    styleHints: [],
    listeningConstraints: [],
    negativeTerms: [],
    rationale: '',
    ...overrides
  };
}
