import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DJAgent } from '../../src/server/dj-agent';
import { getDb, initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { savePersonalDjContext } from '../../src/server/store/personal-dj-context';
import { getQueue, getQueueRevision, setQueueState } from '../../src/server/store/queue';
import { getPref, setPref } from '../../src/server/store/prefs';
import { getSelectionDebugTrace } from '../../src/server/store/selection-debug-traces';
import { getSelectionJourney } from '../../src/server/store/selection-journeys';
import { getSelectionRotationSnapshot } from '../../src/server/store/selection-rotation';
import { createExplicitExclusion } from '../../src/server/store/explicit-exclusions';
import {
  buildSourceReservoirIdentity,
  listSourceReservoir,
  recordSourceReservoirFetch
} from '../../src/server/store/source-reservoir';
import type { MusicAgentRunOutput } from '../../src/server/music-agent/schema';
import type { PickNextInput } from '../../src/server/music-agent';

vi.mock('../../src/server/weather', () => ({
  fetchWeather: vi.fn(async () => null)
}));

vi.mock('../../src/server/daily-theme', () => ({
  getDailyTheme: vi.fn(() => ({
    date: '2026-07-17',
    theme: '盛夏微风',
    keywords: ['city pop', '清亮'],
    generatedAt: Date.parse('2026-07-17T00:00:00.000Z')
  }))
}));

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-agent-pick-next-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
  setQueueState('dj-agent-user', [], 0);
});

