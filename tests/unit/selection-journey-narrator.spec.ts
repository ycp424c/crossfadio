import { describe, expect, it, vi } from 'vitest';
import type { SelectionDecisionTrace, SelectionJourneySnapshot } from '../../src/shared/selection';
import {
  buildSelectionJourneyNarrationFacts,
  narrateSelectionJourney
} from '../../src/server/dj/selection-journey-narrator';

const trace: SelectionDecisionTrace = {
  schemaVersion: 1,
  runId: 'run-1',
  mode: 'autonomous',
  createdAt: '2026-07-17T10:00:00.000Z',
  decisions: [
    {
      stage: 'recall',
      action: 'recalled',
      reasonCode: 'recall_included',
      candidateId: 'track-1',
      provenance: { source: 'personal_dj_context', sourceRef: '不要公开的生活原文' },
      evidenceRefs: [{ kind: 'private_note', id: 'secret-1' }]
    },
    {
      stage: 'final',
      action: 'selected',
      reasonCode: 'final_eligible',
      candidateId: 'track-1',
      provenance: { source: 'system' },
      evidenceRefs: []
    }
  ]
};

const journey: SelectionJourneySnapshot = {
  schemaVersion: 1,
  runId: 'run-1',
  journeyVersion: 1,
  revision: 2,
  status: 'completed',
  summary: '这一轮已经选好。',
  startedAt: '2026-07-17T10:00:00.000Z',
  updatedAt: '2026-07-17T10:00:03.000Z',
  completedAt: '2026-07-17T10:00:03.000Z',
  stages: [
    {
      stage: 'recall', status: 'completed', title: '寻找候选',
      detail: '候选进入这一轮。', reasonCodes: ['recall_included']
    },
    {
      stage: 'finalizing', status: 'completed', title: '确定选择',
      detail: '完成最后选择。', reasonCodes: ['final_eligible']
    }
  ],
  candidates: [
    { id: 'track-1', name: 'Plastic Love', artist: '竹内まりや', state: 'selected' }
  ],
  selections: [
    { trackId: 'track-1', trackName: 'Plastic Love', artist: '竹内まりや', reason: '整体搭配更平衡。' }
  ],
  narration: { status: 'pending' }
};

