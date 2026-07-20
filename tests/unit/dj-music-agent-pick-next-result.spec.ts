import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMusicAgentPickNextOutput,
  publishCommittedMusicAgentPickNextSuccess
} from '../../src/server/dj/musicAgentPickNextResult';
import type { MusicAgentRunOutput } from '../../src/server/music-agent/schema';
import { getQueue, getQueueRevision, setQueueState } from '../../src/server/store/queue';

describe('MusicAgent pick-next result handling v2', () => {
  beforeEach(() => {
    setQueueState('music-agent-result-user', [], 0);
  });

  it('appends ordinary policy-approved picks and reports the success route', () => {
    const broadcastAppended = vi.fn();
    const setPickReason = vi.fn();
    const excludeState = { ids: new Set<string>(), dedupeKeys: new Set<string>() };
    const result = handle(makeOutput([
      pick('101', 'First Song', 'First Artist', 'balanced fit'),
      pick('102', 'Second Song', 'Second Artist', 'queue variety')
    ]), { targetPickCount: 2, excludeState });

    expect(result).toMatchObject({ status: 'handled', appendedCount: 2 });
    expect(result.finalQueueDecisions).toMatchObject([
      { candidateId: '101', decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] } },
      { candidateId: '102', decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] } }
    ]);
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(setPickReason).not.toHaveBeenCalled();
    expect(excludeState.ids).toEqual(new Set());
    expect(excludeState.dedupeKeys).toEqual(new Set());
    expect(result.successPublication).toBeDefined();

    setQueueState('music-agent-result-user', result.appendedTracks, 0);
    publishCommittedMusicAgentPickNextSuccess({
      userId: 'music-agent-result-user',
      publication: result.successPublication!,
      excludeState,
      targetPickCount: 2,
      emit: vi.fn(),
      broadcastAppended,
      logger: { warn: vi.fn() },
      setPickReason
    });

    expect(getQueue('music-agent-result-user').map((track) => track.ncmId)).toEqual(['101', '102']);
    expect(broadcastAppended).toHaveBeenCalledWith(
      'music-agent-result-user', [
        { ncmId: '101', name: 'First Song', artists: ['First Artist'] },
        { ncmId: '102', name: 'Second Song', artists: ['Second Artist'] }
      ], 2, expect.any(Function), 'music_agent_success', expect.any(Object)
    );
    expect(setPickReason).toHaveBeenCalledTimes(2);
  });

  it('accepts policy-governed ranked recovery without any legacy selection path', () => {
    const logger = { warn: vi.fn() };
    const result = handle(makeOutput([
      pick('201', 'Recovery Song', 'Recovery Artist', 'ranked fallback')
    ]), { logger });

    expect(result).toMatchObject({ status: 'handled' });
    expect(result.successPublication).toMatchObject({ path: 'music_agent_ranked_recovery' });
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackPath: 'music_agent_ranked_recovery' }),
      'DJ pick-next: accepting policy-governed ranked recovery picks'
    );
  });

  it('treats an empty lyrics-assessed result like every other no-candidate result', () => {
    const output = makeOutput([], {
      status: 'empty_pool',
      lyricsAwareDiagnostics: lyricsDiagnostics({ assessmentCoverageValid: false })
    });
    const emit = vi.fn();
    const recordRouteOutcome = vi.fn();

    expect(handle(output, { emit, recordRouteOutcome })).toMatchObject({
      status: 'handled'
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'dj.pick-next.done', added: false, addedCount: 0,
      reason: 'empty_pool', targetCount: 1
    });
    expect(recordRouteOutcome).toHaveBeenCalledWith('no_candidates');
  });

  it('returns an explicit no-selection result for MusicAgent errors', () => {
    const emit = vi.fn();
    const recordRouteOutcome = vi.fn();
    const output = makeOutput([], { status: 'error' });

    expect(handle(output, { emit, recordRouteOutcome })).toMatchObject({
      status: 'handled'
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'dj.pick-next.done', added: false, addedCount: 0,
      reason: 'error', targetCount: 1
    });
    expect(recordRouteOutcome).toHaveBeenCalledWith('no_candidates');
  });

  it('does not append run-local duplicates and does not invoke another selector', () => {
    const emit = vi.fn();
    const recordRouteOutcome = vi.fn();
    const result = handle(makeOutput([
      pick('401', 'Queued Song', 'Queued Artist', 'balanced fit')
    ]), {
      emit,
      recordRouteOutcome,
      excludeState: { ids: new Set(['401']), dedupeKeys: new Set() }
    });

    expect(result).toMatchObject({ status: 'handled', appendedCount: 0 });
    expect(result.finalQueueDecisions.at(-1)).toMatchObject({
      candidateId: '401',
      decision: { phase: 'final', action: 'reject', reasonCodes: ['queue_track_idempotency'] }
    });
    expect(getQueue('music-agent-result-user')).toEqual([]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dj.debug', selectedTracks: []
    }));
    expect(emit).toHaveBeenCalledWith({
      type: 'dj.pick-next.done', added: false, addedCount: 0,
      reason: 'no-candidates', targetCount: 1
    });
    expect(recordRouteOutcome).toHaveBeenCalledWith('no_candidates');
  });

  it('supersedes a stale run when the user changed the queue meanwhile', () => {
    const initialQueueRevision = getQueueRevision('music-agent-result-user');
    setQueueState('music-agent-result-user', [
      { ncmId: 'user-added', name: 'User Added', artists: ['Listener Pick'] }
    ], 0);
    const recordRouteOutcome = vi.fn();

    const result = handle(makeOutput([
      pick('dj-owned', 'DJ Pick', 'DJ Artist', 'balanced fit')
    ]), {
      initialQueueRevision,
      targetPickCount: 1,
      recordRouteOutcome
    });

    expect(result).toMatchObject({ completion: 'superseded', appendedCount: 0 });
    expect(getQueue('music-agent-result-user').map((track) => track.ncmId))
      .toEqual(['user-added']);
    expect(result.successPublication).toBeUndefined();
    expect(recordRouteOutcome).not.toHaveBeenCalled();
  });
});

