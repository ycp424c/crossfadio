import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLegacyPickNextOutput } from '../../src/server/dj/legacyPickNextResult';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { getQueue, setQueueState } from '../../src/server/store/queue';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

describe('Legacy DJ pick-next result handling', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-legacy-result-'));
    process.env.CROSSFADIO_DATA_DIR = dataDir;
    initDb();
    setQueueState('legacy-result-user', [], 0);
  });

  afterEach(() => {
    _resetDbForTest();
    setQueueState('legacy-result-user', [], 0);
    if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
    else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  });

  it('appends legacy LLM picks, emits selected track debug, and broadcasts completion', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const setPickReason = vi.fn();

    const result = handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [
        { id: '201', name: 'Candidate One', artist: 'Candidate Artist' },
        { id: '202', name: 'Excluded Proposal', artist: '卫兰' },
        { id: '203', name: 'Candidate Three', artist: 'Third Artist' }
      ],
      pickedDetailMap: new Map([
        ['201', { id: 201, name: 'Detailed One', artists: ['Detail Artist'], coverImgUrl: 'cover-201' }],
        ['203', { id: 203, name: 'Detailed Three', artists: ['Third Artist'], coverImgUrl: 'cover-203' }]
      ]),
      pickSay: '接下来用卫兰维持这个推进感。',
      pickReasonsById: { '201': '第一首理由', '203': '第三首理由' },
      phase3Debug: { likedSample: ['liked-1'], totalCandidates: 3 },
      excludeState: { ids: new Set(['202']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 50,
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      markDebugBroadcastSent: vi.fn(),
      setPickReason,
      fallbackStatsSnapshot: () => ({ totalRuns: 1, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} }),
      searchedCount: 10,
      totalCandidates: 3,
      searchQueries: ['city pop']
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(getQueue('legacy-result-user')).toMatchObject([
      { ncmId: '201', name: 'Detailed One', artists: ['Detail Artist'], coverImgUrl: 'cover-201' },
      { ncmId: '203', name: 'Detailed Three', artists: ['Third Artist'], coverImgUrl: 'cover-203' }
    ]);
    const finalRationale = '本次实际补充 2 首：Detail Artist《Detailed One》、Third Artist《Detailed Three》。';
    expect(setPickReason).toHaveBeenCalledWith('201', '第一首理由');
    expect(setPickReason).toHaveBeenCalledWith('203', '第三首理由');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      likedSample: ['liked-1'],
      totalCandidates: 3,
      selectedSay: finalRationale,
      targetCount: 2,
      appendedCount: 2,
      pickedCount: 3,
      selectedTracks: [
        expect.objectContaining({ id: '201', name: 'Detailed One', artist: 'Detail Artist', reason: '第一首理由', source: 'legacy_llm_success' }),
        expect.objectContaining({ id: '203', name: 'Detailed Three', artist: 'Third Artist', reason: '第三首理由', source: 'legacy_llm_success' })
      ]
    }));
    expect((emit.mock.calls[0]?.[0] as { selectedSay: string }).selectedSay).not.toContain('卫兰');
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(broadcastAppended.mock.invocationCallOrder[0]);
    const events = getRecentDjEvents('legacy-result-user', 10);
    expect(events.find((event) => event.type === 'selection_started')?.payload).toMatchObject({
      trigger: 'auto_fill',
      targetCount: 2
    });
    expect(events.find((event) => event.type === 'selection_started')?.payload).not.toHaveProperty('batchRationale');
    const selectedEvents = events.filter((event) => event.type === 'track_selected');
    expect(selectedEvents).toHaveLength(2);
    expect(selectedEvents.map((event) => event.trackId).sort()).toEqual(['201', '203']);
    expect(selectedEvents.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trackId: '201',
        trackName: 'Detailed One',
        artist: 'Detail Artist',
        selectionRationale: '第一首理由',
        source: 'legacy_llm_success',
        pickOrder: 1
      }),
      expect.objectContaining({
        trackId: '203',
        trackName: 'Detailed Three',
        artist: 'Third Artist',
        selectionRationale: '第三首理由',
        source: 'legacy_llm_success',
        pickOrder: 2
      })
    ]));
    const completion = events.find((event) => event.type === 'selection_completed');
    expect(completion?.payload).toEqual({
      finalTrackIds: ['201', '203'],
      finalRationale,
      proposedRationale: '接下来用卫兰维持这个推进感。',
      targetCount: 2,
      requestedPickCount: 3,
      appendedCount: 2,
      skippedPicks: [expect.objectContaining({ id: '202', reason: 'id_excluded' })]
    });
    expect(JSON.stringify(completion?.payload.finalRationale)).not.toContain('卫兰');
    const queueChanged = events.find((event) => event.type === 'queue_changed');
    expect(queueChanged?.payload).toMatchObject({
      action: 'append',
      trackIds: ['201', '203'],
      position: 'end'
    });
    expect(completion?.causationEventId).toBe(selectedEvents.find((event) => event.trackId === '203')?.id);
    expect(queueChanged?.causationEventId).toBe(completion?.id);
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-result-user',
      0,
      2,
      emit,
      'legacy_llm_success',
      expect.objectContaining({
        agentPickCount: 3,
        rankedBackfillCount: 0,
        candidateCount: 3,
        discoveryMode: 'comfort',
        appendedTracks: [
          expect.objectContaining({ ncmId: '201', coverImgUrl: 'cover-201' }),
          expect.objectContaining({ ncmId: '203', coverImgUrl: 'cover-203' })
        ]
      })
    );
  });

  it('broadcasts partial legacy success with skipped pick diagnostics', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };

    const result = handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [
        { id: '301', name: 'Fresh Pick', artist: 'Fresh Artist' },
        { id: '302', name: 'Already Played', artist: 'Played Artist' }
      ],
      pickedDetailMap: new Map([
        ['301', { id: 301, name: 'Fresh Detail', artists: ['Fresh Artist'], coverImgUrl: null }]
      ]),
      pickSay: '留一点卫兰式的明亮尾巴。',
      pickReasonsById: {},
      phase3Debug: { searchQueries: ['fresh'] },
      excludeState: { ids: new Set(['302']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 50,
      discoveryMode: 'explore',
      legacyFallbackPath: 'music_agent_legacy_fallback',
      emit,
      broadcastAppended,
      logger,
      markDebugBroadcastSent: vi.fn(),
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 3, fallbackRuns: 1, fallbackRate: 0.333, fallbackPaths: {} }),
      searchedCount: 8,
      totalCandidates: 6,
      searchQueries: ['fresh']
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(getQueue('legacy-result-user')).toMatchObject([
      { ncmId: '301', name: 'Fresh Detail', artists: ['Fresh Artist'] }
    ]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      partial: true,
      targetCount: 2,
      appendedCount: 1,
      pickedCount: 2,
      skippedPicks: [expect.objectContaining({ id: '302', reason: 'id_excluded' })]
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      selectedSay: '本次实际补充 1 首：Fresh Artist《Fresh Detail》。'
    }));
    expect((emit.mock.calls[0]?.[0] as { selectedSay: string }).selectedSay).not.toContain('卫兰');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 2,
        appendedCount: 1,
        pickedCount: 2,
        fallbackPath: 'music_agent_legacy_fallback',
        fallbackStats: expect.objectContaining({ totalRuns: 3 }),
        searchQueries: ['fresh']
      }),
      'DJ pick-next: whitelisted picks appended fewer than target'
    );
    const events = getRecentDjEvents('legacy-result-user', 10);
    expect(events.find((event) => event.type === 'selection_started')?.payload).toMatchObject({
      trigger: 'auto_fill',
      targetCount: 2
    });
    const completion = events.find((event) => event.type === 'selection_completed');
    expect(completion?.payload).toEqual({
      finalTrackIds: ['301'],
      finalRationale: '本次实际补充 1 首：Fresh Artist《Fresh Detail》。',
      proposedRationale: '留一点卫兰式的明亮尾巴。',
      targetCount: 2,
      requestedPickCount: 2,
      appendedCount: 1,
      skippedPicks: [expect.objectContaining({ id: '302', reason: 'id_excluded' })]
    });
    expect(events.filter((event) => event.type === 'track_selected').map((event) => event.trackId)).toEqual(['301']);
    expect(events.find((event) => event.type === 'queue_changed')?.payload).toMatchObject({
      action: 'append',
      trackIds: ['301'],
      position: 'end'
    });
    expect(broadcastAppended).toHaveBeenCalledWith(
      'legacy-result-user',
      0,
      2,
      emit,
      'music_agent_legacy_fallback',
      expect.objectContaining({
        agentPickCount: 2,
        rankedBackfillCount: 0,
        candidateCount: 6,
        discoveryMode: 'explore',
        appendedTracks: [expect.objectContaining({ ncmId: '301', name: 'Fresh Detail' })]
      })
    );
  });

  it('returns random fallback when every legacy pick is skipped', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };

    const result = handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [
        { id: '401', name: 'Queued Pick', artist: 'Queued Artist' }
      ],
      pickedDetailMap: new Map(),
      pickSay: '这首本来合适。',
      pickReasonsById: {},
      phase3Debug: {},
      excludeState: { ids: new Set(['401']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 50,
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger,
      markDebugBroadcastSent: vi.fn(),
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 4, fallbackRuns: 2, fallbackRate: 0.5, fallbackPaths: {} }),
      searchedCount: 5,
      totalCandidates: 4,
      searchQueries: ['queued']
    });

    expect(result).toEqual({ status: 'random-fallback', debugBroadcastSent: false });
    expect(getQueue('legacy-result-user')).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appendedCount: 0,
        pickedCount: 1,
        skippedPicks: [expect.objectContaining({ id: '401', reason: 'id_excluded' })],
        fallbackPath: 'legacy_random_fallback',
        fallbackStats: expect.objectContaining({ fallbackRuns: 2 })
      }),
      'DJ pick-next: whitelisted picks did not change queue, using random fallback'
    );
  });

  it('returns a handled no-op when another path filled the stale queue', () => {
    setQueueState('legacy-result-user', [
      { ncmId: 'concurrent', name: 'Concurrent Fill', artists: ['Other Path'] }
    ], 0);
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };

    const result = handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [{ id: 'concurrent', name: 'Concurrent Fill', artist: 'Other Path' }],
      pickedDetailMap: new Map(),
      pickSay: 'stale proposal',
      pickReasonsById: {},
      phase3Debug: {},
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger,
      markDebugBroadcastSent: vi.fn(),
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({}),
      searchedCount: 1,
      totalCandidates: 1,
      searchQueries: []
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: false });
    expect(getQueue('legacy-result-user')).toHaveLength(1);
    expect(getRecentDjEvents('legacy-result-user')).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('records every legacy pick skipped after the target is filled', () => {
    handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [
        { id: 'close-1', name: 'Close One', artist: 'Artist One' },
        { id: 'close-2', name: 'Close Two', artist: 'Artist Two' },
        { id: 'close-3', name: 'Close Three', artist: 'Artist Three' }
      ],
      pickedDetailMap: new Map(),
      pickSay: 'closure',
      pickReasonsById: {},
      phase3Debug: {},
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      markDebugBroadcastSent: vi.fn(),
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({}),
      searchedCount: 3,
      totalCandidates: 3,
      searchQueries: []
    });

    expect(getRecentDjEvents('legacy-result-user').find((event) =>
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

  it('marks legacy debug as sent before broadcasting so fallback does not emit duplicate debug on broadcast failure', () => {
    const emit = vi.fn();
    const markDebugBroadcastSent = vi.fn();
    const broadcastError = new Error('broadcast failed');
    const broadcastAppended = vi.fn(() => {
      throw broadcastError;
    });

    expect(() => handleLegacyPickNextOutput({
      userId: 'legacy-result-user',
      pickedTracks: [
        { id: '501', name: 'Broadcast Pick', artist: 'Broadcast Artist' }
      ],
      pickedDetailMap: new Map([
        ['501', { id: 501, name: 'Broadcast Detail', artists: ['Broadcast Artist'], coverImgUrl: null }]
      ]),
      pickSay: '先发 debug，再发广播。',
      pickReasonsById: {},
      phase3Debug: {},
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 50,
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      markDebugBroadcastSent,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 1, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} }),
      searchedCount: 1,
      totalCandidates: 1,
      searchQueries: []
    })).toThrow(broadcastError);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'dj.debug' }));
    expect(markDebugBroadcastSent).toHaveBeenCalledTimes(1);
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(markDebugBroadcastSent.mock.invocationCallOrder[0]);
    expect(markDebugBroadcastSent.mock.invocationCallOrder[0]).toBeLessThan(broadcastAppended.mock.invocationCallOrder[0]);
  });
});
