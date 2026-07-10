import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLegacyRandomFallback } from '../../src/server/dj/legacyRandomFallback';
import { createDjPickNextTelemetry } from '../../src/server/dj/pickNextTelemetry';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { getQueue, setQueueState } from '../../src/server/store/queue';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

describe('Legacy DJ random fallback handling', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-legacy-random-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    initDb();
    setQueueState('legacy-random-user', [], 0);
  });

  afterEach(() => {
    _resetDbForTest();
    setQueueState('legacy-random-user', [], 0);
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  });

  it('emits done and records no-candidates when every liked song is excluded', async () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn(
      createDjPickNextTelemetry({ logger: { info: vi.fn() } }).broadcastAppended
    );
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
      setPickReason: vi.fn(),
      recordFallbackStats,
      sampleIds: vi.fn(),
      fetchSongDetails,
      signal: undefined
    });

    expect(recordFallbackStats).toHaveBeenCalledWith('no_candidates');
    expect(recordFallbackStats).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 1,
        appendedCount: 0,
        fallbackStats: expect.objectContaining({ fallbackRuns: 1 })
      }),
      'DJ pick-next fallback: no candidates'
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      trackIds: []
    }));
    expect(fetchSongDetails).not.toHaveBeenCalled();
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      1,
      emit,
      undefined,
      expect.objectContaining({ appendedTracks: [], fallbackPath: 'no_candidates' })
    );
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
    const setPickReason = vi.fn();

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
      setPickReason,
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
      selectedSay: '本次实际补充 2 首：Artist One《Fallback One》、Artist Two《Fallback Two》。',
      selectedTracks: [
        expect.objectContaining({ id: '201', name: 'Fallback One', artist: 'Artist One' }),
        expect.objectContaining({ id: '202', name: 'Fallback Two', artist: 'Artist Two' })
      ]
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
    expect(setPickReason).toHaveBeenCalledTimes(2);
    expect(setPickReason).toHaveBeenCalledWith(
      '201',
      'Selected by legacy random fallback from liked tracks.'
    );
    expect(setPickReason).toHaveBeenCalledWith(
      '202',
      'Selected by legacy random fallback from liked tracks.'
    );
    const events = getRecentDjEvents('legacy-random-user', 10);
    expect(events.find((event) => event.type === 'selection_started')?.payload).toMatchObject({
      trigger: 'auto_fill',
      targetCount: 2
    });
    expect(events.find((event) => event.type === 'selection_started')?.payload).not.toHaveProperty('batchRationale');
    const selectedEvents = events.filter((event) => event.type === 'track_selected');
    expect(selectedEvents).toHaveLength(2);
    expect(selectedEvents.map((event) => event.trackId).sort()).toEqual(['201', '202']);
    expect(selectedEvents.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trackId: '201',
        trackName: 'Fallback One',
        artist: 'Artist One',
        selectionRationale: 'Selected by legacy random fallback from liked tracks.',
        source: 'legacy_random_fallback',
        pickOrder: 1
      }),
      expect.objectContaining({
        trackId: '202',
        trackName: 'Fallback Two',
        artist: 'Artist Two',
        selectionRationale: 'Selected by legacy random fallback from liked tracks.',
        source: 'legacy_random_fallback',
        pickOrder: 2
      })
    ]));
    const completion = events.find((event) => event.type === 'selection_completed');
    expect(completion?.payload).toEqual({
      finalTrackIds: ['201', '202'],
      finalRationale: '本次实际补充 2 首：Artist One《Fallback One》、Artist Two《Fallback Two》。',
      proposedRationale: '随机 fallback（LLM 未配置或选歌失败）',
      targetCount: 2,
      requestedPickCount: 2,
      appendedCount: 2,
      skippedPicks: []
    });
    const queueChanged = events.find((event) => event.type === 'queue_changed');
    expect(queueChanged?.payload).toMatchObject({
      action: 'append',
      trackIds: ['201', '202'],
      position: 'end'
    });
    expect(completion?.causationEventId).toBe(selectedEvents.find((event) => event.trackId === '202')?.id);
    expect(queueChanged?.causationEventId).toBe(completion?.id);
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
        discoveryMode: 'explore',
        appendedTracks: [
          expect.objectContaining({ ncmId: '201', coverImgUrl: 'cover-201' }),
          expect.objectContaining({ ncmId: '202', coverImgUrl: null })
        ]
      })
    );
  });

  it('emits final fallback debug after an upstream generic debug', async () => {
    const emit = vi.fn();
    emit({
      type: 'dj.debug',
      selectedSay: 'generic proposal',
      selectedTracks: [{ id: 'proposal', name: 'Generic Proposal' }]
    });

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
      setPickReason: vi.fn(),
      recordFallbackStats: vi.fn(() => ({ totalRuns: 1, fallbackRuns: 1, fallbackRate: 1, fallbackPaths: {} })),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => [
        { id: 201, name: 'Fallback One', artists: ['Artist One'], coverImgUrl: null }
      ]),
      signal: undefined
    });

    const debugPayloads = emit.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.type === 'dj.debug');
    expect(debugPayloads).toHaveLength(2);
    expect(debugPayloads.at(-1)).toMatchObject({
      type: 'dj.debug',
      selectedSay: '本次实际补充 1 首：Artist One《Fallback One》。',
      selectedTracks: [{
        id: '201',
        name: 'Fallback One',
        artist: 'Artist One',
        reason: 'Selected by legacy random fallback from liked tracks.',
        source: 'legacy_random_fallback'
      }]
    });
    expect(JSON.stringify(debugPayloads.at(-1))).not.toContain('generic proposal');
    expect(JSON.stringify(debugPayloads.at(-1))).not.toContain('Generic Proposal');
  });

  it('does not finalize a fallback track added by another path while details were fetched', async () => {
    const emit = vi.fn();
    const excludeState = { ids: new Set<string>(), dedupeKeys: new Set<string>() };
    const telemetryLogger = { info: vi.fn() };
    const telemetry = createDjPickNextTelemetry({ logger: telemetryLogger });
    const broadcastAppended = vi.fn(telemetry.broadcastAppended);

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['concurrent'],
      excludeState,
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      debugBroadcastSent: false,
      emit,
      broadcastAppended,
      logger: { warn: vi.fn(), info: vi.fn() },
      setPickReason: vi.fn(),
      recordFallbackStats: vi.fn(() => ({})),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => {
        setQueueState('legacy-random-user', [
          { ncmId: 'concurrent', name: 'Concurrent Fill', artists: ['Other Path'] }
        ], 0);
        return [{ id: 'concurrent', name: 'Concurrent Fill', artists: ['Other Path'], coverImgUrl: null }];
      })
    });

    expect(getQueue('legacy-random-user')).toHaveLength(1);
    expect(excludeState.ids).toEqual(new Set());
    expect(excludeState.dedupeKeys).toEqual(new Set());
    expect(getRecentDjEvents('legacy-random-user')).toEqual([]);
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      2,
      emit,
      undefined,
      expect.objectContaining({
        appendedTracks: [],
        fallbackPath: 'legacy_random_fallback'
      })
    );
    expect(emit).toHaveBeenCalledWith({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      targetCount: 2,
      trackIds: [],
      trackNames: [],
      trackName: undefined
    });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-appended' }));
    expect(JSON.stringify(emit.mock.calls)).not.toContain('concurrent');
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      selectedTracks: expect.anything()
    }));
  });

  it('accounts for every fetched fallback detail after remaining slots are exhausted', async () => {
    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['close-1', 'close-2', 'close-3'],
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      debugBroadcastSent: true,
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      setPickReason: vi.fn(),
      recordFallbackStats: vi.fn(() => ({})),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => [
        { id: 'close-1', name: 'Close One', artists: ['Artist One'] },
        { id: 'close-2', name: 'Close Two', artists: ['Artist Two'] },
        { id: 'close-3', name: 'Close Three', artists: ['Artist Three'] }
      ])
    });

    expect(getRecentDjEvents('legacy-random-user').find((event) =>
      event.type === 'selection_completed'
    )?.payload).toMatchObject({
      requestedPickCount: 3,
      appendedCount: 1,
      skippedPicks: [
        expect.objectContaining({ id: 'close-2', reason: 'no_remaining_slots' }),
        expect.objectContaining({ id: 'close-3', reason: 'no_remaining_slots' })
      ]
    });
  });

  it('emits a non-success debug when fallback details are empty', async () => {
    const emit = vi.fn();

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['missing'],
      excludeState: { ids: new Set(['excluded']), dedupeKeys: new Set(['existing::artist']) },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      debugBroadcastSent: false,
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      setPickReason: vi.fn(),
      recordFallbackStats: vi.fn(() => ({})),
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => [])
    });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      selectedTracks: [],
      selectedSay: '随机 fallback 未找到可追加歌曲。',
      totalCandidates: 1,
      excludedIds: ['excluded'],
      excludedDedupeKeys: ['existing::artist']
    }));
    expect(getRecentDjEvents('legacy-random-user')).toEqual([]);
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
      setPickReason: vi.fn(),
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

  it('does not attribute concurrently appended tracks when no fallback candidates remain', async () => {
    setQueueState('legacy-random-user', [
      { ncmId: 'queued', name: 'Queued Track', artists: ['Queued Artist'] }
    ], 0);
    const emit = vi.fn();
    const broadcastAppended = vi.fn(
      createDjPickNextTelemetry({ logger: { info: vi.fn() } }).broadcastAppended
    );

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
      setPickReason: vi.fn(),
      recordFallbackStats: vi.fn(() => ({ totalRuns: 1, fallbackRuns: 1, fallbackRate: 1, fallbackPaths: { no_candidates: 1 } })),
      sampleIds: vi.fn(),
      fetchSongDetails: vi.fn(),
      signal: undefined
    });

    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      1,
      emit,
      undefined,
      expect.objectContaining({
        appendedTracks: [],
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: 0,
        fallbackPath: 'no_candidates',
        discoveryMode: 'explore'
      })
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      trackIds: []
    }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-appended' }));
    expect(JSON.stringify(emit.mock.calls)).not.toContain('queued');
  });

  it('does not attribute concurrently appended tracks when fallback details are empty', async () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn(createDjPickNextTelemetry({ logger: { info: vi.fn() } }).broadcastAppended);
    const recordFallbackStats = vi.fn(() => ({}));

    await handleLegacyRandomFallback({
      userId: 'legacy-random-user',
      allLikedIds: ['missing'],
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      debugBroadcastSent: false,
      emit,
      broadcastAppended,
      logger: { warn: vi.fn(), info: vi.fn() },
      setPickReason: vi.fn(),
      recordFallbackStats,
      sampleIds: vi.fn((ids: string[]) => ids),
      fetchSongDetails: vi.fn(async () => {
        setQueueState('legacy-random-user', [
          { ncmId: 'concurrent-empty', name: 'Concurrent Empty', artists: ['Other Path'] }
        ], 0);
        return [];
      })
    });

    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-random-user',
      0,
      1,
      emit,
      undefined,
      expect.objectContaining({
        appendedTracks: [],
        fallbackPath: 'legacy_random_fallback'
      })
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      trackIds: []
    }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-appended' }));
    expect(JSON.stringify(emit.mock.calls)).not.toContain('concurrent-empty');
    expect(recordFallbackStats).toHaveBeenCalledTimes(1);
    expect(recordFallbackStats).toHaveBeenCalledWith('legacy_random_fallback');
  });
});