describe('Selection Journey narrator', () => {
  it('projects only public Journey facts, whitelisted entities and allowed tone tags', () => {
    const facts = buildSelectionJourneyNarrationFacts({
      journey,
      trace,
      djPersona: '一个温暖但不啰嗦的夜间 DJ',
      toneTags: ['warm', 'private-diary', 'playful'],
      entityWhitelist: [
        { id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }
      ]
    });

    expect(facts).toMatchObject({
      runId: 'run-1',
      djPersona: '一个温暖但不啰嗦的夜间 DJ',
      toneTags: ['warm', 'playful']
    });
    expect(facts.candidates[0]).toEqual({
      id: 'track-1', name: 'Plastic Love', artist: '竹内まりや', state: 'selected'
    });
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain('不要公开');
    expect(serialized).not.toContain('secret-1');
    expect(serialized).not.toContain('personal_dj_context');
    expect(serialized).not.toContain('private-diary');
  });

  it('rejects entities outside the whitelist and reason facts absent from Trace', () => {
    expect(() => buildSelectionJourneyNarrationFacts({
      journey,
      trace,
      djPersona: 'DJ',
      toneTags: [],
      entityWhitelist: []
    })).toThrow('narration_entity_not_whitelisted');

    const traceWithoutRecall = { ...trace, decisions: trace.decisions.slice(1) };
    expect(() => buildSelectionJourneyNarrationFacts({
      journey,
      trace: traceWithoutRecall,
      djPersona: 'DJ',
      toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).toThrow('narration_reason_not_in_trace');
  });

  it('renders a user-friendly narration from a validated controlled plan', async () => {
    const signal = new AbortController().signal;
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: [{ entityId: 'track-1', reasonCodes: ['final_eligible'] }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey,
      trace,
      djPersona: '一个温暖但不啰嗦的夜间 DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }],
      signal
    })).resolves.toBe(
      '这轮想把「Plastic Love」— 竹内まりや自然地接进队列。通过最后校验，加入这一轮选择，希望这一段既顺耳，也保留一点被认真挑过的惊喜。'
    );
    expect(complete).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      signal,
      responseFormat: { type: 'json_object' }
    }));
  });

  it('rejects hallucinated entity IDs and reason codes from the async plan', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          template: 'selection_flow', tone: 'warm',
          selections: [{ entityId: 'invented-track', reasonCodes: ['final_eligible'] }],
          runReasonCodes: []
        }),
        model: 'test'
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          template: 'selection_flow', tone: 'warm',
          selections: [{ entityId: 'track-1', reasonCodes: ['invented_reason'] }],
          runReasonCodes: []
        }),
        model: 'test'
      });

    await expect(narrateSelectionJourney({
      client: { complete }, journey, trace, djPersona: 'DJ', toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('narration_entity_not_whitelisted');
    await expect(narrateSelectionJourney({
      client: { complete }, journey, trace, djPersona: 'DJ', toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('narration_reason_not_allowed_for_entity');
  });

  it('rejects a reason that belongs only to a rejected candidate', async () => {
    const multiCandidateTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: [
        ...trace.decisions,
        {
          stage: 'ranking',
          action: 'promoted',
          reasonCode: 'expressed_preference_match',
          candidateId: 'track-2',
          provenance: { source: 'preference_evidence' },
          evidenceRefs: []
        },
        {
          stage: 'final',
          action: 'rejected',
          reasonCode: 'queue_track_idempotency',
          candidateId: 'track-2',
          provenance: { source: 'queue' },
          evidenceRefs: []
        }
      ]
    };
    const multiCandidateJourney: SelectionJourneySnapshot = {
      ...journey,
      candidates: [
        ...journey.candidates,
        { id: 'track-2', name: 'Rejected Song', artist: 'Rejected Artist', state: 'excluded' }
      ]
    };
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'track_spotlight',
        tone: 'warm',
        selections: [{ entityId: 'track-1', reasonCodes: ['expressed_preference_match'] }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey: multiCandidateJourney,
      trace: multiCandidateTrace,
      djPersona: 'DJ',
      toneTags: [],
      entityWhitelist: [
        { id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' },
        { id: 'track-2', name: 'Rejected Song', artist: 'Rejected Artist' }
      ]
    })).rejects.toThrow('narration_reason_not_allowed_for_entity');
  });

  it('does not offer bypassed negative pressure as a positive narration reason', async () => {
    const bypassedPressureTrace: SelectionDecisionTrace = {
      ...trace,
      mode: 'explicit_request',
      decisions: [
        ...trace.decisions,
        {
          stage: 'ranking',
          action: 'kept',
          reasonCode: 'early_skip_track',
          candidateId: 'track-1',
          provenance: { source: 'listening_exposure' },
          evidenceRefs: []
        },
        {
          stage: 'ranking',
          action: 'kept',
          reasonCode: 'exposure_track',
          candidateId: 'track-1',
          provenance: { source: 'listening_exposure' },
          evidenceRefs: []
        }
      ]
    };
    const facts = buildSelectionJourneyNarrationFacts({
      journey,
      trace: bypassedPressureTrace,
      djPersona: 'DJ',
      toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    });
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'track_spotlight',
        tone: 'warm',
        selections: [{ entityId: 'track-1', reasonCodes: ['early_skip_track'] }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    expect(facts.selectionReasonOptions[0]?.allowedReasonCodes).not.toContain('early_skip_track');
    expect(facts.selectionReasonOptions[0]?.allowedReasonCodes).not.toContain('exposure_track');
    await expect(narrateSelectionJourney({
      client: { complete }, journey, trace: bypassedPressureTrace, djPersona: 'DJ', toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('narration_reason_not_allowed_for_entity');
  });

  it.each([
    ['active_directive_match', '符合你当前给 DJ 的方向'],
    ['expressed_preference_match', '符合你明确表达过的偏好'],
    ['semantic_compatibility', '歌曲内容与当前方向的契合度'],
    ['explicit_request_soft_bypass', '本轮明确点选的音乐']
  ] as const)('renders stable public copy for %s', async (reasonCode, expectedCopy) => {
    const reasonTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: [
        ...trace.decisions,
        {
          stage: 'ranking',
          action: 'promoted',
          reasonCode,
          candidateId: 'track-1',
          provenance: { source: 'system' },
          evidenceRefs: []
        }
      ]
    };
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'track_spotlight',
        tone: 'warm',
        selections: [{ entityId: 'track-1', reasonCodes: [reasonCode] }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete }, journey, trace: reasonTrace, djPersona: 'DJ', toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).resolves.toContain(expectedCopy);
  });
});
