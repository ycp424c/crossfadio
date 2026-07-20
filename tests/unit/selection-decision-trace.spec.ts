import { describe, expect, it } from 'vitest';
import { selectionDecisionTraceSchema } from '../../src/shared/selection.js';
import {
  createSelectionTraceCollector,
  projectSelectionTraceForLog,
  projectSelectionTraceForPrompt
} from '../../src/server/dj/selection-trace-projections.js';
import { createSelectionDecisionRecorder } from '../../src/server/music-agent/selection-policy/decision-trace.js';

describe('selection decision trace', () => {
  it('collects phase decisions into one versioned shared trace with stable reason codes', () => {
    const collector = createSelectionTraceCollector({
      runId: 'run-1',
      mode: 'autonomous',
      createdAt: '2026-07-17T10:00:00.000Z'
    });

    collector.record({
      candidateId: 'track-1',
      decision: {
        phase: 'ranking',
        action: 'rank',
        reasonCodes: ['expressed_preference_match', 'ranking_scored']
      },
      evidenceRefs: Array.from({ length: 12 }, (_, index) => ({
        kind: 'preference_evidence',
        id: `evidence-${index}`
      }))
    });

    const trace = collector.snapshot();
    expect(selectionDecisionTraceSchema.parse(trace)).toEqual(trace);
    expect(trace.decisions).toEqual([
      expect.objectContaining({
        stage: 'ranking', action: 'ranked', reasonCode: 'expressed_preference_match',
        candidateId: 'track-1', provenance: { source: 'preference_evidence' }
      }),
      expect.objectContaining({
        stage: 'ranking', action: 'ranked', reasonCode: 'ranking_scored',
        candidateId: 'track-1', provenance: { source: 'candidate_quality' }
      })
    ]);
    expect(trace.decisions.every((decision) => decision.evidenceRefs.length === 8)).toBe(true);

    const secondSnapshot = collector.snapshot();
    trace.decisions[0]!.evidenceRefs[0]!.id = 'mutated';
    expect(secondSnapshot.decisions[0]!.evidenceRefs[0]!.id).toBe('evidence-0');
  });

  it('projects semantic prompt facts separately from bounded operational logs', () => {
    const collector = createSelectionTraceCollector({
      runId: 'run-2', mode: 'explicit_request', createdAt: '2026-07-17T10:00:00.000Z'
    });
    collector.record({
      candidateId: 'track-2',
      decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] }
    });
    const trace = collector.snapshot();

    expect(projectSelectionTraceForPrompt(trace)).toEqual({
      schemaVersion: 1,
      mode: 'explicit_request',
      decisions: [{
        stage: 'final', action: 'selected', reasonCode: 'final_eligible',
        candidateId: 'track-2', provenance: { source: 'playback_eligibility' }
      }]
    });
    expect(projectSelectionTraceForLog(trace, { timingMs: 125, errorCode: 'llm_timeout' })).toEqual({
      runId: 'run-2',
      decisionCount: 1,
      stageCounts: { final: 1 },
      finalReasonCodes: ['final_eligible'],
      timingMs: 125,
      errorCode: 'llm_timeout'
    });
    expect(projectSelectionTraceForLog(trace)).not.toHaveProperty('decisions');
  });

  it('maps defer decisions without smuggling numeric score contributions into the shared trace', () => {
    const collector = createSelectionTraceCollector({ runId: 'run-3', mode: 'autonomous' });
    collector.record({
      decision: {
        phase: 'batch',
        action: 'defer',
        reasonCodes: ['batch_primary_artist_repeat'],
        contributions: [{
          source: 'batch', reasonCode: 'batch_primary_artist_repeat', direction: 'penalty', amount: 0.7
        }]
      }
    });

    expect(collector.snapshot().decisions).toEqual([
      expect.objectContaining({
        stage: 'batch', action: 'deferred', reasonCode: 'batch_primary_artist_repeat',
        provenance: { source: 'batch_diversity' }
      }),
      expect.objectContaining({
        stage: 'batch', action: 'lowered', reasonCode: 'batch_primary_artist_repeat',
        provenance: { source: 'batch_diversity' }
      })
    ]);
    expect(JSON.stringify(collector.snapshot())).not.toContain('0.7');
  });

  it('preserves ranking contribution reason codes with reason-scoped evidence', () => {
    const recorder = createSelectionDecisionRecorder();
    recorder.record({
      candidateId: 'candidate-pressure',
      decision: {
        phase: 'ranking',
        action: 'rank',
        reasonCodes: ['ranking_scored'],
        contributions: [
          {
            source: 'fresh_preference',
            reasonCode: 'expressed_preference_match',
            direction: 'boost',
            amount: 0.2,
            evidence: { evidenceId: 'evidence-preference' }
          },
          {
            source: 'early_skip',
            reasonCode: 'early_skip_track',
            direction: 'penalty',
            amount: 0.4
          }
        ]
      }
    });

    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({
        reasonCode: 'ranking_scored',
        provenance: { source: 'candidate_quality' },
        evidenceRefs: []
      }),
      expect.objectContaining({
        reasonCode: 'expressed_preference_match',
        action: 'promoted',
        provenance: { source: 'preference_evidence' },
        evidenceRefs: [{ kind: 'preference_evidence', id: 'evidence-preference' }]
      }),
      expect.objectContaining({
        reasonCode: 'early_skip_track',
        action: 'lowered',
        provenance: { source: 'listening_exposure' },
        evidenceRefs: []
      })
    ]);
  });

  it('keeps the real final decision when earlier phase detail exceeds the shared trace limit', () => {
    const recorder = createSelectionDecisionRecorder();
    for (let index = 0; index < 500; index += 1) {
      recorder.record({
        candidateId: `candidate-${index}`,
        decision: { phase: 'admission', action: 'admit', reasonCodes: ['admission_eligible'] }
      });
    }
    recorder.record({
      candidateId: 'winner',
      decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] }
    });

    expect(recorder.snapshot()).toHaveLength(500);
    expect(recorder.snapshot()).toContainEqual(expect.objectContaining({
      stage: 'final', candidateId: 'winner', reasonCode: 'final_eligible'
    }));
  });
});
