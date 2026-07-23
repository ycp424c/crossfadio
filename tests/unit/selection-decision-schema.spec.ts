import { describe, expect, it } from 'vitest';
import {
  selectionDecisionTraceSchema,
  selectionJourneySseEventSchema
} from '../../src/shared/selection';

describe('Selection Decision Trace schema', () => {
  it('upgrades a v1 source-attributed phase decision to the current schema', () => {
    const trace = {
      schemaVersion: 1,
      runId: 'run-1',
      mode: 'autonomous',
      createdAt: '2026-07-17T10:00:00.000Z',
      decisions: [{
        stage: 'admission',
        action: 'rejected',
        reasonCode: 'playback_ineligible',
        candidateId: 'track-1',
        provenance: {
          source: 'playback_eligibility',
          sourceRef: 'ncm:track-1'
        },
        evidenceRefs: [{
          kind: 'track_fact',
          id: 'ncm:track-1:privilege',
          observedAt: '2026-07-17T09:59:59.000Z'
        }]
      }]
    };

    expect(selectionDecisionTraceSchema.parse(trace)).toEqual({
      ...trace,
      schemaVersion: 2
    });
  });

  it('bounds evidence references and rejects private trace payloads', () => {
    const decision = {
      stage: 'ranking',
      action: 'lowered',
      reasonCode: 'recent_exposure',
      candidateId: 'track-1',
      provenance: { source: 'listening_exposure' },
      evidenceRefs: Array.from({ length: 9 }, (_, index) => ({
        kind: 'listening_episode',
        id: `episode-${index}`
      }))
    };
    const trace = {
      schemaVersion: 1,
      runId: 'run-1',
      mode: 'autonomous',
      createdAt: '2026-07-17T10:00:00.000Z',
      decisions: [decision]
    };

    expect(selectionDecisionTraceSchema.safeParse(trace).success).toBe(false);
    expect(selectionDecisionTraceSchema.safeParse({
      ...trace,
      decisions: [{ ...decision, evidenceRefs: [], rawPrompt: 'private' }]
    }).success).toBe(false);
  });

  it('publishes a bounded, user-readable Journey snapshot as one SSE event', () => {
    const snapshot = {
      schemaVersion: 1,
      runId: 'run-1',
      journeyVersion: 1,
      revision: 3,
      status: 'running',
      summary: '正在从最近适合专注的方向里挑选。',
      startedAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:02.000Z',
      stages: [{
        stage: 'recall',
        status: 'active',
        title: '寻找候选',
        detail: '从喜欢的音乐和相近作品中寻找。',
        reasonCodes: ['liked_library_recall']
      }],
      candidates: [{
        id: 'track-1',
        name: '富士山下',
        artist: '陈奕迅',
        state: 'considering'
      }],
      selections: [],
      narration: { status: 'pending' }
    };

    expect(selectionJourneySseEventSchema.parse({
      type: 'selection.journey',
      snapshot
    }).snapshot).toEqual(snapshot);
  });

  it('requires polished narration to carry the public DJ note', () => {
    expect(selectionJourneySseEventSchema.safeParse({
      type: 'selection.journey',
      snapshot: {
        schemaVersion: 1,
        runId: 'run-1',
        journeyVersion: 1,
        revision: 4,
        status: 'completed',
        summary: '已经选好下一首。',
        startedAt: '2026-07-17T10:00:00.000Z',
        updatedAt: '2026-07-17T10:00:04.000Z',
        completedAt: '2026-07-17T10:00:04.000Z',
        stages: [],
        candidates: [],
        selections: [],
        narration: { status: 'polished' }
      }
    }).success).toBe(false);
  });
});
