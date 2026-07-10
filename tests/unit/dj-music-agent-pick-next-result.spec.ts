import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMusicAgentPickNextOutput } from '../../src/server/dj/musicAgentPickNextResult';
import { getQueue, setQueueState } from '../../src/server/store/queue';
import type { MusicAgentRunOutput } from '../../src/server/music-agent/schema';

type LyricsAwareDiagnostics = NonNullable<MusicAgentRunOutput['lyricsAwareDiagnostics']>;

function makeLyricsAwareDiagnostics(
  overrides: Partial<LyricsAwareDiagnostics> = {}
): LyricsAwareDiagnostics {
  return {
    mode: 'enforce_fit',
    enrichment: {
      shortlistCount: 1,
      cacheHits: 0,
      cacheMisses: 1,
      lyricAttempted: 1,
      lyricSuccess: 1,
      lyricMissing: 0,
      lyricFail: 0,
      lyricTimeout: 0,
      lyricCancelled: 0,
      wikiAttempted: 0,
      wikiSuccess: 0,
      wikiFail: 0,
      wikiTimeout: 0,
      wikiCancelled: 0,
      cacheWriteFailed: 0,
      sampledChars: 100,
      elapsedMs: 10,
      deadlineReached: false
    },
    promptChars: 1200,
    assessmentCoverageValid: true,
    assessmentValidationProblems: [],
    decisions: [],
    allReturnedPicksAssessed: true,
    enforcementApplied: true,
    fallbackSuppressed: false,
    ...overrides
  };
}

function makeOutput(
  picks: MusicAgentRunOutput['picks'],
  lyricsAwareDiagnostics?: LyricsAwareDiagnostics
): MusicAgentRunOutput {
  return {
    status: 'ok',
    mode: 'pick_next',
    say: '顺着今天的氛围往前推一首。',
    picks,
    rejected: [],
    trace: [{ step: 1, thoughtSummary: 'done', candidateCount: picks.length, elapsedMs: 10 }],
    fallbackReason: null,
    step: 1,
    llmCalls: 1,
    toolCalls: 1,
    elapsedMs: 10,
    queryFunnel: [],
    candidateScoreTable: picks.map((pick, index) => ({
      rank: index + 1,
      id: pick.id,
      song: pick.name ?? pick.id,
      artist: pick.artist ?? '未知艺人',
      sources: pick.source,
      baseScore: 1,
      artistPenalty: 0,
      trackPenalty: 0,
      repeatPenalty: 0,
      qualityPenalty: 0,
      titlePollutionPenalty: 0,
      adjustedScore: 1
    })),
    finalPickDiagnostics: {
      targetPickCount: picks.length,
      rawPickCount: picks.length,
      eligiblePickCount: picks.length,
      acceptedPickCount: picks.length,
      droppedPickCount: 0,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 0,
      fallbackCount: 0,
      acceptedDedupeKeys: [],
      droppedDedupeKeys: [],
      acceptedArtistKeys: [],
      droppedArtistKeys: []
    },
    ...(lyricsAwareDiagnostics ? { lyricsAwareDiagnostics } : {})
  };
}