function handle(
  output: MusicAgentRunOutput,
  overrides: Partial<Parameters<typeof handleMusicAgentPickNextOutput>[0]> = {}
) {
  return handleMusicAgentPickNextOutput({
    userId: 'music-agent-result-user',
    output,
    excludeState: { ids: new Set(), dedupeKeys: new Set() },
    targetPickCount: 1,
    startedAt: Date.now() - 5,
    discoveryMode: 'explore',
    emit: vi.fn(),
    logger: { warn: vi.fn() },
    fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} }),
    evaluateFinalQueuePick: () => ({ phase: 'final', action: 'select', reasonCodes: ['final_eligible'] }),
    ...overrides
  });
}

function pick(id: string, name: string, artist: string, reason: string) {
  return { id, name, artist, reason, source: 'search' } as const;
}

function makeOutput(
  picks: MusicAgentRunOutput['picks'],
  overrides: Partial<MusicAgentRunOutput> = {}
): MusicAgentRunOutput {
  return {
    status: 'ok',
    mode: 'pick_next',
    say: '顺着当前的氛围往前推。',
    picks,
    rejected: [],
    trace: [{ step: 1, thoughtSummary: 'done', candidateCount: picks.length, elapsedMs: 10 }],
    fallbackReason: null,
    step: 1,
    llmCalls: 1,
    toolCalls: 1,
    elapsedMs: 10,
    queryFunnel: [],
    candidateScoreTable: picks.map((item, index) => ({
      rank: index + 1,
      id: item.id,
      song: item.name ?? item.id,
      artist: item.artist ?? '未知艺人',
      sources: item.source,
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
    ...overrides
  };
}

function lyricsDiagnostics(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'enforce_fit' as const,
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
    ...overrides
  };
}
