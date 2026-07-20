import {
  isCurrentExplicitRequest,
  matchesExclusion,
  type SelectionPhaseDecision,
  type SelectionPolicyCandidate,
  type SelectionPolicyContext,
  type SelectionPressureContribution,
  type SelectionReasonCode
} from './types.js';

export function evaluateRecall(input: {
  candidate: SelectionPolicyCandidate;
  context: SelectionPolicyContext;
  pressure?: SelectionPressureContribution[];
}): SelectionPhaseDecision {
  const reasons = autonomousSuppressionReasons(input);
  if (reasons.length === 0) {
    return { phase: 'recall', action: 'include', reasonCodes: ['recall_included'] };
  }
  if (isCurrentExplicitRequest(input.context, input.candidate)) {
    return { phase: 'recall', action: 'include', reasonCodes: ['explicit_request_soft_bypass'] };
  }
  return { phase: 'recall', action: 'suppress', reasonCodes: reasons };
}

function autonomousSuppressionReasons(input: {
  candidate: SelectionPolicyCandidate;
  context: SelectionPolicyContext;
  pressure?: SelectionPressureContribution[];
}): SelectionReasonCode[] {
  const reasons: SelectionReasonCode[] = [];
  if (matchesExclusion(input.candidate, input.context.temporaryExclusions)) {
    reasons.push('temporary_queue_exclusion');
  }
  if ((input.pressure ?? []).some((item) =>
    item.reasonCode === 'early_skip_track' && item.evidence?.temporaryExcluded === true
  ) && !reasons.includes('temporary_queue_exclusion')) {
    reasons.push('temporary_queue_exclusion');
  }
  const suppressing = (input.pressure ?? []).filter((item) => item.severity === 'suppress');
  if (suppressing.some((item) => item.reasonCode === 'early_skip_track')) {
    reasons.push('early_skip_track_suppression');
  }
  if (suppressing.some((item) => item.reasonCode === 'early_skip_artist')) {
    reasons.push('early_skip_artist_suppression');
  }
  if (
    input.context.retrievalCooldownTrackKeys?.has(input.candidate.trackKey)
    || suppressing.some((item) => item.reasonCode === 'retrieval_pressure')
  ) {
    reasons.push('retrieval_cooldown');
  }
  return reasons;
}