afterEach(() => {
  _resetDbForTest();
  setQueueState('dj-agent-user', [], 0);
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('DJAgent pick-next orchestration', () => {
  it('passes Personal DJ Context into MusicAgent and records selection events', async () => {
    setPref('dj-agent-user', 'discovery.mode', 'comfort');
    savePersonalDjContext({
      userId: 'dj-agent-user',
      uploadedAt: '2026-07-17T05:00:00.000Z',
      now: new Date('2026-07-17T05:00:00.000Z'),
      payload: createPayload('current-bundle', '2026-07-17T04:00:00.000Z')
    });
    seedReservoir([
      { id: '201', name: 'First Song', artists: ['First Artist'] },
      { id: 'reservoir-left', name: 'Reservoir Left', artists: ['Other Artist'] }
    ]);
    const output = makeOutput([
      { id: '201', name: 'First Song', artist: 'First Artist', reason: 'fits current focus', source: 'search' },
      { id: '202', name: 'Second Song', artist: 'Second Artist', reason: 'keeps stable flow', source: 'liked' }
    ]);
    const pickNext = vi.fn(async (pickInput: PickNextInput) => {
      const phaseByStage = {
        recall: ['admission', 'recall'],
        filtering: ['admission', 'recall', 'ranking'],
        balancing: ['admission', 'recall', 'ranking', 'batch'],
        finalizing: ['admission', 'recall', 'ranking', 'batch', 'final']
      } as const;
      for (const stage of ['recall', 'filtering', 'balancing', 'finalizing'] as const) {
        pickInput.onProgress?.({
          stage,
          selectionDecisions: output.selectionDecisions!.filter((decision) => (
            (phaseByStage[stage] as readonly string[]).includes(decision.stage)
          )),
          candidates: output.picks.map((pick) => ({
            id: pick.id,
            name: pick.name ?? pick.id,
            artist: pick.artist ?? ''
          }))
        });
      }
      return output;
    });
    const agent = new DJAgent({
      musicAgentFactory: () => ({ pickNext })
    });
    const emit = vi.fn();
    const broadcastAppended = vi.fn(() => {
      expect(getQueue('dj-agent-user').map((track) => track.ncmId)).toEqual(['201', '202']);
    });

    const result = await agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: true,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 25,
      discoveryMode: 'comfort',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('handled');
    expect(pickNext).toHaveBeenCalledWith(expect.objectContaining({
      selectionAdapter: expect.objectContaining({
        snapshotId: expect.any(String),
        runtimeContext: expect.objectContaining({
          discoveryMode: 'comfort',
          currentMoment: expect.objectContaining({
            dailyTheme: '盛夏微风（city pop、清亮）'
          }),
          personalDjContext: expect.objectContaining({
            summary: expect.stringContaining('正在写代码'),
            currentState: expect.objectContaining({
              activity: 'coding',
              attention: 'low_distraction'
            }),
            musicHints: [expect.objectContaining({
              kind: 'style',
              label: 'low-distraction city pop'
            })]
          })
        }),
        policyContext: expect.objectContaining({ mode: 'autonomous' })
      })
    }));
    expect(pickNext.mock.calls[0][0]).not.toHaveProperty('context');
    expect(JSON.stringify(pickNext.mock.calls[0][0].selectionAdapter.runtimeContext.personalDjContext))
      .not.toContain('current-bundle');
    expect(getQueue('dj-agent-user')).toMatchObject([
      { ncmId: '201', name: 'First Song', artists: ['First Artist'] },
      { ncmId: '202', name: 'Second Song', artists: ['Second Artist'] }
    ]);
    expect(listSourceReservoir({
      userId: 'dj-agent-user', now: new Date('2026-07-17T12:01:00.000Z')
    }).flatMap((source) => source.tracks.map((track) => String(track.id))))
      .toEqual(['reservoir-left']);
    expect(broadcastAppended).toHaveBeenCalledTimes(1);

    const events = getRecentDjEvents('dj-agent-user', 10);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['selection_started', 'track_selected', 'queue_changed'])
    );
    const selectedEvents = events.filter((event) => event.type === 'track_selected');
    expect(selectedEvents).toHaveLength(2);
    expect(selectedEvents.map((event) => event.runId)).toEqual([result.runId, result.runId]);
    expect(selectedEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: '201',
          trackName: 'First Song',
          selectionRationale: 'fits current focus',
          batchRationale: '顺着今天的氛围往前推两首。'
        }),
        expect.objectContaining({
          trackId: '202',
          trackName: 'Second Song',
          selectionRationale: 'keeps stable flow'
        })
      ])
    );
    expect(events.find((event) => event.type === 'queue_changed')?.payload).toMatchObject({
      action: 'append',
      trackIds: ['201', '202'],
      position: 'end'
    });
    expect(getSelectionRotationSnapshot('dj-agent-user')).toMatchObject({
      currentRound: 1,
      picks: [
        { runId: result.runId, roundNumber: 1, trackId: '201', pickOrder: 1 },
        { runId: result.runId, roundNumber: 1, trackId: '202', pickOrder: 2 }
      ]
    });

    const journeyEvents = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'selection.journey');
    expect(journeyEvents.map((event) => ({
      revision: event.snapshot.revision,
      status: event.snapshot.status
    }))).toEqual([
      { revision: 0, status: 'running' },
      { revision: 1, status: 'running' },
      { revision: 2, status: 'running' },
      { revision: 3, status: 'running' },
      { revision: 4, status: 'running' },
      { revision: 5, status: 'completed' }
    ]);
    expect(getSelectionJourney('dj-agent-user', result.runId)?.snapshot).toMatchObject({
      revision: 5,
      status: 'completed'
    });
    expect(journeyEvents.slice(0, 5).map((event) => (
      event.snapshot.stages.find((stage) => stage.status === 'active')?.stage
    ))).toEqual(['understanding', 'recall', 'filtering', 'balancing', 'finalizing']);
    expect(getDb().prepare(`
      SELECT status, journey_version AS journeyVersion, facts_hash AS factsHash
      FROM selection_narration_outbox WHERE run_id = ?
    `).get(result.runId)).toMatchObject({
      status: 'pending',
      journeyVersion: 1,
      factsHash: expect.any(String)
    });
    expect(getSelectionDebugTrace('dj-agent-user', result.runId, { now: new Date('2026-07-17T12:00:01.000Z') })?.trace.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'admission', reasonCode: 'admission_eligible' }),
        expect.objectContaining({ stage: 'recall', reasonCode: 'recall_included' }),
        expect.objectContaining({ stage: 'ranking', reasonCode: 'ranking_scored' }),
        expect.objectContaining({ stage: 'batch', reasonCode: 'batch_selected' }),
        expect.objectContaining({ stage: 'final', reasonCode: 'final_eligible' })
      ])
    );
    expect(getDb().prepare(`
      SELECT appended_count AS appendedCount, candidate_count AS candidateCount,
             outcome, journey_published AS journeyPublished,
             prompt_json_status AS promptJsonStatus,
             narration_status AS narrationStatus,
             narration_deadline_at AS narrationDeadlineAt
      FROM selection_replay_runs WHERE run_id = ?
    `).get(result.runId)).toEqual({
      appendedCount: 2,
      candidateCount: 2,
      outcome: 'succeeded',
      journeyPublished: 1,
      promptJsonStatus: 'valid',
      narrationStatus: 'pending',
      narrationDeadlineAt: '2026-07-18T12:00:00.000Z'
    });
    expect(JSON.stringify(getSelectionDebugTrace('dj-agent-user', result.runId, { now: new Date('2026-07-17T12:00:01.000Z') })?.trace)).not.toContain('baseScore');
  });

  it('persists and emits revision 1 failed when MusicAgent returns no selection', async () => {
    const emptyOutput = { ...makeOutput([]), status: 'empty_pool' as const };
    const agent = new DJAgent({
      musicAgentFactory: () => ({ pickNext: vi.fn(async () => emptyOutput) })
    });
    const emit = vi.fn();

    const result = await agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('aborted');
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'selection.journey')
      .map((event) => [event.snapshot.revision, event.snapshot.status]))
      .toEqual([[0, 'running'], [1, 'failed']]);
    expect(getSelectionJourney('dj-agent-user', result.runId)?.snapshot.status).toBe('failed');
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM selection_narration_outbox WHERE run_id = ?'
    ).get(result.runId)).toEqual({ count: 0 });
    expect(getSelectionDebugTrace('dj-agent-user', result.runId, { now: new Date('2026-07-17T12:00:01.000Z') })?.trace.decisions.at(-1)).toMatchObject({
      stage: 'final',
      action: 'skipped',
      reasonCode: 'selection_failed'
    });
  });

  it('does not commit or emit a failed Journey when its final replay update fails', async () => {
    const emptyOutput = { ...makeOutput([]), status: 'empty_pool' as const };
    const agent = new DJAgent({
      musicAgentFactory: () => ({ pickNext: vi.fn(async () => emptyOutput) })
    });
    const emit = vi.fn();
    getDb().exec(`
      CREATE TRIGGER inject_empty_replay_failure
      BEFORE UPDATE OF completed_at ON selection_replay_runs
      WHEN NEW.outcome = 'empty' AND NEW.completed_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected empty replay failure');
      END;
    `);

    await expect(agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 2,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    })).rejects.toThrow('injected empty replay failure');

    expect(getDb().prepare(`
      SELECT outcome, completed_at AS completedAt
      FROM selection_replay_runs WHERE user_id = ?
    `).get('dj-agent-user')).toMatchObject({ outcome: 'failed', completedAt: expect.any(String) });
    expect(getDb().prepare(`
      SELECT status FROM selection_journeys WHERE user_id = ? ORDER BY revision DESC LIMIT 1
    `).get('dj-agent-user')).toEqual({ status: 'running' });
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'selection.journey')
      .map((event) => event.snapshot.status)).toEqual(['running']);
  });

  it('does not commit or emit a completed Journey when the final replay update fails', async () => {
    const originalQueue = [
      { ncmId: 'already-queued', name: 'Already Queued', artists: ['Existing Artist'] }
    ];
    seedReservoir([
      { id: 'atomic-1', name: 'Atomic Song', artists: ['Atomic Artist'] },
      { id: 'atomic-left', name: 'Atomic Left', artists: ['Other Artist'] }
    ]);
    setQueueState('dj-agent-user', originalQueue, 0);
    const persistedQueueBefore = getPref('dj-agent-user', 'queue.state.v2');
    const agent = new DJAgent({
      musicAgentFactory: () => ({
        pickNext: vi.fn(async () => makeOutput([
          { id: 'atomic-1', name: 'Atomic Song', artist: 'Atomic Artist', reason: 'fits', source: 'search' }
        ]))
      })
    });
    const emit = vi.fn();
    const broadcastAppended = vi.fn();
    const setPickReason = vi.fn();
    const excludeState = { ids: new Set<string>(), dedupeKeys: new Set<string>() };
    getDb().exec(`
      CREATE TRIGGER inject_final_replay_failure
      BEFORE UPDATE OF narration_status ON selection_replay_runs
      WHEN NEW.narration_status = 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'injected final replay failure');
      END
    `);

    await expect(agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState,
      initialQueueLength: originalQueue.length,
      initialQueueRevision: getQueueRevision('dj-agent-user'),
      targetPickCount: 1,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended,
      logger: { warn: vi.fn() },
      setPickReason,
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    })).rejects.toThrow('injected final replay failure');

    expect(getQueue('dj-agent-user')).toEqual(originalQueue);
    expect(listSourceReservoir({
      userId: 'dj-agent-user', now: new Date('2026-07-17T12:01:00.000Z')
    }).flatMap((source) => source.tracks.map((track) => String(track.id))).sort())
      .toEqual(['atomic-1', 'atomic-left']);
    expect(getPref('dj-agent-user', 'queue.state.v2')).toEqual(persistedQueueBefore);
    expect(broadcastAppended).not.toHaveBeenCalled();
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'queue-updated'
        || (event.type === 'dj.pick-next.done' && event.added === true)))
      .toEqual([]);
    expect(setPickReason).not.toHaveBeenCalled();
    expect(excludeState.ids).toEqual(new Set());
    expect(excludeState.dedupeKeys).toEqual(new Set());
    expect(getRecentDjEvents('dj-agent-user', 10)
      .filter((event) => event.type === 'track_selected' || event.type === 'queue_changed'))
      .toEqual([]);
    const replay = getDb().prepare(`
      SELECT outcome, narration_status AS narrationStatus
      FROM selection_replay_runs WHERE user_id = ?
    `).get('dj-agent-user');
    expect(replay).toEqual({ outcome: 'failed', narrationStatus: 'not_applicable' });
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM selection_narration_outbox WHERE user_id = ?'
    ).get('dj-agent-user')).toEqual({ count: 0 });
    expect(getDb().prepare(`
      SELECT status FROM selection_journeys WHERE user_id = ? ORDER BY revision DESC LIMIT 1
    `).get('dj-agent-user')).toEqual({ status: 'running' });
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'selection.journey')
      .map((event) => event.snapshot.status)).toEqual(['running']);
  });

  it('publishes a failed Journey when the live final gate rejects every pick', async () => {
    const output = makeOutput([
      { id: '301', name: 'Late Blocked', artist: 'Blocked Artist', reason: 'initially eligible', source: 'search' }
    ]);
    const agent = new DJAgent({
      musicAgentFactory: () => ({
        pickNext: vi.fn(async () => {
          createExplicitExclusion({
            userId: 'dj-agent-user',
            entityType: 'track',
            entityKey: 'late blocked blocked artist',
            provider: 'ncm',
            providerId: '301',
            displayName: 'Late Blocked',
            sourceKind: 'listener_instruction',
            sourceRef: { sourceId: 'late-exclusion' }
          });
          return output;
        })
      })
    });
    const emit = vi.fn();

    const result = await agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result).toMatchObject({ status: 'handled', appendedCount: 0 });
    expect(getQueue('dj-agent-user')).toEqual([]);
    const journey = getSelectionJourney('dj-agent-user', result.runId)!.snapshot;
    expect(journey).toMatchObject({ status: 'failed', selections: [] });
    expect(journey.candidates).toContainEqual(expect.objectContaining({ id: '301', state: 'excluded' }));
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM selection_narration_outbox WHERE run_id = ?'
    ).get(result.runId)).toEqual({ count: 0 });
  });

  it('records a failed replay run when MusicAgent throws after the run starts', async () => {
    const agent = new DJAgent({
      musicAgentFactory: () => ({
        pickNext: vi.fn(async () => { throw new Error('provider unavailable'); })
      })
    });

    await expect(agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    })).rejects.toThrow('provider unavailable');

    expect(getDb().prepare(`
      SELECT outcome, prompt_json_status AS promptJsonStatus,
             journey_published AS journeyPublished, completed_at AS completedAt,
             reason_codes_json AS reasonCodes
      FROM selection_replay_runs WHERE user_id = ?
    `).get('dj-agent-user')).toMatchObject({
      outcome: 'failed',
      promptJsonStatus: 'not_observed',
      journeyPublished: 1,
      completedAt: expect.any(String),
      reasonCodes: JSON.stringify(['selection_run_failed'])
    });
    expect(getDb().prepare(`
      SELECT status FROM selection_journeys WHERE user_id = ? ORDER BY revision DESC LIMIT 1
    `).get('dj-agent-user')).toEqual({ status: 'failed' });
  });

  it('rolls back the thrown-run failed Journey when its replay finalization fails', async () => {
    const agent = new DJAgent({
      musicAgentFactory: () => ({
        pickNext: vi.fn(async () => { throw new Error('provider unavailable'); })
      })
    });
    const emit = vi.fn();
    getDb().exec(`
      CREATE TRIGGER inject_thrown_replay_failure
      BEFORE UPDATE OF completed_at ON selection_replay_runs
      WHEN NEW.outcome = 'failed' AND NEW.completed_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected thrown replay failure');
      END;
    `);

    await expect(agent.pickNext({
      userId: 'dj-agent-user',
      ncmClient: {} as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      includeDailyTheme: false,
      excludeState: { ids: new Set(), dedupeKeys: new Set() },
      initialQueueLength: 0,
      targetPickCount: 1,
      startedAt: Date.now() - 25,
      discoveryMode: 'explore',
      now: new Date('2026-07-17T12:00:00.000Z'),
      emit,
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    })).rejects.toThrow('injected thrown replay failure');

    expect(getDb().prepare(`
      SELECT outcome, completed_at AS completedAt
      FROM selection_replay_runs WHERE user_id = ?
    `).get('dj-agent-user')).toEqual({ outcome: 'failed', completedAt: null });
    expect(getDb().prepare(`
      SELECT status FROM selection_journeys WHERE user_id = ? ORDER BY revision DESC LIMIT 1
    `).get('dj-agent-user')).toEqual({ status: 'running' });
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'selection.journey')
      .map((event) => event.snapshot.status)).toEqual(['running']);
  });
});

