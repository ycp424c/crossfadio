import { describe, expect, it } from 'vitest';
import { buildMusicTrackDedupeKey } from '../../src/server/music-agent/dedupe.js';
import { evaluateAdmission } from '../../src/server/music-agent/selection-policy/admission.js';
import { evaluateFinal } from '../../src/server/music-agent/selection-policy/final.js';
import { evaluateRanking } from '../../src/server/music-agent/selection-policy/ranking.js';
import { evaluateRecall } from '../../src/server/music-agent/selection-policy/recall.js';
import {
  appendSelectionPolicyDecision,
  createSelectionPolicyTrace,
  latestSelectionPolicyDecision
} from '../../src/server/music-agent/selection-policy/trace.js';
import type {
  SelectionPolicyCandidate,
  SelectionPolicyContext,
  SelectionPressureContribution
} from '../../src/server/music-agent/selection-policy/types.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

describe('phase-aware selection policy precedence', () => {
  it('keeps objective playback eligibility above a current explicit request', () => {
    const decision = evaluateAdmission({
      candidate: policyCandidate({ qualitySignals: { copyright: 0 } }),
      context: context({ mode: 'explicit_request', explicitlyRequested: true })
    });

    expect(decision.action).toBe('reject');
    expect(decision.reasonCodes).toEqual(['copyright_unavailable']);
  });

  it('keeps explicit exclusion above a current explicit request', () => {
    const selected = policyCandidate();
    const decision = evaluateAdmission({
      candidate: selected,
      context: context({
        mode: 'explicit_request',
        explicitlyRequested: true,
        explicitExclusions: { trackIds: new Set([selected.track.id]) }
      })
    });

    expect(decision.action).toBe('reject');
    expect(decision.reasonCodes).toEqual(['explicit_track_exclusion']);
  });

  it('rejects an unsolicited DJ version from autonomous discovery', () => {
    const decision = evaluateAdmission({
      candidate: policyCandidate({ name: '傻女 (DJ版)', sources: ['playlist'] }),
      context: context()
    });

    expect(decision).toEqual({
      phase: 'admission',
      action: 'reject',
      reasonCodes: ['candidate_quality']
    });
  });

  it('keeps a DJ version that already belongs to the listener liked library', () => {
    const decision = evaluateAdmission({
      candidate: policyCandidate({ name: '秒针 (Dj版)', sources: ['liked', 'playlist'] }),
      context: context()
    });

    expect(decision).toEqual({
      phase: 'admission',
      action: 'admit',
      reasonCodes: ['admission_eligible']
    });
  });

  it('keeps a DJ version when the listener explicitly requests it', () => {
    const requested = policyCandidate({ name: '傻女 (DJ版)', sources: ['search'] });
    const decision = evaluateAdmission({
      candidate: requested,
      context: context({
        mode: 'explicit_request',
        explicitlyRequested: true,
        explicitRequest: { trackIds: new Set([requested.track.id]) }
      })
    });

    expect(decision).toEqual({
      phase: 'admission',
      action: 'admit',
      reasonCodes: ['admission_eligible']
    });
  });

  it('lets an explicit request bypass temporary, retrieval, exposure, and early-skip pressure', () => {
    const candidate = policyCandidate();
    const policyContext = context({
      mode: 'explicit_request',
      explicitlyRequested: true,
      temporaryExclusions: { trackKeys: new Set([candidate.trackKey]) },
      retrievalCooldownTrackKeys: new Set([candidate.trackKey])
    });
    const pressure = [
      contribution('exposure', 'exposure_track'),
      contribution('early_skip', 'early_skip_track'),
      contribution('retrieval', 'retrieval_cooldown')
    ];

    expect(evaluateRecall({ candidate, context: policyContext, pressure })).toMatchObject({
      action: 'include',
      reasonCodes: ['explicit_request_soft_bypass']
    });
    expect(evaluateRanking({ candidate, context: policyContext, baseScore: 0.5, pressure })).toMatchObject({
      action: 'rank',
      adjustedScore: 0.5
    });
    expect(evaluateRanking({ candidate, context: policyContext, baseScore: 0.5, pressure })
      .contributions.every((item) => item.bypassed)).toBe(true);
  });

  it('limits explicit-request bypass to the requested policy candidate', () => {
    const requested = policyCandidate({ id: 'requested-track' });
    const unrelated = policyCandidate({ id: 'unrelated-track' });
    const policyContext = context({
      mode: 'explicit_request',
      explicitlyRequested: true,
      explicitRequest: { trackIds: new Set([requested.track.id]) }
    });
    const pressure = [contribution('exposure', 'exposure_track')];

    expect(evaluateRanking({
      candidate: requested, context: policyContext, baseScore: 0.5, pressure
    }).contributions[0]?.bypassed).toBe(true);
    expect(evaluateRanking({
      candidate: unrelated, context: policyContext, baseScore: 0.5, pressure
    }).contributions[0]).not.toHaveProperty('bypassed');
  });

  it('orders ranking evidence by the fixed policy precedence', () => {
    const decision = evaluateRanking({
      candidate: policyCandidate(),
      context: context(),
      baseScore: 0.5,
      pressure: [
        contribution('trend', 'trend_match', 'boost'),
        contribution('inferred_preference', 'inferred_preference_match', 'boost'),
        contribution('exposure', 'exposure_track'),
        contribution('active_directive', 'active_directive_match', 'boost'),
        contribution('fresh_preference', 'expressed_preference_match', 'boost')
      ]
    });

    expect(decision.contributions.map((item) => item.source)).toEqual([
      'active_directive',
      'fresh_preference',
      'inferred_preference',
      'exposure',
      'trend'
    ]);
  });

  it('does not let an explicit request bypass final queue idempotency', () => {
    const candidate = policyCandidate();
    const decision = evaluateFinal({
      candidate,
      context: context({
        mode: 'explicit_request',
        explicitlyRequested: true,
        queue: {
          currentIndex: 0,
          tracks: [{ id: candidate.track.id, trackKey: candidate.trackKey, primaryArtist: 'Valid Artist', source: 'liked' }]
        }
      })
    });

    expect(decision.action).toBe('reject');
    expect(decision.reasonCodes).toEqual(['queue_track_idempotency']);
  });

  it('does not let an explicit request bypass run-local played-track idempotency', () => {
    const candidate = policyCandidate();
    const decision = evaluateFinal({
      candidate,
      context: context({
        mode: 'explicit_request',
        explicitlyRequested: true,
        playedTrackKeys: new Set([candidate.trackKey])
      })
    });

    expect(decision.action).toBe('reject');
    expect(decision.reasonCodes).toEqual(['played_track_idempotency']);
  });

  it('rejects a recent rotation pick at Final while allowing an explicit request to bypass it', () => {
    const candidate = policyCandidate();
    const rotation = {
      currentRound: 20,
      tracks: [{
        trackKey: candidate.trackKey,
        lastSelectedRound: 19,
        selectionsInWindow: 1
      }]
    };

    expect(evaluateFinal({
      candidate,
      context: context({ rotation })
    })).toEqual({
      phase: 'final',
      action: 'reject',
      reasonCodes: ['rotation_final_rejection']
    });
    expect(evaluateFinal({
      candidate,
      context: context({
        mode: 'explicit_request',
        explicitlyRequested: true,
        explicitRequest: { trackIds: new Set([candidate.track.id]) },
        rotation
      })
    })).toEqual({
      phase: 'final',
      action: 'select',
      reasonCodes: ['final_eligible']
    });
  });

  it('records phase decisions without collapsing them into a universal penalty', () => {
    const admission = { phase: 'admission', action: 'admit', reasonCodes: ['admission_eligible'] } as const;
    const ranking = evaluateRanking({
      candidate: policyCandidate(),
      context: context(),
      baseScore: 0.5,
      pressure: [contribution('exposure', 'exposure_track')]
    });
    const trace = appendSelectionPolicyDecision(
      appendSelectionPolicyDecision(createSelectionPolicyTrace(), admission),
      ranking
    );

    expect(trace.decisions.map((decision) => decision.phase)).toEqual(['admission', 'ranking']);
    expect(latestSelectionPolicyDecision(trace, 'ranking')).toMatchObject({
      action: 'rank',
      reasonCodes: ['ranking_scored']
    });
  });
});

function policyCandidate(overrides: Partial<MusicCandidate> = {}): SelectionPolicyCandidate {
  const track = musicCandidate(overrides);
  return {
    track,
    trackKey: buildMusicTrackDedupeKey({ name: track.name, artist: track.artist }),
    primaryArtist: track.artist.split('/')[0]!.trim().toLocaleLowerCase()
  };
}

function musicCandidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Valid Song',
    artist: 'Valid Artist',
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
    ...overrides
  };
}

function context(overrides: Partial<SelectionPolicyContext> = {}): SelectionPolicyContext {
  return { mode: 'autonomous', explicitlyRequested: false, ...overrides };
}

function contribution(
  source: SelectionPressureContribution['source'],
  reasonCode: SelectionPressureContribution['reasonCode'],
  direction: SelectionPressureContribution['direction'] = 'penalty'
): SelectionPressureContribution {
  return { source, reasonCode, direction, amount: 0.2 };
}
