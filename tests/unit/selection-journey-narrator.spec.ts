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

function twoTrackScenario() {
  const secondSelection = {
    trackId: 'track-2',
    trackName: 'Midnight Pretenders',
    artist: '亜蘭知子',
    reason: '夜间城市流行的律动让两首歌衔接得更自然。'
  };
  return {
    journey: {
      ...journey,
      candidates: [
        ...journey.candidates,
        { id: 'track-2', name: secondSelection.trackName, artist: secondSelection.artist, state: 'selected' as const }
      ],
      selections: [...journey.selections, secondSelection]
    },
    trace: {
      ...trace,
      decisions: [
        ...trace.decisions,
        {
          stage: 'final' as const,
          action: 'selected' as const,
          reasonCode: 'final_eligible' as const,
          candidateId: 'track-2',
          provenance: { source: 'system' as const },
          evidenceRefs: []
        }
      ]
    },
    entityWhitelist: [
      { id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' },
      { id: 'track-2', name: secondSelection.trackName, artist: secondSelection.artist }
    ]
  };
}

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
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['final_eligible'],
          reasonText: '夜色里的柔和律动能让当前队列自然降速。'
        }],
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
      '这轮想把「Plastic Love」— 竹内まりや自然地接进队列。夜色里的柔和律动能让当前队列自然降速，希望这一段既顺耳，也保留一点被认真挑过的惊喜。'
    );
    expect(complete).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      signal,
      responseFormat: { type: 'json_object' }
    }));
  });

  it('uses a specific public track reason instead of procedural reason-code copy', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'track_spotlight',
        tone: 'warm',
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['recall_included', 'final_eligible'],
          reasonText: '城市流行的轻盈律动和夜色很合拍，也让当前队列自然降速。'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    const narration = await narrateSelectionJourney({
      client: { complete },
      journey: {
        ...journey,
        selections: [{
          ...journey.selections[0]!,
          reason: 'City pop with a light groove fits the late-night mood and eases the queue.'
        }]
      },
      trace,
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    });

    expect(narration).toContain('城市流行的轻盈律动和夜色很合拍，也让当前队列自然降速');
    expect(narration).not.toContain('候选进入了这一轮的可选范围');
    expect(narration).not.toContain('通过最后校验');
  });

  it('rejects a narration plan that omits the specific track reason', async () => {
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
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('invalid_narration_plan');
  });

  it('rejects unsafe personal details in a generated track reason', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['final_eligible'],
          reasonText: '你昨天告诉我真实姓名和住址，所以选择了这首歌。'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey,
      trace,
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('invalid_narration_text');
  });

  it('rejects an untranslated English track reason in the Chinese narration', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['final_eligible'],
          reasonText: 'City pop with a light groove fits the late-night mood.'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey,
      trace,
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('invalid_narration_text');
  });

  it('rejects procedural pipeline copy masquerading as a track reason', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['recall_included', 'ranking_scored'],
          reasonText: '候选进入了这一轮的可选范围，也结合当前目标与近期反馈完成了排序。'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey,
      trace: {
        ...trace,
        decisions: [
          ...trace.decisions,
          {
            stage: 'ranking', action: 'ranked', reasonCode: 'ranking_scored',
            candidateId: 'track-1', provenance: { source: 'system' }, evidenceRefs: []
          }
        ]
      },
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    })).rejects.toThrow('invalid_narration_text');
  });

  it('renders a narration plan covering all five selected tracks', async () => {
    const selections = Array.from({ length: 5 }, (_, index) => ({
      trackId: `track-${index + 1}`,
      trackName: `Track ${index + 1}`,
      artist: `Artist ${index + 1}`,
      reason: '通过最后校验。'
    }));
    const fiveTrackJourney: SelectionJourneySnapshot = {
      ...journey,
      candidates: selections.map((selection) => ({
        id: selection.trackId,
        name: selection.trackName,
        artist: selection.artist,
        state: 'selected'
      })),
      selections
    };
    const fiveTrackTrace: SelectionDecisionTrace = {
      ...trace,
      decisions: [
        trace.decisions[0]!,
        ...selections.map((selection) => ({
          stage: 'final' as const,
          action: 'selected' as const,
          reasonCode: 'final_eligible' as const,
          candidateId: selection.trackId,
          provenance: { source: 'system' as const },
          evidenceRefs: []
        }))
      ]
    };
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'journey_recap',
        tone: 'reflective',
        selections: selections.map((selection, index) => ({
          entityId: selection.trackId,
          reasonCodes: ['final_eligible'],
          reasonText: `第 ${index + 1} 首的音乐质感让这一轮保持了自然变化。`
        })),
        runReasonCodes: []
      }),
      model: 'test'
    });

    const narration = await narrateSelectionJourney({
      client: { complete },
      journey: fiveTrackJourney,
      trace: fiveTrackTrace,
      djPersona: 'DJ',
      toneTags: ['reflective'],
      entityWhitelist: selections.map((selection) => ({
        id: selection.trackId,
        name: selection.trackName,
        artist: selection.artist
      }))
    });

    for (const selection of selections) {
      expect(narration).toContain(`「${selection.trackName}」`);
    }
    expect(narration).not.toMatch(/[。！？!?][，；]/u);
  });

  it('rejects a narration plan that omits an actually selected track', async () => {
    const scenario = twoTrackScenario();
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: [{
          entityId: 'track-1',
          reasonCodes: ['final_eligible'],
          reasonText: '轻盈的城市流行质感适合当前夜色。'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey: scenario.journey,
      trace: scenario.trace,
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: scenario.entityWhitelist
    })).rejects.toThrow('invalid_narration_plan');
  });

  it('rejects identical generated reasons for different selected tracks', async () => {
    const scenario = twoTrackScenario();
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        template: 'selection_flow',
        tone: 'warm',
        selections: ['track-1', 'track-2'].map((entityId) => ({
          entityId,
          reasonCodes: ['final_eligible'],
          reasonText: '轻盈的旋律很适合现在的播放氛围。'
        })),
        runReasonCodes: []
      }),
      model: 'test'
    });

    await expect(narrateSelectionJourney({
      client: { complete },
      journey: scenario.journey,
      trace: scenario.trace,
      djPersona: 'DJ',
      toneTags: ['warm'],
      entityWhitelist: scenario.entityWhitelist
    })).rejects.toThrow('invalid_narration_plan');
  });

  it('rejects hallucinated entity IDs and reason codes from the async plan', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          template: 'selection_flow', tone: 'warm',
          selections: [{
            entityId: 'invented-track', reasonCodes: ['final_eligible'],
            reasonText: '轻盈的城市流行质感适合当前夜色。'
          }],
          runReasonCodes: []
        }),
        model: 'test'
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          template: 'selection_flow', tone: 'warm',
          selections: [{
            entityId: 'track-1', reasonCodes: ['invented_reason'],
            reasonText: '轻盈的城市流行质感适合当前夜色。'
          }],
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
        selections: [{
          entityId: 'track-1', reasonCodes: ['expressed_preference_match'],
          reasonText: '柔和律动可以让当前队列自然地慢下来。'
        }],
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
        selections: [{
          entityId: 'track-1', reasonCodes: ['early_skip_track'],
          reasonText: '柔和律动可以让当前队列自然地慢下来。'
        }],
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
  ] as const)('keeps traced public code %s as provenance instead of narration copy', async (reasonCode, expectedCopy) => {
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
        selections: [{
          entityId: 'track-1', reasonCodes: [reasonCode],
          reasonText: '轻盈的城市流行质感适合当前夜色。'
        }],
        runReasonCodes: []
      }),
      model: 'test'
    });

    const narration = await narrateSelectionJourney({
      client: { complete }, journey, trace: reasonTrace, djPersona: 'DJ', toneTags: [],
      entityWhitelist: [{ id: 'track-1', name: 'Plastic Love', artist: '竹内まりや' }]
    });

    expect(narration).toContain('轻盈的城市流行质感适合当前夜色');
    expect(narration).not.toContain(expectedCopy);
  });
});
