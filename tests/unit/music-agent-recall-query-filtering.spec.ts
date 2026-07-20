import { describe, expect, it } from 'vitest';
import {
  filterExactSongSearchQueries,
  formatNoExecutableQueryReason,
  isExactSongSearchQuery,
  prepareRecallQueryEligibility,
  SEMANTIC_ONLY_QUERY_PROBLEM
} from '../../src/server/music-agent/recall-query-filtering';

describe('MusicAgent recall query filtering', () => {
  it('keeps artist-bearing exact-track queries for phase-aware Policy evaluation', () => {
    expect(prepareRecallQueryEligibility(
      [' Love   Story Taylor Swift ', '午后流行女声', 'Fresh City Fresh Artist']
    )).toEqual({
      sanitizedQueries: ['Love Story Taylor Swift', '午后流行女声', 'Fresh City Fresh Artist'],
      exactTrackQueries: ['Love Story Taylor Swift', 'Fresh City Fresh Artist'],
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
      skippedSemanticQueries: 0
    })).toBe('query plan empty');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 0,
      skippedSemanticQueries: 0
    })).toBe('queries sanitized to empty');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 2,
      skippedSemanticQueries: 2
    })).toBe('all queries skipped as semantic-only');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 3,
      sanitizedQueryCount: 3,
      skippedSemanticQueries: 1
    })).toBe('1 semantic-only queries skipped');
    expect(formatNoExecutableQueryReason({
      inputQueryCount: 2,
      sanitizedQueryCount: 2,
      skippedSemanticQueries: 0
    })).toBe('no exact-track search queries available');
  });
});