describe('MusicAgent pick-next result handling', () => {
  beforeEach(() => {
    setQueueState('music-agent-result-user', [], 0);
  });

  it('routes unassessed ranked fallback picks to legacy fallback without appending them', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output: makeOutput([
        { id: '101', name: 'Fallback Song', artist: 'Fallback Artist', reason: 'ranked fallback', source: 'liked' }
      ]),
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'explore',
      emit,
      broadcastAppended,
      logger,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result).toEqual({
      status: 'legacy-fallback',
      legacyFallbackPath: 'music_agent_legacy_fallback',
      debugBroadcastSent: false
    });
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackPath: 'music_agent_legacy_fallback',
        requestedPickCount: 1
      }),
      'DJ pick-next: MusicAgent returned ranked fallback picks, using legacy fallback'
    );
  });

  it('accepts ranked fallback picks when enforcement diagnostics prove they are assessed and eligible', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };
    const pick = {
      id: '111',
      name: 'Safe Fallback',
      artist: 'Known Artist',
      reason: 'ranked fallback',
      source: 'search'
    } as const;
    const output = makeOutput([pick], makeLyricsAwareDiagnostics({
      decisions: [{
        id: pick.id,
        compatibility: 'compatible',
        compatibilityConfidence: 'high',
        compatibilityReasons: ['matches calm listening constraint'],
        quality: 'acceptable',
        qualityNegativeSignals: [],
        qualityPositiveSignals: ['complete credits'],
        eligible: true
      }]
    }));

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'explore',
      emit,
      broadcastAppended,
      logger,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(getQueue('music-agent-result-user')).toMatchObject([{ ncmId: '111' }]);
    expect(broadcastAppended).toHaveBeenCalledWith(
      'music-agent-result-user',
      0,
      1,
      emit,
      'music_agent_ranked_fallback',
      expect.objectContaining({ agentPickCount: 1 })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        routeOutcome: 'accepted_assessed_ranked',
        lyricsAwareDiagnostics: expect.objectContaining({ mode: 'enforce_fit' })
      }),
      'DJ pick-next: accepting assessed and eligible MusicAgent ranked picks'
    );
  });

  it('does not trust ranked convergence picks when enforcement diagnostics are incomplete', () => {
    const output = makeOutput([
      { id: '112', name: 'Unchecked Convergence', artist: 'Unknown', reason: 'ranked convergence', source: 'search' }
    ], makeLyricsAwareDiagnostics({
      assessmentCoverageValid: false,
      assessmentValidationProblems: ['missing assessment for 112'],
      allReturnedPicksAssessed: false
    }));

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'explore',
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('legacy-fallback');
    expect(getQueue('music-agent-result-user')).toEqual([]);
  });

  it('routes off-mode ranked convergence through legacy because it lacks enforcement proof', () => {
    const logger = { warn: vi.fn() };
    const broadcastAppended = vi.fn();
    const output = makeOutput([
      { id: '113', name: 'Legacy Convergence', artist: 'Known', reason: 'ranked convergence', source: 'liked' }
    ]);

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'comfort',
      emit: vi.fn(),
      broadcastAppended,
      logger,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('legacy-fallback');
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'DJ pick-next: accepting assessed and eligible MusicAgent ranked picks'
    );
  });

  it('accepts safely assessed ranked convergence as MusicAgent success telemetry', () => {
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const pick = {
      id: '114',
      name: 'Safe Convergence',
      artist: 'Known Artist',
      reason: 'ranked convergence',
      source: 'search'
    } as const;
    const output = makeOutput([pick], makeLyricsAwareDiagnostics({
      decisions: [{
        id: pick.id,
        compatibility: 'compatible',
        compatibilityConfidence: 'high',
        compatibilityReasons: ['fits the requested scene'],
        quality: 'acceptable',
        qualityNegativeSignals: [],
        qualityPositiveSignals: ['supported by credits'],
        eligible: true
      }]
    }));

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'explore',
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('handled');
    expect(broadcastAppended).toHaveBeenCalledWith(
      'music-agent-result-user',
      0,
      1,
      emit,
      'music_agent_success',
      expect.any(Object)
    );
  });

  it.each(['enforce_fit', 'enforce_all'] as const)(
    'suppresses legacy fallback for a defensively proven %s safety block',
    (mode) => {
      const emit = vi.fn();
      const logger = { warn: vi.fn() };
      const output = {
        ...makeOutput([], makeLyricsAwareDiagnostics({
          mode,
          fallbackSuppressed: true,
          allReturnedPicksAssessed: true
        })),
        status: 'empty_pool' as const,
        say: '没有通过安全筛选的候选。'
      } satisfies MusicAgentRunOutput;

      const result = handleMusicAgentPickNextOutput({
        userId: 'music-agent-result-user',
        output,
        excludeState: { ids: new Set(), dedupeKeys: new Set() },
        initialQueueLength: 0,
        targetPickCount: 1,
        startedAt: Date.now(),
        discoveryMode: 'explore',
        emit,
        broadcastAppended: vi.fn(),
        logger,
        setPickReason: vi.fn(),
        fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
      });

      expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
      expect(getQueue('music-agent-result-user')).toEqual([]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'dj.debug',
        routeOutcome: 'lyrics_safety_block',
        legacyFallbackSuppressed: true
      }));
      expect(emit).toHaveBeenCalledWith({
        type: 'dj.pick-next.done',
        added: false,
        addedCount: 0,
        reason: 'lyrics-safety-block',
        targetCount: 1
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          routeOutcome: 'lyrics_safety_block',
          lyricsAwareDiagnostics: expect.objectContaining({ mode })
        }),
        'DJ pick-next: lyrics-aware safety block suppressed legacy fallback'
      );
    }
  );

  it.each(['off', 'shadow'] as const)(
    'keeps legacy fallback for empty %s output even when fallbackSuppressed is set',
    (mode) => {
      const output = {
        ...makeOutput([], makeLyricsAwareDiagnostics({ mode, fallbackSuppressed: true })),
        status: 'empty_pool' as const
      } satisfies MusicAgentRunOutput;

      const result = handleMusicAgentPickNextOutput({
        userId: 'music-agent-result-user',
        output,
        excludeState: { ids: new Set(), dedupeKeys: new Set() },
        initialQueueLength: 0,
        targetPickCount: 1,
        startedAt: Date.now(),
        discoveryMode: 'explore',
        emit: vi.fn(),
        broadcastAppended: vi.fn(),
        logger: { warn: vi.fn() },
        setPickReason: vi.fn(),
        fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
      });

      expect(result.status).toBe('legacy-fallback');
    }
  );

  it('keeps legacy fallback for an ordinary MusicAgent error', () => {
    const output = {
      ...makeOutput([]),
      status: 'aborted' as const
    } satisfies MusicAgentRunOutput;

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now(),
      discoveryMode: 'explore',
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('legacy-fallback');
  });

  it('appends MusicAgent picks, emits debug details, and broadcasts completion', () => {
    const emit = vi.fn();
    const setPickReason = vi.fn();
    const broadcastAppended = vi.fn();

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output: makeOutput([
        { id: '201', name: 'First Song', artist: 'First Artist', reason: 'fits', source: 'search' },
        { id: '202', name: 'Second Song', artist: 'Second Artist', reason: 'continues', source: 'liked' }
      ]),
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 50,
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      setPickReason,
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(getQueue('music-agent-result-user')).toMatchObject([
      { ncmId: '201', name: 'First Song', artists: ['First Artist'] },
      { ncmId: '202', name: 'Second Song', artists: ['Second Artist'] }
    ]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      selectedSay: '顺着今天的氛围往前推一首。',
      selectedTracks: [
        expect.objectContaining({ id: '201', reason: 'fits', source: 'search' }),
        expect.objectContaining({ id: '202', reason: 'continues', source: 'liked' })
      ]
    }));
    expect(setPickReason).toHaveBeenCalledWith('201', '顺着今天的氛围往前推一首。');
    expect(setPickReason).toHaveBeenCalledWith('202', '顺着今天的氛围往前推一首。');
    expect(broadcastAppended).toHaveBeenCalledWith(
      'music-agent-result-user',
      0,
      2,
      emit,
      'music_agent_success',
      expect.objectContaining({
        agentPickCount: 2,
        rankedBackfillCount: 0,
        candidateCount: 2,
        discoveryMode: 'comfort'
      })
    );
  });

  it('applies MusicAgent queue mutations through an injected queue port', () => {
    const queue: ReturnType<typeof getQueue> = [];
    const queuePort = {
      getQueue: vi.fn(() => [...queue]),
      addToQueue: vi.fn((_userId: string, track: typeof queue[number]) => {
        queue.push(track);
      })
    };

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output: makeOutput([
        { id: '211', name: 'Port Song', artist: 'Port Artist', reason: 'port fit', source: 'search' }
      ]),
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 50,
      discoveryMode: 'explore',
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      queuePort,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(queuePort.addToQueue).toHaveBeenCalledWith(
      'music-agent-result-user',
      { ncmId: '211', name: 'Port Song', artists: ['Port Artist'] },
      'end'
    );
    expect(queue).toMatchObject([{ ncmId: '211', name: 'Port Song' }]);
    expect(getQueue('music-agent-result-user')).toEqual([]);
  });

  it('broadcasts partial success when only part of the target can be appended', () => {
    const emit = vi.fn();
    const setPickReason = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };
    const fallbackStatsSnapshot = vi.fn(() => ({ totalRuns: 3, fallbackRuns: 1, fallbackRate: 0.333, fallbackPaths: {} }));

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output: makeOutput([
        { id: '301', name: 'Fresh Song', artist: 'Fresh Artist', reason: 'fits', source: 'search' },
        { id: '302', name: 'Already Played', artist: 'Played Artist', reason: 'also fits', source: 'search' }
      ]),
      excludeState: { ids: new Set(['302']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 50,
      discoveryMode: 'explore',
      emit,
      broadcastAppended,
      logger,
      setPickReason,
      fallbackStatsSnapshot
    });

    expect(result).toEqual({ status: 'handled', debugBroadcastSent: true });
    expect(getQueue('music-agent-result-user')).toMatchObject([
      { ncmId: '301', name: 'Fresh Song', artists: ['Fresh Artist'] }
    ]);
    expect(setPickReason).toHaveBeenCalledTimes(1);
    expect(setPickReason).toHaveBeenCalledWith('301', '顺着今天的氛围往前推一首。');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug',
      partial: true,
      targetCount: 2,
      appendedCount: 1,
      requestedPickCount: 2,
      skippedPicks: [expect.objectContaining({ id: '302', reason: 'id_excluded' })]
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appendedCount: 1,
        skippedPicks: [expect.objectContaining({ id: '302', reason: 'id_excluded' })],
        fallbackPath: 'music_agent_success',
        fallbackStats: expect.objectContaining({ totalRuns: 3 })
      }),
      'DJ pick-next: MusicAgent appended fewer than target'
    );
    expect(fallbackStatsSnapshot).toHaveBeenCalled();
    expect(broadcastAppended).toHaveBeenCalledWith(
      'music-agent-result-user',
      0,
      2,
      emit,
      'music_agent_success',
      expect.objectContaining({
        agentPickCount: 1,
        rankedBackfillCount: 0,
        candidateCount: 2,
        discoveryMode: 'explore'
      })
    );
  });

  it('returns legacy fallback when all MusicAgent picks are skipped', () => {
    const emit = vi.fn();
    const setPickReason = vi.fn();
    const broadcastAppended = vi.fn();
    const logger = { warn: vi.fn() };
    const fallbackStatsSnapshot = vi.fn(() => ({ totalRuns: 4, fallbackRuns: 2, fallbackRate: 0.5, fallbackPaths: {} }));

    const result = handleMusicAgentPickNextOutput({
      userId: 'music-agent-result-user',
      output: makeOutput([
        { id: '401', name: 'Queued Song', artist: 'Queued Artist', reason: 'fits', source: 'liked' }
      ]),
      excludeState: { ids: new Set(['401']), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 50,
      discoveryMode: 'comfort',
      emit,
      broadcastAppended,
      logger,
      setPickReason,
      fallbackStatsSnapshot
    });

    expect(result).toEqual({
      status: 'legacy-fallback',
      legacyFallbackPath: 'music_agent_legacy_fallback',
      debugBroadcastSent: false
    });
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(setPickReason).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appendedCount: 0,
        requestedPickCount: 1,
        skippedPicks: [expect.objectContaining({ id: '401', reason: 'id_excluded' })],
        fallbackPath: 'music_agent_legacy_fallback',
        fallbackStats: expect.objectContaining({ fallbackRuns: 2 })
      }),
      'DJ pick-next: MusicAgent picks did not change queue, using legacy fallback'
    );
    expect(fallbackStatsSnapshot).toHaveBeenCalled();
  });
});
