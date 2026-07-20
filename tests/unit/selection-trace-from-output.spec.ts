import { describe, expect, it } from 'vitest';
import { selectionDecisionTraceSchema } from '../../src/shared/selection.js';
import {
  createEmptySelectionTrace,
  selectionTraceFromMusicAgentOutput
} from '../../src/server/dj/selection-trace-from-output.js';
import type { MusicAgentRunOutput } from '../../src/server/music-agent/schema.js';

describe('selection trace from MusicAgent output', () => {
  it('creates a valid empty v1 trace for the running journey', () => {
    expect(createEmptySelectionTrace({
      runId: 'run-1', mode: 'autonomous', createdAt: '2026-07-17T04:00:00.000Z'
    })).toEqual({
      schemaVersion: 1,
      runId: 'run-1',
      mode: 'autonomous',
      createdAt: '2026-07-17T04:00:00.000Z',
      decisions: []
    });
  });

  it('projects only the policy decisions actually carried by MusicAgent output', () => {
    const projected = selectionTraceFromMusicAgentOutput({
      runId: 'run-1',
      createdAt: '2026-07-17T04:00:00.000Z',
      output: output('ok')
    });

    expect(() => selectionDecisionTraceSchema.parse(projected.trace)).not.toThrow();
    expect(projected.trace.decisions.map((decision) => `${decision.stage}:${decision.reasonCode}`)).toEqual([
      'admission:admission_eligible',
      'recall:recall_included',
      'ranking:ranking_scored',
      'batch:batch_selected',
      'final:final_eligible',
      'final:explicit_artist_exclusion'
    ]);
    expect(projected.candidates).toEqual([
      { id: 'selected', name: 'Selected Song', artist: 'Selected Artist' },
      { id: 'rejected', name: 'Rejected Song', artist: 'Rejected Artist' }
    ]);
    expect(JSON.stringify(projected.trace)).not.toContain('adjustedScore');
    expect(JSON.stringify(projected.trace)).not.toContain('private context sentence');
  });

  it('does not invent successful policy stages from a candidate score table', () => {
    const raw = output('ok');
    raw.selectionDecisions = [];
    const projected = selectionTraceFromMusicAgentOutput({
      runId: 'run-no-decisions',
      createdAt: '2026-07-17T04:00:00.000Z',
      output: raw
    });

    expect(projected.trace.decisions).toEqual([]);
    expect(projected.candidates).toHaveLength(2);
  });

  it('carries a public-safe LLM reason only on the matching selected candidate', () => {
    const raw = output('ok');
    raw.picks[0]!.reason = '夜晚氛围柔和，也能让当前队列自然降速。';
    const projected = selectionTraceFromMusicAgentOutput({
      runId: 'run-public-reason',
      createdAt: '2026-07-17T04:00:00.000Z',
      output: raw
    });

    expect(projected.candidates).toEqual([
      {
        id: 'selected',
        name: 'Selected Song',
        artist: 'Selected Artist',
        selectionReason: '夜晚氛围柔和，也能让当前队列自然降速。'
      },
      { id: 'rejected', name: 'Rejected Song', artist: 'Rejected Artist' }
    ]);
  });

  it('adds live queue-apply rejections and dedupes repeated successful final checks', () => {
    const projected = selectionTraceFromMusicAgentOutput({
      runId: 'run-live-final',
      createdAt: '2026-07-17T04:00:00.000Z',
      output: output('ok'),
      finalQueueDecisions: [
        {
          candidateId: 'selected',
          decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] }
        },
        {
          candidateId: 'selected',
          decision: { phase: 'final', action: 'reject', reasonCodes: ['explicit_artist_exclusion'] }
        }
      ]
    });

    expect(projected.trace.decisions.filter((item) =>
      item.stage === 'final' && item.reasonCode === 'final_eligible'
    )).toHaveLength(1);
    expect(projected.trace.decisions).toContainEqual(expect.objectContaining({
      stage: 'final',
      action: 'rejected',
      candidateId: 'selected',
      reasonCode: 'explicit_artist_exclusion'
    }));
  });

  it('marks an unsuccessful run with a stable final failure code', () => {
    const projected = selectionTraceFromMusicAgentOutput({
      runId: 'run-failed',
      createdAt: '2026-07-17T04:00:00.000Z',
      output: output('empty_pool')
    });

    expect(projected.trace.decisions.at(-1)).toMatchObject({
      stage: 'final', action: 'skipped', reasonCode: 'selection_failed'
    });
  });
});

function output(status: MusicAgentRunOutput['status']): MusicAgentRunOutput {
  const ok = status === 'ok';
  return {
    status,
    mode: 'pick_next',
    say: ok ? 'done' : 'empty',
    picks: ok ? [{
      id: 'selected', name: 'Selected Song', artist: 'Selected Artist',
      reason: 'private context sentence', source: 'search'
    }] : [],
    rejected: ok ? [{ id: 'rejected', reason: 'not selected' }] : [],
    trace: [],
    queryFunnel: [],
    candidateScoreTable: [
      row(1, 'selected', 'Selected Song', 'Selected Artist'),
      row(2, 'rejected', 'Rejected Song', 'Rejected Artist')
    ],
    selectionDecisions: ok ? [
      decision('admission', 'admitted', 'admission_eligible', 'selected', 'playback_eligibility'),
      decision('recall', 'recalled', 'recall_included', 'selected', 'system'),
      decision('ranking', 'ranked', 'ranking_scored', 'selected', 'candidate_quality'),
      decision('batch', 'selected', 'batch_selected', 'selected', 'batch_diversity'),
      decision('final', 'selected', 'final_eligible', 'selected', 'playback_eligibility'),
      decision('final', 'rejected', 'explicit_artist_exclusion', 'rejected', 'explicit_exclusion')
    ] : []
  };
}

function decision(
  stage: 'admission' | 'recall' | 'ranking' | 'batch' | 'final',
  action: 'admitted' | 'recalled' | 'ranked' | 'selected' | 'rejected',
  reasonCode: string,
  candidateId: string,
  source: 'playback_eligibility' | 'system' | 'candidate_quality' | 'batch_diversity' | 'explicit_exclusion'
) {
  return { stage, action, reasonCode, candidateId, provenance: { source }, evidenceRefs: [] } as const;
}

function row(rank: number, id: string, song: string, artist: string) {
  return {
    rank, id, song, artist, sources: 'search', baseScore: 0.9,
    artistPenalty: 0.1, trackPenalty: 0, repeatPenalty: 0,
    qualityPenalty: 0, titlePollutionPenalty: 0, adjustedScore: 0.8
  };
}
