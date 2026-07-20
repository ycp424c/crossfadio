import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-retrieval-history-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Retrieval History', () => {
  it('append-only 记录一次完整 Retrieval Attempt', async () => {
    const {
      appendRetrievalAttempts,
      listRecentRetrievalAttempts,
    } = await import('../../src/server/store/retrieval-attempts.js');

    expect(appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'run-1',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:00:00.000Z'),
      entries: [{
        query: ' 深夜   爵士 ',
        normalizedQuery: '深夜 爵士',
        source: 'search',
        searchedCount: 1,
        resultCount: 8,
        addedCount: 2,
        selectedCount: 1,
      }],
    })).toBe(1);

    expect(listRecentRetrievalAttempts({
      userId: 'user-1',
      source: 'search',
      now: new Date('2026-07-17T03:00:00.000Z'),
    })).toEqual([expect.objectContaining({
      userId: 'user-1',
      runId: 'run-1',
      requestKind: 'autonomous',
      displayQuery: '深夜 爵士',
      normalizedQuery: '深夜 爵士',
      searchedCount: 1,
      resultCount: 8,
      addedCount: 2,
      selectedCount: 1,
      attemptedAt: '2026-07-17T02:00:00.000Z',
    })]);
  });

  it('只清理 30 天 retention 之外的原始 attempt', async () => {
    const {
      appendRetrievalAttempts,
      deleteExpiredRetrievalAttempts,
    } = await import('../../src/server/store/retrieval-attempts.js');
    const entry = {
      query: 'ambient',
      normalizedQuery: 'ambient',
      source: 'search',
      searchedCount: 1,
      resultCount: 1,
      addedCount: 1,
      selectedCount: 0,
    };
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'old-run',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-06-16T00:00:00.000Z'),
      entries: [entry],
    });
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'kept-run',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-06-18T00:00:00.000Z'),
      entries: [entry],
    });

    expect(deleteExpiredRetrievalAttempts(new Date('2026-07-17T00:00:00.000Z'))).toBe(1);
  });

  it('自主查询在 30 分钟内重复时要求替代 query', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'previous-run',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:50:00.000Z'),
      entries: [{
        query: '深夜爵士',
        normalizedQuery: '深夜爵士',
        source: 'search',
        searchedCount: 1,
        resultCount: 5,
        addedCount: 2,
        selectedCount: 1,
      }],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['深夜爵士'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('alternative_query_required');
    expect(prepared.queries).toEqual([]);
  });

  it('30 分钟到 24 小时的自主重复 query 只软降序', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'previous-run',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:00:00.000Z'),
      entries: [{
        query: '重复 query',
        normalizedQuery: '重复 query',
        source: 'search',
        searchedCount: 1,
        resultCount: 5,
        addedCount: 2,
        selectedCount: 1,
      }],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['重复 query', '新 query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('ready');
    expect(prepared.queries).toEqual(['新 query', '重复 query']);
    expect(prepared.funnelEntries[1]).toMatchObject({
      query: '重复 query',
      scoreMultiplier: expect.any(Number),
      repeatPenalty: expect.any(Number),
    });
    expect(prepared.funnelEntries[1]!.scoreMultiplier).toBeLessThan(1);
    expect(prepared.funnelEntries[1]!.repeatPenalty).toBeGreaterThan(0);
  });

  it('24 小时内连续两次低收益后冷却 6 小时', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    const entry = {
      query: '低收益 query',
      normalizedQuery: '低收益 query',
      source: 'search',
      searchedCount: 1,
      resultCount: 8,
      addedCount: 2,
      selectedCount: 0,
    };
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'low-yield-1',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T01:00:00.000Z'),
      entries: [entry],
    });
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'low-yield-2',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:00:00.000Z'),
      entries: [entry],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['低收益 query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('alternative_query_required');
    expect(prepared.queries).toEqual([]);
  });

  it('最终 selected success 清除之前的低收益 streak', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    const baseEntry = {
      query: '恢复 query',
      normalizedQuery: '恢复 query',
      source: 'search',
      searchedCount: 1,
      resultCount: 8,
      addedCount: 2,
      selectedCount: 0,
    };
    for (const [runId, attemptedAt] of [
      ['low-1', '2026-07-17T00:00:00.000Z'],
      ['low-2', '2026-07-17T01:00:00.000Z'],
    ] as const) {
      appendRetrievalAttempts({
        userId: 'user-1',
        runId,
        requestKind: 'autonomous',
        attemptedAt: new Date(attemptedAt),
        entries: [baseEntry],
      });
    }
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'selected-success',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:00:00.000Z'),
      entries: [{ ...baseEntry, selectedCount: 1 }],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['恢复 query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('ready');
    expect(prepared.queries).toEqual(['恢复 query']);
  });

  it('Explicit Request 绕过历史但仍做同 run 去重', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    const entry = {
      query: '明确点播',
      normalizedQuery: '明确点播',
      source: 'search',
      searchedCount: 1,
      resultCount: 5,
      addedCount: 0,
      selectedCount: 0,
    };
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'history-1',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-17T02:40:00.000Z'),
      entries: [entry],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'explicit_request',
      source: 'search',
      queries: ['明确点播', '同 run query'],
      attemptedInRun: new Set(['同 run query']),
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.queries).toEqual(['明确点播']);
    expect(prepared.funnelEntries[0]).toMatchObject({
      scoreMultiplier: 1,
      repeatPenalty: 0,
      selectionRate: null,
    });
  });

  it('Explicit Request 的低收益不会污染自主检索冷却 streak', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    const entry = {
      query: '点播失败 query',
      normalizedQuery: '点播失败 query',
      source: 'search',
      searchedCount: 1,
      resultCount: 0,
      addedCount: 0,
      selectedCount: 0,
    };
    for (const [runId, attemptedAt] of [
      ['explicit-1', '2026-07-17T01:00:00.000Z'],
      ['explicit-2', '2026-07-17T02:00:00.000Z'],
    ] as const) {
      appendRetrievalAttempts({
        userId: 'user-1',
        runId,
        requestKind: 'explicit_request',
        attemptedAt: new Date(attemptedAt),
        entries: [entry],
      });
    }

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'autonomous-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['点播失败 query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('ready');
    expect(prepared.queries).toEqual(['点播失败 query']);
    expect(prepared.funnelEntries[0]!.repeatPenalty).toBe(0);
  });

  it('query funnel 终态写入新 append-only store', async () => {
    const {
      createQueryFunnelState,
      recordFinalQueryFunnel,
      recordQueryFunnelSearch,
    } = await import('../../src/server/music-agent/query-funnel.js');
    const { recordRetrievalQueryFunnel } = await import('../../src/server/music-agent/retrieval-history.js');
    const { listRecentRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const attemptedAt = new Date('2026-07-17T02:00:00.000Z');
    const state = createQueryFunnelState({
      runId: 'run-persist',
      requestKind: 'autonomous',
      attemptedAt,
    });
    recordQueryFunnelSearch(state, {
      query: 'Persist Query',
      source: 'search',
      tracks: [{ id: 'track-1', name: 'Persist', artists: ['Artist'] }],
      resultCount: 1,
      addedCount: 1,
      pool: { has: (id) => id === 'track-1' },
    });

    recordFinalQueryFunnel(
      'user-persist',
      state,
      [{ id: 'track-1' }],
      recordRetrievalQueryFunnel,
    );

    expect(listRecentRetrievalAttempts({
      userId: 'user-persist',
      source: 'search',
      now: new Date('2026-07-17T03:00:00.000Z'),
    })).toEqual([expect.objectContaining({
      runId: 'run-persist',
      normalizedQuery: 'persist query',
      selectedCount: 1,
      attemptedAt: attemptedAt.toISOString(),
    })]);
  });

  it('Explicit Request 也跳过同 run 已经落库的 query', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'same-run',
      requestKind: 'explicit_request',
      attemptedAt: new Date('2026-07-17T02:50:00.000Z'),
      entries: [{
        query: 'same run query',
        normalizedQuery: 'same run query',
        source: 'search',
        searchedCount: 1,
        resultCount: 1,
        addedCount: 1,
        selectedCount: 1,
      }],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'same-run',
      requestKind: 'explicit_request',
      source: 'search',
      queries: ['same run query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.status).toBe('alternative_query_required');
    expect(prepared.queries).toEqual([]);
  });

  it('策略只读取最近 14 天，窗口外历史不产生压力', async () => {
    const { appendRetrievalAttempts } = await import('../../src/server/store/retrieval-attempts.js');
    const { prepareRetrievalQueries } = await import('../../src/server/music-agent/retrieval-history.js');
    appendRetrievalAttempts({
      userId: 'user-1',
      runId: 'old-run',
      requestKind: 'autonomous',
      attemptedAt: new Date('2026-07-02T03:00:00.000Z'),
      entries: [{
        query: 'old query',
        normalizedQuery: 'old query',
        source: 'search',
        searchedCount: 1,
        resultCount: 0,
        addedCount: 0,
        selectedCount: 0,
      }],
    });

    const prepared = prepareRetrievalQueries({
      userId: 'user-1',
      runId: 'current-run',
      requestKind: 'autonomous',
      source: 'search',
      queries: ['old query'],
      maxQueries: 8,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(prepared.queries).toEqual(['old query']);
    expect(prepared.funnelEntries[0]!.repeatPenalty).toBe(0);
  });
});
