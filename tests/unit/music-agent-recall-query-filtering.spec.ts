import { describe, expect, it } from 'vitest';
import {
  filterAvoidedQueries,
  filterExactSongSearchQueries,
  formatNoExecutableQueryReason,
  isExactSongSearchQuery,
  prepareRecallQueryEligibility,
  SEMANTIC_ONLY_QUERY_PROBLEM
} from '../../src/server/music-agent/recall-query-filtering';

describe('MusicAgent recall query filtering', () => {
  it('filters recently avoided artists before exact-track eligibility', () => {
    expect(filterAvoidedQueries(
      ['Love Story Taylor Swift', 'Fresh City Fresh Artist', '生涯规划 — 卫兰'],
      new Set(['taylor swift', '卫兰'])
    )).toEqual({
      queries: ['Fresh City Fresh Artist'],
      skipped: 2
    });

    expect(prepareRecallQueryEligibility(
      [' Love   Story Taylor Swift ', '午后流行女声', 'Fresh City Fresh Artist'],
      new Set(['taylor swift'])
    )).toEqual({
      sanitizedQueries: ['Love Story Taylor Swift', '午后流行女声', 'Fresh City Fresh Artist'],
      artistFilteredQueries: ['午后流行女声', 'Fresh City Fresh Artist'],
      exactTrackQueries: ['Fresh City Fresh Artist'],
      skippedAvoidedQueries: 1,
      skippedSemanticQueries: 1
    });
  });

  it('keeps exact song searches and rejects semantic-only prompts', () => {
    expect(isExactSongSearchQuery('红色高跟鞋 — 蔡健雅')).toBe(true);
    expect(isExactSongSearchQuery('Fresh City Fresh Artist')).toBe(true);
    expect(isExactSongSearchQuery('only lowercase words')).toBe(true);
    expect(isExactSongSearchQuery('粤语流行 女声 工作间隙放松')).toBe(false);
    expect(isExactSongSearchQuery('city pop afternoon female vocal')).toBe(false);
    expect(isExactSongSearchQuery('artist: song')).toBe(false);
    expect(isExactSongSearchQuery('single')).toBe(false);
    expect(isExactSongSearchQuery('one two three four five six seven eight nine')).toBe(false);

    expect(filterExactSongSearchQueries([
      '红色高跟鞋 — 蔡健雅',
      'city pop afternoon female vocal',
      'Fresh City Fresh Artist'
    ])).toEqual({
      queries: ['红色高跟鞋 — 蔡健雅', 'Fresh City Fresh Artist'],
      skipped: 1
    });
  });

  it('keeps no-query reason labels stable for route diagnostics', () => {
    expect(SEMANTIC_ONLY_QUERY_PROBLEM).toBe('skipped semantic-only queries; use semantic discovery before NCM song search');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 0,
      sanitizedQueryCount: 0,
      artistFilteredQueryCount: 0,
      skippedAvoidedQueries: 0,
      skippedSemanticQueries: 0
    })).toBe('query plan empty');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 0,
      artistFilteredQueryCount: 0,
      skippedAvoidedQueries: 0,
      skippedSemanticQueries: 0
    })).toBe('queries sanitized to empty');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 1,
      sanitizedQueryCount: 1,
      artistFilteredQueryCount: 0,
      skippedAvoidedQueries: 1,
      skippedSemanticQueries: 0
    })).toBe('all queries skipped for recently repeated artists');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 2,
      artistFilteredQueryCount: 2,
      skippedAvoidedQueries: 0,
      skippedSemanticQueries: 2
    })).toBe('all queries skipped as semantic-only');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 3,
      sanitizedQueryCount: 3,
      artistFilteredQueryCount: 3,
      skippedAvoidedQueries: 0,
      skippedSemanticQueries: 1
    })).toBe('1 semantic-only queries skipped');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 2,
      artistFilteredQueryCount: 2,
      skippedAvoidedQueries: 0,
      skippedSemanticQueries: 0
    })).toBe('no exact-track search queries available');
  });
});
