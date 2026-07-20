import { evaluatePlaybackEligibility } from '../playback-eligibility.js';
import {
  matchesExclusion,
  type SelectionPhaseDecision,
  type SelectionPolicyCandidate,
  type SelectionPolicyContext
} from './types.js';

export function evaluateAdmission(input: {
  candidate: SelectionPolicyCandidate;
  context: SelectionPolicyContext;
}): SelectionPhaseDecision {
  const playback = evaluatePlaybackEligibility(input.candidate.track);
  if (!playback.eligible) {
    return { phase: 'admission', action: 'reject', reasonCodes: playback.reasons };
  }

  const exclusion = matchesExclusion(input.candidate, input.context.explicitExclusions);
  if (exclusion) {
    return {
      phase: 'admission',
      action: 'reject',
      reasonCodes: [exclusion === 'track' ? 'explicit_track_exclusion' : 'explicit_artist_exclusion']
    };
  }

  return { phase: 'admission', action: 'admit', reasonCodes: ['admission_eligible'] };
}
