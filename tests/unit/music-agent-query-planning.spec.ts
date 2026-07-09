import { describe, expect, it } from 'vitest';
import {
  autoFillPlaylistQueries,
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
    artistAnchors: [],
    albumAnchors: [],
    playlistQueries: [],
    intentQueries: ['intent'],
    tasteAnchorQueries: ['taste'],
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
  it('limits explore auto-fill song search to exact-track anchors', () => {
    expect(autoFillSearchQueries(context({ discoveryMode: 'explore' }), queryPlan())).toEqual([
      'Track One Artist',
      'Track Two Artist'
    ]);
  });

  it('keeps all exact track anchors in comfort auto-fill without broad query buckets', () => {
    expect(autoFillSearchQueries(context({ discoveryMode: 'comfort' }), queryPlan())).toEqual([
      'Track One Artist',
      'Track Two Artist',
      'Track Three Artist'
    ]);
  });

  it('derives playlist discovery queries from style and language anchors', () => {
    expect(autoFillPlaylistQueries(
      context({
        currentUserText: '下午想听港乐男声，不要太吵',
        recentPreferenceSummary: '最近喜欢粤语、叙事感、低人声'
      }),
      queryPlan({
        playlistQueries: ['港乐 男声'],
        styleHints: ['cantopop'],
        listeningConstraints: ['下午', '男声', '不吵']
      })
    )).toEqual([
      '港乐 男声',
      '港乐 不吵',
      '粤语 男声',
      '粤语 不吵'
    ]);
  });

  it('does not treat English female vocal requests as male vocal playlist queries', () => {
    const queries = autoFillPlaylistQueries(
      context({
        currentUserText: 'late afternoon city pop female vocal, quiet'
      }),
      queryPlan({
        styleHints: ['city pop'],
        listeningConstraints: ['female vocal', 'quiet']
      })
    );

    expect(queries).toContain('city pop 女声');
    expect(queries.some((query) => query.includes('男声'))).toBe(false);
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
