import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicCandidate } from '../../src/server/music-agent/schema';
import type { SelectionDecisionTrace } from '../../src/shared/selection';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import {
  createListeningEpisode,
  finalizeListeningEpisode
} from '../../src/server/store/listening-episodes';
import { createExplicitExclusion } from '../../src/server/store/explicit-exclusions';
import { buildDjMemorySnapshot } from '../../src/server/dj-memory/snapshot';
import { createMusicAgentSelectionAdapter } from '../../src/server/dj-memory/music-agent-adapter';
import { evaluateAdmission } from '../../src/server/music-agent/selection-policy/admission';
import { toSelectionPolicyCandidate } from '../../src/server/music-agent/selection-policy/types';
import { buildSelectionJourney } from '../../src/server/dj/selection-journey';
import { getSelectionJourney, saveSelectionJourney } from '../../src/server/store/selection-journeys';
import {
  enqueueSelectionNarration,
  getSelectionNarration
} from '../../src/server/store/selection-narration-outbox';
import { createSelectionJourneyNarrationWorker } from '../../src/server/jobs/selection-journey-narration-worker';
import { recordSelectionReplayRun } from '../../src/server/store/selection-replay';

vi.mock('../../src/server/weather.js', () => ({
  fetchWeather: vi.fn(async () => null)
}));

const scenarios = JSON.parse(fs.readFileSync(
  path.resolve('tests/fixtures/dj-v2/server-scenarios.json'),
  'utf8'
)) as ServerScenarios;

let dataDir: string;
const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-server-scenario-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('DJ v2 offline server scenarios', () => {
  it('carries manual-skip position through Episode → Snapshot → selection pressure', async () => {
    const userId = 'boundary-user';
    for (const episode of scenarios.listeningBoundary) persistSkippedEpisode(userId, episode);
    const snapshot = await buildDjMemorySnapshot({ userId, now: new Date(scenarios.now) });
    const adapter = createMusicAgentSelectionAdapter({ snapshot, request: 'auto-fill' });

    for (const episode of scenarios.listeningBoundary) {
      const reasons = adapter.pressureForCandidate(candidate(episode.track)).map((item) => item.reasonCode);
      expect(reasons.includes('early_skip_track'), episode.episodeId).toBe(episode.expectedEarlySkip);
    }
  });

  it('keeps explicit requests behind hard exclusion and playback gates', async () => {
    const userId = 'explicit-request-user';
    const excluded = scenarios.explicitRequestGates.find((item) => item.kind === 'explicit_track_exclusion')!;
    createExplicitExclusion({
      userId,
      entityType: 'track',
      entityKey: `ncm:${excluded.candidate.id}`,
      provider: 'ncm',
      providerId: excluded.candidate.id,
      displayName: excluded.candidate.name,
      sourceKind: 'listener_instruction',
      sourceRef: { sourceId: 'fixture-explicit-exclusion' },
      createdAt: scenarios.now
    });
    const snapshot = await buildDjMemorySnapshot({ userId, now: new Date(scenarios.now) });
    const adapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'chat-recommend',
      userText: '就放这首'
    });

    for (const gate of scenarios.explicitRequestGates) {
      expect(evaluateAdmission({
        candidate: toSelectionPolicyCandidate(candidate(gate.candidate)),
        context: adapter.policyContext
      })).toEqual({
        phase: 'admission',
        action: 'reject',
        reasonCodes: [gate.expectedReasonCode]
      });
    }
  });

  it('attributes Early Skip only to each primary artist, not a collaborator', async () => {
    const userId = 'collaborator-user';
    for (const episode of scenarios.collaboratorIsolation.episodes) {
      persistSkippedEpisode(userId, {
        ...episode,
        durationMs: 100_000,
        positionMs: 20_000,
        listenedMs: 20_000,
        expectedEarlySkip: true
      });
    }
    const snapshot = await buildDjMemorySnapshot({ userId, now: new Date(scenarios.now) });
    const adapter = createMusicAgentSelectionAdapter({ snapshot, request: 'auto-fill' });
    const reasons = adapter.pressureForCandidate(candidate({
      id: 'guest-new', name: 'Guest Solo', artists: [scenarios.collaboratorIsolation.guestArtist]
    })).map((item) => item.reasonCode);

    expect(reasons).not.toContain('early_skip_artist');
    expect(reasons).not.toContain('early_skip_track');
  });

  it('persists Journey revision 1 pending, then revision 2 polished through the outbox worker', async () => {
    const fixture = scenarios.journeyLifecycle;
    const trace: SelectionDecisionTrace = {
      schemaVersion: 1,
      runId: fixture.runId,
      mode: 'autonomous',
      createdAt: scenarios.now,
      decisions: [{
        stage: 'final', action: 'selected', reasonCode: 'final_eligible',
        candidateId: fixture.track.id, provenance: { source: 'system' }, evidenceRefs: []
      }]
    };
    const pending = buildSelectionJourney({
      trace,
      candidates: [fixture.track],
      revision: fixture.pendingRevision,
      status: 'completed',
      updatedAt: scenarios.now
    });
    recordSelectionReplayRun({
      userId: fixture.userId,
      runId: fixture.runId,
      selectedTrackIds: [fixture.track.id],
      candidateCount: 1,
      eligibleCount: 1,
      appendedCount: 1,
      latencyMs: 1_000,
      hardViolationCount: 0,
      promptJsonStatus: 'valid',
      journeyPublished: true,
      outcome: 'succeeded',
      reasonCodes: ['final_eligible'],
      startedAt: scenarios.now,
      completedAt: scenarios.now
    });
    const saved = saveSelectionJourney({
      userId: fixture.userId,
      factsHash: fixture.factsHash,
      snapshot: pending
    });
    const outbox = enqueueSelectionNarration({
      journeyId: saved.id,
      userId: fixture.userId,
      runId: fixture.runId,
      journeyVersion: pending.journeyVersion,
      factsHash: fixture.factsHash,
      now: new Date(scenarios.now)
    });
    const renderedNarration = '这轮想把「Plastic Love」— 竹内まりや自然地接进队列。夜色里的城市流行律动让这一首自然接进当前队列，希望这一段既顺耳，也保留一点被认真挑过的惊喜。';
    const published: unknown[] = [];
    const worker = createSelectionJourneyNarrationWorker({
      now: () => new Date(scenarios.now),
      client: {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            template: 'selection_flow',
            tone: 'warm',
            selections: [{
              entityId: fixture.track.id,
              reasonCodes: ['final_eligible'],
              reasonText: '夜色里的城市流行律动让这一首自然接进当前队列。'
            }],
            runReasonCodes: []
          }),
          model: 'fixture-llm'
        })
      },
      loadContext: async () => ({
        userId: fixture.userId,
        trace,
        djPersona: '温暖简洁的 DJ',
        toneTags: ['warm'],
        entityWhitelist: [fixture.track]
      }),
      publish: async (_userId, event) => { published.push(event); }
    });

    expect(saved.snapshot).toMatchObject({
      revision: fixture.pendingRevision,
      narration: { status: 'pending' }
    });
    await expect(worker.runOnce()).resolves.toBe('completed');
    const polished = getSelectionJourney(fixture.userId, fixture.runId)!;
    expect(polished.snapshot).toMatchObject({
      revision: fixture.polishedRevision,
      narration: { status: 'polished', text: renderedNarration }
    });
    expect(getSelectionNarration(outbox.id)).toMatchObject({ status: 'completed' });
    expect(published).toEqual([{ type: 'selection.journey', snapshot: polished.snapshot }]);
  });
});

