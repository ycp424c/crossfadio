import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLegacyRandomFallback } from '../../src/server/dj/legacyRandomFallback';
import { getQueue, setQueueState } from '../../src/server/store/queue';

describe('Legacy DJ random fallback handling', () => {
  beforeEach(() => {
    setQueueState('legacy-random-user', [], 0);
  });

  it('emits done and records no-candidates when every liked song is excluded', async () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const fetchSongDetails = vi.fn();
    const recordFallbackStats = vi.fn(() => ({ totalRuns: 1, fallbackRuns: 1, fallbackRate: 1, fallbackPaths: { no_candidates: 1 } }));
    const logger = { warn: vi.fn(), info: vi.fn() };

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['101'],
      excludeState: { ids: new Set(['101']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 20,
      discoveryMode: 'comfort',
      debugBroadcastSent: false,
      emit,
      broadcastAppended,
      logger,
      recordFallbackStats,
      sampleIds: vi.fn(),
      fetchSongDetails,
      signal: undefined
    });

    expect(recordFallbackStats).toHaveBeenCalledWith('no_candidates');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 1,
        appendedCount: 0,
        fallbackStats: expect.objectContaining({ fallbackRuns: 1 })
      }),
      'DJ pick-next fallback: no candidates'
    );
    expect(emit).toHaveBeenCalledWith({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    expect(fetchSongDetails).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
  });

  it('samples available liked ids, appends fetched details, and broadcasts random fallback', async () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const sampleIds = vi.fn((ids: string[], count: number) => ids.slice(0, count));
    const fetchSongDetails = vi.fn(async () => [
      { id: 201, name: 'Fallback One', artists: ['Artist One'], coverImgUrl: 'cover-201' },
      { id: 202, name: 'Fallback Two', artists: ['Artist Two'], coverImgUrl: null }
    ]);
    const recordFallbackStats = vi.fn(() => ({
      totalRuns: 2,
      fallbackRuns: 1,
      fallbackRate: 0.5,
      fallbackPaths: { legacy_random_fallback: 1 }
    }));
    const logger = { warn: vi.fn(), info: vi.fn() };

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['excluded', '201', '202', '203'],
      excludeState: { ids: new Set(['excluded']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 20,
      discoveryMode: 'explore',
      debugBroadcastSent: false,
      emit,
      broadcastAppended,
      logger,
      recordFallbackStats,
      sampleIds,
      fetchSongDetails,
      signal: undefined
    });

    expect(sampleIds).toHaveBeenCalledWith(['201', '202', '203'], 3);
    expect(fetchSongDetails).toHaveBeenCalledWith(['201', '202', '203']);
    expect(getQueue('legacy-random-user')).toMatchObject([
      { ncmId: '201', name: 'Fallback One', artists: ['Artist One'], coverImgUrl: 'cover-201' },
      { ncmId: '202', name: 'Fallback Two', artists: ['Artist Two'], coverImgUrl: null }
    ]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      excludedIds: ['excluded'],
      totalCandidates: 3,
      selectedSay: '随机 fallback（LLM 未配置或选歌失败）'
    }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 2,
        appendedCount: 2,
        fallbackAppendedCount: 2,
        sampledCount: 3,
        fallbackStats: expect.objectContaining({ fallbackRuns: 1 })
      }),
      'DJ pick-next fallback: appended tracks'
    );
    expect(recordFallbackStats).toHaveBeenCalledWith('legacy_random_fallback');
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      2,
      emit,
      undefined,
      expect.objectContaining({
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: 3,
        fallbackPath: 'legacy_random_fallback',
        discoveryMode: 'explore'
      })
    );
  });

  it('does not emit fallback debug again when upstream debug was already sent', async () => {
    const emit = vi.fn();

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['201'],
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 20,
      discoveryMode: 'comfort',
      debugBroadcastSent: true,
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      recordFallbackStats: vi.fn(() => ({ totalRuns: 1, fallbackRuns: 1, fallbackRate: 1, fallbackPaths: {} })),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => [
        { id: 201, name: 'Fallback One', artists: ['Artist One'], coverImgUrl: null }
      ]),
      signal: undefined
    });

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dj.debug' }));
  });

  it('returns without broadcasting when aborted after fetching fallback details', async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn(), info: vi.fn() };

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['201'],
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 20,
      discoveryMode: 'comfort',
      debugBroadcastSent: true,
      emit,
      broadcastAppended,
      logger,
      recordFallbackStats: vi.fn(),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => {
        controller.abort();
        return [{ id: 201, name: 'Fallback One', artists: ['Artist One'], coverImgUrl: null }];
      }),
      signal: controller.signal
    });

    expect(getQueue('legacy-random-user')).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
  });

  it('broadcasts prior appended tracks when no fallback candidates remain', async () => {
    setQueueState('legacy-random-user', [
      { ncmId: 'queued', name: 'Queued Track', artists: ['Queued Artist'] }
    ], 0);
    const emit = vi.fn();
    const broadcastAppended = vi.fn();

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['101'],
      excludeState: { ids: new Set(['101']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 20,
      discoveryMode: 'explore',
      debugBroadcastSent: true,
      emit,
      broadcastAppended,
      logger: { warn: vi.fn(), info: vi.fn() },
      recordFallbackStats: vi.fn(() => ({ totalRuns: 1, fallbackRuns: 1, fallbackRate: 1, fallbackPaths: { no_candidates: 1 } })),
      sampleIds: vi.fn(),
      fetchSongDetails: vi.fn(),
      signal: undefined
    });

    expect(emit).not.toHaveBeenCalledWith({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      1,
      emit,
      undefined,
      expect.objectContaining({
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: 0,
        fallbackPath: 'no_candidates',
        discoveryMode: 'explore'
      })
    );
  });
});
