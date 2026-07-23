import { evaluateAdmission } from './admission.js';
import { isRotationTrackSuppressed } from './rotation.js';
import type {
  SelectionPhaseDecision,
  SelectionPolicyCandidate,
  SelectionPolicyContext,
  SelectionPolicyTrack
} from './types.js';

export function evaluateFinal(input: {
  candidate: SelectionPolicyCandidate;
  context: SelectionPolicyContext;
}): SelectionPhaseDecision {
  const admission = evaluateAdmission(input);
  if (admission.action === 'reject') {
    return { ...admission, phase: 'final' };
  }
  if (input.context.queue?.tracks.some((track) => sameTrack(track, input.candidate))) {
    return { phase: 'final', action: 'reject', reasonCodes: ['queue_track_idempotency'] };
  }
  if (
    input.context.playedTrackIds?.has(input.candidate.track.id)
    || input.context.playedTrackKeys?.has(input.candidate.trackKey)
  ) {
    return { phase: 'final', action: 'reject', reasonCodes: ['played_track_idempotency'] };
  }
  if (isRotationTrackSuppressed(input.candidate, input.context)) {
    return { phase: 'final', action: 'reject', reasonCodes: ['rotation_final_rejection'] };
  }
  return { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] };
}

function sameTrack(track: SelectionPolicyTrack, candidate: SelectionPolicyCandidate): boolean {
  return track.id === candidate.track.id || (track.trackKey.length > 0 && track.trackKey === candidate.trackKey);
}
