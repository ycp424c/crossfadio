import { evaluatePlaybackEligibility } from '../playback-eligibility.js';
import { hasAutonomousLowQualityTitle } from '../title-quality.js';
import {
  isCurrentExplicitRequest,
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

  if (
    !isCurrentExplicitRequest(input.context, input.candidate)
    && !input.candidate.track.sources.includes('liked')
    && hasAutonomousLowQualityTitle(input.candidate.track.name)
  ) {
    return { phase: 'admission', action: 'reject', reasonCodes: ['candidate_quality'] };
  }

  return { phase: 'admission', action: 'admit', reasonCodes: ['admission_eligible'] };
}
