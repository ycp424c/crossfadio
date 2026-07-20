import { describe, expect, it } from 'vitest';
import type { SelectionDecisionTrace } from '../../src/shared/selection';
import { buildSelectionJourney } from '../../src/server/dj/selection-journey';

const trace: SelectionDecisionTrace = {
  schemaVersion: 1,
  runId: 'run-journey-1',
  mode: 'autonomous',
  createdAt: '2026-07-17T04:00:00.000Z',
  decisions: [
    {
      stage: 'recall',
      action: 'recalled',
      reasonCode: 'recall_included',
      candidateId: 'song-a',
      provenance: { source: 'taste_profile' },
      evidenceRefs: []
    },
    {
      stage: 'ranking',
      action: 'suppressed',
      reasonCode: 'early_skip_artist_suppression',
      candidateId: 'song-b',
      provenance: {
        source: 'personal_dj_context',
        sourceRef: '用户昨晚说自己很讨厌某位艺人，这是不能公开的原文'
      },
      evidenceRefs: [{ kind: 'private_note', id: 'secret-1' }]
    },
    {
      stage: 'batch',
      action: 'promoted',
      reasonCode: 'batch_selected',
      candidateId: 'song-a',
      provenance: { source: 'batch_diversity' },
      evidenceRefs: []
    },
    {
      stage: 'final',
      action: 'selected',
      reasonCode: 'final_eligible',
      candidateId: 'song-a',
      provenance: { source: 'system' },
      evidenceRefs: []
    }
  ]
};

describe('Selection Journey projection', () => {
  it('builds deterministic public-safe stage copy from the decision trace', () => {
    const journey = buildSelectionJourney({
      trace,
      revision: 3,
      status: 'completed',
      updatedAt: '2026-07-17T04:00:03.000Z',
      candidates: [
        { id: 'song-a', name: 'Plastic Love', artist: '竹内まりや' },
        { id: 'song-b', name: 'Remember Summer Days', artist: '杏里' }
      ]
    });

    expect(journey).toEqual(expect.objectContaining({
      schemaVersion: 1,
      runId: 'run-journey-1',
      journeyVersion: 1,
      revision: 3,
      status: 'completed',
      narration: { status: 'pending' }
    }));
    expect(journey.stages).toHaveLength(5);
    expect(journey.candidates).toEqual([
      { id: 'song-a', name: 'Plastic Love', artist: '竹内まりや', state: 'selected' },
      { id: 'song-b', name: 'Remember Summer Days', artist: '杏里', state: 'excluded' }
    ]);
    expect(journey.selections).toEqual([
      expect.objectContaining({
        trackId: 'song-a',
        reason: '在艺人、来源和标题变化之间兼顾了这一轮的整体搭配。 通过最后校验，加入这一轮选择。'
      })
    ]);

    const publicText = JSON.stringify(journey);
    expect(publicText).not.toContain('很讨厌');
    expect(publicText).not.toContain('secret-1');
    expect(publicText).not.toContain('personal_dj_context');
    expect(publicText).not.toContain('你不喜欢');
  });

  it('marks only the current public stage active for a running journey', () => {
    const runningTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: trace.decisions.slice(0, 1)
    };
    const journey = buildSelectionJourney({
      trace: runningTrace,
      revision: 1,
      status: 'running',
      updatedAt: '2026-07-17T04:00:01.000Z',
      candidates: [{ id: 'song-a', name: 'Plastic Love', artist: '竹内まりや' }]
    });

    expect(journey.stages.map((stage) => stage.status)).toEqual([
      'completed', 'active', 'pending', 'pending', 'pending'
    ]);
    expect(journey.summary).toBe('正在从可用曲目里寻找这轮最合适的选择。');
  });

  it.each(['failed', 'superseded'] as const)(
    'marks narration failed instead of leaving a terminal %s Journey pending',
    (status) => {
      const journey = buildSelectionJourney({
        trace,
        revision: 4,
        status,
        updatedAt: '2026-07-17T04:00:04.000Z',
        candidates: [{ id: 'song-a', name: 'Plastic Love', artist: '竹内まりや' }]
      });

      expect(journey.narration).toEqual({ status: 'failed' });
    }
  );

  it('uses the latest live Final decision instead of showing a rejected pick as selected', () => {
    const liveRejectedTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: [
        ...trace.decisions,
        {
          stage: 'final',
          action: 'rejected',
          reasonCode: 'explicit_artist_exclusion',
          candidateId: 'song-a',
          provenance: { source: 'explicit_exclusion' },
          evidenceRefs: []
        }
      ]
    };
    const journey = buildSelectionJourney({
      trace: liveRejectedTrace,
      revision: 4,
      status: 'completed',
      updatedAt: '2026-07-17T04:00:04.000Z',
      candidates: [{ id: 'song-a', name: 'Plastic Love', artist: '竹内まりや' }]
    });

    expect(journey.candidates).toEqual([
      { id: 'song-a', name: 'Plastic Love', artist: '竹内まりや', state: 'excluded' }
    ]);
    expect(journey.selections).toEqual([]);
    expect(journey.stages.at(-1)?.detail).toBe('遵守了你明确设置的艺人排除。');
  });

  it('combines the real directive, preference and batch reasons for a selected track', () => {
    const reasonTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: [
        {
          stage: 'ranking',
          action: 'promoted',
          reasonCode: 'active_directive_match',
          candidateId: 'song-a',
          provenance: { source: 'active_directive' },
          evidenceRefs: []
        },
        {
          stage: 'ranking',
          action: 'promoted',
          reasonCode: 'expressed_preference_match',
          candidateId: 'song-a',
          provenance: { source: 'preference_evidence' },
          evidenceRefs: []
        },
        {
          stage: 'batch',
          action: 'selected',
          reasonCode: 'batch_selected',
          candidateId: 'song-a',
          provenance: { source: 'batch_diversity' },
          evidenceRefs: []
        },
        {
          stage: 'final',
          action: 'selected',
          reasonCode: 'final_eligible',
          candidateId: 'song-a',
          provenance: { source: 'system' },
          evidenceRefs: []
        }
      ]
    };
    const journey = buildSelectionJourney({
      trace: reasonTrace,
      revision: 5,
      status: 'completed',
      updatedAt: '2026-07-17T04:00:05.000Z',
      candidates: [{ id: 'song-a', name: 'Plastic Love', artist: '竹内まりや' }]
    });

    expect(journey.selections[0]?.reason).toContain('符合你当前给 DJ 的方向');
    expect(journey.selections[0]?.reason).toContain('符合你明确表达过的偏好');
    expect(journey.selections[0]?.reason).toContain('整体搭配');
    expect(journey.selections[0]?.reason).not.toBe('通过最后校验，加入这一轮选择。');
  });
});
