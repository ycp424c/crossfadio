import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DJAgent } from '../../src/server/dj-agent';
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
      { id: '202', name: 'Second Song', artist: 'Second Artist', reason: 'keeps stable flow', source: 'liked' }
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