function persistSkippedEpisode(userId: string, episode: ListeningScenario): void {
  const startedAt = new Date(episode.startedAt);
  createListeningEpisode(userId, episode.episodeId, {
    playerInstanceId: 'fixture-player',
    deckId: 'main',
    track: episode.track,
    durationMs: episode.durationMs,
    checkpointSeq: 0
  }, { now: startedAt });
  const finalizedAt = new Date(startedAt.getTime() + Math.max(30_000, episode.listenedMs));
  const result = finalizeListeningEpisode(userId, episode.episodeId, {
    checkpointSeq: 1,
    positionMs: episode.positionMs,
    listenedMs: episode.listenedMs,
    durationMs: episode.durationMs,
    outcome: 'skipped'
  }, { now: finalizedAt });
  if (result.status !== 'updated') throw new Error(`fixture_episode_not_finalized:${episode.episodeId}`);
}

function candidate(track: TrackFixture): MusicCandidate {
  return {
    id: track.id,
    name: track.name,
    artist: track.artists?.join('/') ?? track.artist ?? '',
    sources: ['search'],
    evidence: [],
    scores: {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      contextFit: 0.5,
      novelty: 0.5,
      sourceConfidence: 0.5
    },
    ...(track.qualitySignals ? { qualitySignals: track.qualitySignals } : {})
  };
}

type TrackFixture = {
  id: string;
  name: string;
  artist?: string;
  artists?: string[];
  qualitySignals?: { copyright?: number };
};

type ListeningScenario = {
  episodeId: string;
  track: { id: string; name: string; artists: string[] };
  startedAt: string;
  durationMs: number;
  positionMs: number;
  listenedMs: number;
  expectedEarlySkip: boolean;
};

type ServerScenarios = {
  schemaVersion: number;
  now: string;
  listeningBoundary: ListeningScenario[];
  explicitRequestGates: Array<{
    kind: string;
    candidate: TrackFixture;
    expectedReasonCode: 'explicit_track_exclusion' | 'copyright_unavailable';
  }>;
  collaboratorIsolation: {
    guestArtist: string;
    episodes: Array<Pick<ListeningScenario, 'episodeId' | 'track' | 'startedAt'>>;
  };
  journeyLifecycle: {
    userId: string;
    runId: string;
    track: { id: string; name: string; artist: string };
    factsHash: string;
    pendingRevision: number;
    polishedRevision: number;
    narrationText: string;
  };
};
