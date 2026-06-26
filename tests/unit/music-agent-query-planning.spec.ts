import { describe, expect, it } from 'vitest';
import {
  autoFillSearchQueries,
  styleExpansionQueries,
  styleSeedQueryModifiers
} from '../../src/server/music-agent/query-planning';
import type { MusicAgentContextSummary, QueryPlan } from '../../src/server/music-agent/schema';

function context(overrides: Partial<MusicAgentContextSummary> = {}): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
    currentUserText: '想听轻快一点的女声 city pop',
    currentMoment: {
      localTime: '2026-06-26T15:00:00+08:00',
      daypart: 'afternoon',
      weather: null,
      dailyTheme: null
    },
    activeDirective: '',
    currentPlanSegment: null,
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}

function queryPlan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    exactTrackQueries: ['Track One Artist', 'Track Two Artist', 'Track Three Artist'],
    intentQueries: ['intent'],
    tasteAnchorQueries: ['taste'],
    planQueries: ['plan'],
    trendQueries: [],
    explorationQueries: ['explore'],
    styleHints: [],
    listeningConstraints: [],
    avoidArtists: [],
    negativeTerms: [],
    rationale: '',
    ...overrides
  };
}

describe('MusicAgent query planning', () => {
  it('limits exact track anchors in explore auto-fill before adding broader query buckets', () => {
    expect(autoFillSearchQueries(context({ discoveryMode: 'explore' }), queryPlan())).toEqual([
      'Track One Artist',
      'Track Two Artist',
      'intent',
      'taste',
      'plan',
      'explore'
    ]);
  });

  it('keeps all exact track anchors in comfort auto-fill', () => {
    expect(autoFillSearchQueries(context({ discoveryMode: 'comfort' }), queryPlan())).toEqual([
      'Track One Artist',
      'Track Two Artist',
      'Track Three Artist',
      'intent',
      'taste',
      'plan',
      'explore'
    ]);
  });

  it('derives deterministic style modifiers from user text', () => {
    expect(styleSeedQueryModifiers('女声 粤语 不要太吵 synth')).toEqual(['synth', '女声', '粤语', '不吵']);
    expect(styleSeedQueryModifiers('plain afternoon request')).toEqual(['中低能量']);
  });

  it('keeps explicit style expansion queries first and filters excluded queries', () => {
    const queries = styleExpansionQueries(
      context({ currentUserText: 'city pop 女声 下午' }),
      {
        queries: ['city pop 女声'],
        excludeQueries: ['city pop 女声']
      }
    );

    expect(queries).not.toContain('city pop 女声');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(8);
  });
});
