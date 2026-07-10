import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DJAgent } from '../../src/server/dj-agent';
import { appendMusicAgentSelectionEvents } from '../../src/server/dj-agent/events';
import type { FinalSelectionResult } from '../../src/server/dj/finalSelectionResult';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { getRecentDjEvents } from '../../src/server/store/dj-events';
import { savePersonalDjContext } from '../../src/server/store/personal-dj-context';
import { getQueue, setQueueState } from '../../src/server/store/queue';
import type { MusicAgentRunOutput } from '../../src/server/music-agent/schema';

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
    savePersonalDjContext({
      userId: 'dj-agent-user',
      uploadedAt: '2026-07-08T11:00:00.000Z',
      payload: createPayload('current-bundle')
    });
    const pickNext = vi.fn(async () => makeOutput([
      { id: '201', name: 'First Song', artist: 'First Artist', reason: 'fits current focus', source: 'search' },
      { id: '202', name: 'Second Song', artist: 'Second Artist', reason: 'keeps stable flow', source: 'liked' },
      { id: '203', name: 'Third Song', artist: 'Third Artist', reason: 'would continue', source: 'search' }
    ]));
    const agent = new DJAgent({
      musicAgentFactory: () => ({ pickNext })
    });

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
      now: new Date('2026-07-08T12:00:00.000Z'),
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger: { warn: vi.fn() },
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('handled');
    expect(pickNext).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        personalDjContext: expect.objectContaining({
          summary: expect.stringContaining('正在写代码')
        })
      })
    }));
    expect(JSON.stringify(pickNext.mock.calls[0][0].context.personalDjContext)).not.toContain('current-bundle');
    expect(getQueue('dj-agent-user')).toMatchObject([
      { ncmId: '201', name: 'First Song', artists: ['First Artist'] },
      { ncmId: '202', name: 'Second Song', artists: ['Second Artist'] }
    ]);

    const events = getRecentDjEvents('dj-agent-user', 10);
    expect(events.map((event) => event.type)).toEqual([
      'queue_changed',
      'selection_completed',
      'track_selected',
      'track_selected',
      'selection_started'
    ]);
    const selectedEvents = events.filter((event) => event.type === 'track_selected');
    expect(selectedEvents).toHaveLength(2);
    expect(selectedEvents.map((event) =>
      (event.payload as { pickOrder?: number }).pickOrder
    )).toEqual([2, 1]);
    expect(selectedEvents.map((event) => event.runId)).toEqual([result.runId, result.runId]);
    expect(selectedEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: '201',
          trackName: 'First Song',
          selectionRationale: 'fits current focus',
          batchRationale: '本次实际补充 2 首：First Artist《First Song》、Second Artist《Second Song》。',
          source: 'search',
          pickOrder: 1
        }),
        expect.objectContaining({
          trackId: '202',
          trackName: 'Second Song',
          selectionRationale: 'keeps stable flow',
          batchRationale: '本次实际补充 2 首：First Artist《First Song》、Second Artist《Second Song》。',
          source: 'liked',
          pickOrder: 2
        })
      ])
    );
    expect(selectedEvents.every((event) =>
      (event.payload as { batchRationale?: string }).batchRationale !== '顺着今天的氛围往前推两首。'
    )).toBe(true);

    const completion = events.find((event) => event.type === 'selection_completed');
    expect(completion?.payload).toEqual({
      finalTrackIds: ['201', '202'],
      finalRationale: '本次实际补充 2 首：First Artist《First Song》、Second Artist《Second Song》。',
      proposedRationale: '顺着今天的氛围往前推两首。',
      targetCount: 2,
      requestedPickCount: 3,
      appendedCount: 2,
      finalPickDiagnostics: makeOutput([]).finalPickDiagnostics,
      skippedPicks: [{
        id: '203',
        name: 'Third Song',
        artist: 'Third Artist',
        reason: 'no_remaining_slots',
        dedupeKey: 'thirdsong::thirdartist'
      }]
    });

    const queueChanged = events.find((event) => event.type === 'queue_changed');
    expect(queueChanged?.payload).toMatchObject({
      action: 'append',
      trackIds: ['201', '202'],
      position: 'end'
    });
    const lastSelectedEvent = selectedEvents.find((event) =>
      (event.payload as { pickOrder?: number }).pickOrder === 2
    );
    expect(completion?.causationEventId).toBe(lastSelectedEvent?.id);
    expect(queueChanged?.causationEventId).toBe(completion?.id);
  });

  it('keeps a successful selection when event persistence fails', async () => {
    const persistenceError = new Error('dj event database unavailable');
    const selectionEventRecorder = vi.fn(() => {
      throw persistenceError;
    });
    const logger = { warn: vi.fn() };
    const agent = new DJAgent({
      musicAgentFactory: () => ({
        pickNext: vi.fn(async () => makeOutput([
          { id: '301', name: 'Safe Song', artist: 'Safe Artist', reason: 'fits', source: 'search' }
        ]))
      }),
      selectionEventRecorder
    });

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
      now: new Date('2026-07-08T12:00:00.000Z'),
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(result.status).toBe('handled');
    expect(getQueue('dj-agent-user')).toMatchObject([{ ncmId: '301' }]);
    expect(selectionEventRecorder).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: persistenceError, runId: result.runId },
      'DJ pick-next: selection event persistence failed'
    );
  });

  it('keeps selecting when the selection_started event cannot be persisted', async () => {
    const persistenceError = new Error('dj event database unavailable at start');
    const selectionStartedEventRecorder = vi.fn(() => {
      throw persistenceError;
    });
    const pickNext = vi.fn(async () => makeOutput([
      { id: '302', name: 'Still Selected', artist: 'Safe Artist', reason: 'fits', source: 'search' }
    ]));
    const logger = { warn: vi.fn() };
    const agent = new DJAgent({
      musicAgentFactory: () => ({ pickNext }),
      selectionStartedEventRecorder
    });

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
      now: new Date('2026-07-08T12:00:00.000Z'),
      emit: vi.fn(),
      broadcastAppended: vi.fn(),
      logger,
      setPickReason: vi.fn(),
      fallbackStatsSnapshot: () => ({ totalRuns: 0, fallbackRuns: 0, fallbackRate: 0, fallbackPaths: {} })
    });

    expect(selectionStartedEventRecorder).toHaveBeenCalledOnce();
    expect(pickNext).toHaveBeenCalledOnce();
    expect(result.status).toBe('handled');
    expect(getQueue('dj-agent-user')).toMatchObject([{ ncmId: '302' }]);
    expect(result.selectionStartedEventId).toBe(result.runId);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: persistenceError, runId: result.runId },
      'DJ pick-next: selection started event persistence failed'
    );
    expect(getRecentDjEvents('dj-agent-user').some((event) =>
      event.type === 'track_selected' && event.causationEventId === result.runId
    )).toBe(true);
  });

  it('rolls back the whole selection event batch when completion validation fails', () => {
    const invalidSelection = {
      tracks: [{ id: '401', name: 'Track', artist: 'Artist', reason: 'reason', source: 'search' }],
      rationale: 'final rationale',
      diagnostics: {
        appendedCount: 1,
        finalPickDiagnostics: {
          targetPickCount: -1,
          rawPickCount: 1,
          eligiblePickCount: 1,
          acceptedPickCount: 1,
          droppedPickCount: 0,
          titleMotifDroppedCount: 0,
          rankedBackfillCount: 0,
          rejectedPickCount: 0
        },
        skippedPicks: []
      }
    } as unknown as FinalSelectionResult;

    expect(() => appendMusicAgentSelectionEvents({
      userId: 'dj-agent-user',
      runId: 'run-invalid',
      finalSelection: invalidSelection,
      selectionStartedEventId: 'selection-started'
    })).toThrow();
    expect(getRecentDjEvents('dj-agent-user')).toEqual([]);
  });

  it('maps final selection metadata into bounded strict event payloads', () => {
    const longId = 'i'.repeat(250);
    const finalSelection = {
      tracks: [{
        id: longId,
        name: 'n'.repeat(350),
        artist: 'a'.repeat(350),
        reason: 'r'.repeat(1100),
        source: 's'.repeat(100)
      }],
      rationale: 'b'.repeat(1100),
      proposedRationale: 'p'.repeat(1100),
      diagnostics: {
        targetCount: 1,
        requestedPickCount: 2,
        appendedCount: 1,
        finalPickDiagnostics: {
          targetPickCount: 1,
          rawPickCount: 2,
          eligiblePickCount: 1,
          acceptedPickCount: 1,
          droppedPickCount: 1,
          titleMotifDroppedCount: 0,
          rankedBackfillCount: 0,
          rejectedPickCount: 0,
          futureDiagnosticCount: 99
        },
        skippedPicks: [{
          id: 'x'.repeat(250),
          name: 'm'.repeat(350),
          artist: 'z'.repeat(350),
          dedupeKey: 'd'.repeat(1100),
          reason: 'no_remaining_slots'
        }]
      }
    } as unknown as FinalSelectionResult;

    appendMusicAgentSelectionEvents({
      userId: 'dj-agent-user',
      runId: 'run-safe-map',
      finalSelection,
      selectionStartedEventId: 'selection-started'
    });

    const events = getRecentDjEvents('dj-agent-user');
    const selected = events.find((event) => event.type === 'track_selected');
    const completion = events.find((event) => event.type === 'selection_completed');
    const selectedPayload = selected?.payload as Record<string, string>;
    const completionPayload = completion?.payload as {
      finalTrackIds: string[];
      finalRationale: string;
      proposedRationale: string;
      finalPickDiagnostics: Record<string, number>;
      skippedPicks: Array<Record<string, string>>;
    };

    expect(selected?.trackId).toHaveLength(200);
    expect(selectedPayload.trackId).toHaveLength(200);
    expect(selectedPayload.trackName).toHaveLength(300);
    expect(selectedPayload.artist).toHaveLength(300);
    expect(selectedPayload.selectionRationale).toHaveLength(1000);
    expect(selectedPayload.batchRationale).toHaveLength(1000);
    expect(selectedPayload.source).toHaveLength(80);
    expect(completionPayload.finalTrackIds[0]).toHaveLength(200);
    expect(completionPayload.finalRationale).toHaveLength(1000);
    expect(completionPayload.proposedRationale).toHaveLength(1000);
    expect(completionPayload.skippedPicks[0]?.id).toHaveLength(200);
    expect(completionPayload.skippedPicks[0]?.name).toHaveLength(300);
    expect(completionPayload.skippedPicks[0]?.artist).toHaveLength(300);
    expect(completionPayload.skippedPicks[0]?.dedupeKey).toHaveLength(1000);
    expect(completionPayload.finalPickDiagnostics).toEqual({
      targetPickCount: 1,
      rawPickCount: 2,
      eligiblePickCount: 1,
      acceptedPickCount: 1,
      droppedPickCount: 1,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 0,
      rejectedPickCount: 0,
      semanticConflictDroppedCount: 0,
      qualityDroppedCount: 0,
      unassessedDroppedCount: 0,
      assessmentValidationFailureCount: 0
    });
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
      targetPickCount: 2,
      rawPickCount: 3,
      eligiblePickCount: 3,
      acceptedPickCount: 2,
      droppedPickCount: 1,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 1,
      rejectedPickCount: 0,
      semanticConflictDroppedCount: 0,
      qualityDroppedCount: 0,
      unassessedDroppedCount: 0,
      assessmentValidationFailureCount: 0
    }
  };
}

function createPayload(bundleId: string) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-08T10:00:00+08:00',
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
