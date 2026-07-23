import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionDecisionTrace, SelectionJourneySnapshot } from '../../src/shared/selection';
import {
  beginForegroundLlmWork,
  isForegroundLlmBusy,
  registerForegroundLlmPreemptor,
  resetForegroundLlmActivityForTests
} from '../../src/server/llm/foreground-activity';
import {
  createSelectionNarrationRuntime,
  loadSelectionNarrationContext
} from '../../src/server/jobs/selection-narration-runtime';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { upsertDjConfigurationEntry } from '../../src/server/store/dj-configuration';
import { saveSelectionDebugTrace } from '../../src/server/store/selection-debug-traces';
import { saveSelectionJourney } from '../../src/server/store/selection-journeys';
import { enqueueSelectionNarration } from '../../src/server/store/selection-narration-outbox';

let dataDir: string;

const trace: SelectionDecisionTrace = {
  schemaVersion: 2,
  runId: 'run-runtime',
  mode: 'autonomous',
  createdAt: '2026-07-17T10:00:00.000Z',
  decisions: [{
    stage: 'final',
    action: 'selected',
    reasonCode: 'final_eligible',
    candidateId: 'track-1',
    provenance: { source: 'playback_eligibility' },
    evidenceRefs: []
  }]
};

const snapshot: SelectionJourneySnapshot = {
  schemaVersion: 1,
  runId: 'run-runtime',
  journeyVersion: 1,
  revision: 1,
  status: 'completed',
  summary: '已经选好下一首。',
  startedAt: '2026-07-17T10:00:00.000Z',
  updatedAt: '2026-07-17T10:00:03.000Z',
  completedAt: '2026-07-17T10:00:03.000Z',
  stages: [{
    stage: 'finalizing',
    status: 'completed',
    title: '确定选择',
    detail: '播放资格已通过。',
    reasonCodes: ['final_eligible']
  }],
  candidates: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや', state: 'selected' }],
  selections: [{
    trackId: 'track-1',
    trackName: 'Plastic Love',
    artist: '竹内まりや',
    reason: '符合当前的搭配。'
  }],
  narration: { status: 'pending' }
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-narration-runtime-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
  resetForegroundLlmActivityForTests();
});

afterEach(() => {
  resetForegroundLlmActivityForTests();
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CROSSFADIO_DATA_DIR;
});

describe('selection narration runtime', () => {
  it('loads only the persisted trace, structured persona and Journey entities', async () => {
    upsertDjConfigurationEntry({
      userId: 'user-1', kind: 'persona', entryKey: 'default',
      value: { text: '温暖、简洁的 DJ' }, sourceKind: 'user_corpus'
    });
    upsertDjConfigurationEntry({
      userId: 'user-1', kind: 'narration_tone', entryKey: 'default',
      value: ['warm', 'playful', 'private-diary'], sourceKind: 'settings'
    });
    saveSelectionDebugTrace({ userId: 'user-1', trace });
    const journey = saveSelectionJourney({ userId: 'user-1', factsHash: 'facts-1', snapshot });
    const record = enqueueSelectionNarration({
      journeyId: journey.id,
      userId: 'user-1',
      runId: snapshot.runId,
      journeyVersion: snapshot.journeyVersion,
      factsHash: 'facts-1'
    });

    await expect(loadSelectionNarrationContext(record, journey)).resolves.toEqual({
      userId: 'user-1',
      trace,
      djPersona: '温暖、简洁的 DJ',
      toneTags: ['warm', 'playful', 'private-diary'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    });
  });

  it('preempts active narration as soon as foreground LLM work starts', async () => {
    const preempt = vi.fn();
    const unregister = registerForegroundLlmPreemptor(preempt);

    const releaseFirst = beginForegroundLlmWork();
    const releaseSecond = beginForegroundLlmWork();
    expect(preempt).toHaveBeenCalledTimes(2);
    expect(isForegroundLlmBusy()).toBe(true);
    releaseFirst();
    expect(isForegroundLlmBusy()).toBe(true);
    releaseSecond();
    expect(isForegroundLlmBusy()).toBe(false);

    unregister();
    beginForegroundLlmWork()();
    expect(preempt).toHaveBeenCalledTimes(2);
  });

  it('registers the runtime worker as a foreground preemption target', () => {
    const preempt = vi.fn();
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const runtime = createSelectionNarrationRuntime({
      createWorker: vi.fn().mockReturnValue({ runOnce: vi.fn(), start, stop, preempt })
    });

    runtime.start();
    beginForegroundLlmWork()();
    expect(start).toHaveBeenCalledOnce();
    expect(preempt).toHaveBeenCalledOnce();
    return expect(runtime.stop()).resolves.toBeUndefined();
  });
});
