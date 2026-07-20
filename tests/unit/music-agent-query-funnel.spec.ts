import { describe, expect, it, vi } from 'vitest';
import {
  createQueryFunnelState,
  queryFunnelSnapshot,
  recordFinalQueryFunnel,
  recordQueryFunnelSearch,
  searchRunKey,
  trackResultKey
} from '../../src/server/music-agent/query-funnel';

describe('MusicAgent query funnel', () => {
  it('counts repeated query addedCount as unique admitted candidates', () => {
    const state = createQueryFunnelState();
    const pool = { has: (id: string) => id === 'same-id' || id === 'new-id' };

    recordQueryFunnelSearch(state, {
      query: 'Same Song Same Artist',
      source: 'search',
      tracks: [
        { id: 'same-id', name: 'Same Song', artists: ['Same Artist'] },
        { id: 'same-id', name: 'Same Song', artists: ['Same Artist'] }
      ],
      resultCount: 2,
      addedCount: 1,
      pool
    });
    recordQueryFunnelSearch(state, {
      query: 'Same   Song Same Artist',
      source: 'search',
      tracks: [
        { id: 'same-id', name: 'Same Song', artists: ['Same Artist'] },
        { id: 'new-id', name: 'New Song', artists: ['Same Artist'] }
      ],
      resultCount: 2,
      addedCount: 2,
      pool
    });

    expect(queryFunnelSnapshot(state)).toEqual([
      expect.objectContaining({
        query: 'Same Song Same Artist',
        normalizedQuery: 'same song same artist',
        searchedCount: 2,
        resultCount: 4,
        uniqueResultCount: 2,
        addedCount: 2
      })
    ]);
  });

  it('persists selected counts through the provided recorder', () => {
    const attemptedAt = new Date('2026-07-17T03:00:00.000Z');
    const state = createQueryFunnelState({
      runId: 'run-1',
      requestKind: 'autonomous',
      attemptedAt,
    });
    const recorder = vi.fn();

    recordQueryFunnelSearch(state, {
      query: 'Sky Singer',
      source: 'search',
      tracks: [{ id: 'sky-1', name: 'Sky One', artists: ['Sky Singer'] }],
      resultCount: 1,
      addedCount: 1,
      pool: { has: (id) => id === 'sky-1' }
    });
    recordFinalQueryFunnel('user-1', state, [{ id: 'sky-1' }], recorder);

    expect(recorder).toHaveBeenCalledWith({
      userId: 'user-1',
      runId: 'run-1',
      requestKind: 'autonomous',
      attemptedAt,
      entries: [expect.objectContaining({ selectedCount: 1 })],
    });
  });

  it('normalizes search run keys independently of source and falls back for tracks without ids', () => {
    expect(searchRunKey('search', '  Sky   Singer ', 8)).toBe('sky singer');
    expect(searchRunKey('trend', 'Sky Singer', 1)).toBe('sky singer');
    expect(trackResultKey({ name: 'No Id', artists: ['Artist'] }, 3)).toBe('no id::artist::3');
  });
});