function makeOutput(picks: MusicAgentRunOutput['picks']): MusicAgentRunOutput {
  return {
    status: 'ok',
    mode: 'pick_next',
    say: '顺着今天的氛围往前推两首。',
    picks,
    rejected: [],
    trace: [{ step: 1, thoughtSummary: 'done', candidateCount: picks.length, elapsedMs: 10 }],
    fallbackReason: null,
    step: 1,
    llmCalls: 1,
    toolCalls: 1,
    elapsedMs: 10,
    queryFunnel: [],
    promptJsonStatus: 'valid',
    candidateScoreTable: picks.map((pick, index) => ({
      rank: index + 1,
      id: pick.id,
      song: pick.name ?? pick.id,
      artist: pick.artist ?? 'unknown',
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
    selectionDecisions: picks.flatMap((pick) => [
      traceDecision('admission', 'admitted', 'admission_eligible', pick.id),
      traceDecision('recall', 'recalled', 'recall_included', pick.id),
      traceDecision('ranking', 'ranked', 'ranking_scored', pick.id),
      traceDecision('batch', 'selected', 'batch_selected', pick.id),
      traceDecision('final', 'selected', 'final_eligible', pick.id)
    ])
  };
}

function seedReservoir(tracks: Array<{ id: string; name: string; artists: string[] }>): void {
  recordSourceReservoirFetch({
    userId: 'dj-agent-user',
    runId: 'reservoir-seed-run',
    identity: buildSourceReservoirIdentity({ sourceKind: 'search', sourceRef: 'reservoir seed' }),
    displayName: 'reservoir seed',
    candidateSource: 'search',
    provenanceKind: 'exact_recall',
    tracks,
    fetchedAt: new Date('2026-07-17T11:00:00.000Z')
  });
}

function traceDecision(
  stage: 'admission' | 'recall' | 'ranking' | 'batch' | 'final',
  action: 'admitted' | 'recalled' | 'ranked' | 'selected',
  reasonCode: string,
  candidateId: string
) {
  return {
    stage,
    action,
    reasonCode,
    candidateId,
    provenance: { source: 'system' as const },
    evidenceRefs: []
  };
}

function createPayload(bundleId: string, generatedAt: string) {
  return {
    schemaVersion: 1,
    generatedAt,
    summary: '正在写代码，适合稳定、低干扰的音乐。',
    currentState: {
      activity: 'coding',
      energy: 'medium',
      attention: 'low_distraction',
      mood: 'focused'
    },
    musicGuidance: {
      energyCurve: 'steady',
      preferredTextures: ['steady rhythm'],
      avoidTextures: ['too noisy'],
      vocalPreference: 'mixed',
      novelty: 'balanced'
    },
    musicHints: [
      {
        kind: 'style',
        label: 'low-distraction city pop',
        strength: 'medium',
        reason: 'fits current focus state'
      }
    ],
    segueGuidance: {
      tone: 'familiar but discreet',
      privacyRule: 'Acknowledge broad state only; do not reveal concrete private details.'
    },
    source: {
      kind: 'lifemesh_bundle',
      bundleId,
      sliceRefs: [
        {
          sliceId: `${bundleId}-slice`,
          evidenceRole: 'context',
          citationLabel: 'manual-input-v1:test'
        }
      ]
    }
  };
}
