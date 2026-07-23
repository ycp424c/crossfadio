import {
  selectionDecisionSchema,
  type SelectionAction,
  type SelectionDecision
} from '../../../shared/selection.js';
import type {
  SelectionPhaseDecision,
  SelectionPolicyAction,
  SelectionReasonCode
} from './types.js';

export type SelectionDecisionRecorder = {
  record(input: {
    candidateId?: string;
    decision: SelectionPhaseDecision;
    provenance?: SelectionDecision['provenance'];
    evidenceRefs?: SelectionDecision['evidenceRefs'];
  }): void;
  snapshot(): SelectionDecision[];
};

export function createSelectionDecisionRecorder(): SelectionDecisionRecorder {
  const decisions: SelectionDecision[] = [];
  const seen = new Set<string>();
  return {
    record(input) {
      for (const decision of sharedDecisionsFromPolicy(input)) {
        const key = [
          decision.stage,
          decision.action,
          decision.reasonCode,
          decision.candidateId ?? '',
          decision.provenance.source,
          decision.provenance.sourceRef ?? ''
        ].join('\u0000');
        if (seen.has(key)) continue;
        seen.add(key);
        decisions.push(decision);
      }
    },
    snapshot() {
      return structuredClone(boundSelectionDecisions(decisions));
    }
  };
}

export function boundSelectionDecisions(
  decisions: SelectionDecision[],
  limit = 500
): SelectionDecision[] {
  const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 500));
  if (decisions.length <= boundedLimit) return decisions.slice();
  if (boundedLimit === 0) return [];

  const finalCandidateIds = new Set(decisions.flatMap((decision) =>
    decision.stage === 'final' && decision.candidateId ? [decision.candidateId] : []
  ));
  const preferredIndexes = decisions.flatMap((decision, index) =>
    decision.stage === 'final'
      || (decision.candidateId !== undefined && finalCandidateIds.has(decision.candidateId))
      ? [index]
      : []
  );
  const selectedIndexes = new Set(
    preferredIndexes.length >= boundedLimit
      ? preferredIndexes.slice(-boundedLimit)
      : preferredIndexes
  );
  for (let index = decisions.length - 1; index >= 0 && selectedIndexes.size < boundedLimit; index -= 1) {
    selectedIndexes.add(index);
  }
  return decisions.filter((_decision, index) => selectedIndexes.has(index));
}

export function sharedDecisionsFromPolicy(input: {
  candidateId?: string;
  decision: SelectionPhaseDecision;
  provenance?: SelectionDecision['provenance'];
  evidenceRefs?: SelectionDecision['evidenceRefs'];
}): SelectionDecision[] {
  const entries = [
    ...input.decision.reasonCodes.map((reasonCode) => ({
      reasonCode,
      action: sharedAction(input.decision.action)
    })),
    ...(input.decision.contributions ?? []).map((contribution) => ({
      reasonCode: contribution.reasonCode,
      action: contribution.bypassed
        ? 'kept' as const
        : contribution.direction === 'boost'
          ? 'promoted' as const
          : 'lowered' as const
    }))
  ].filter((entry, index, all) => all.findIndex((candidate) => (
    candidate.reasonCode === entry.reasonCode && candidate.action === entry.action
  )) === index);
  return entries.map(({ reasonCode, action }) => selectionDecisionSchema.parse({
    stage: input.decision.phase,
    action,
    reasonCode,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    provenance: structuredClone(input.provenance ?? { source: provenanceForReason(reasonCode) }),
    evidenceRefs: structuredClone(
      input.evidenceRefs ?? evidenceRefsForReason(input.decision, reasonCode)
    ).slice(0, 8)
  }));
}

function evidenceRefsForReason(
  decision: SelectionPhaseDecision,
  reasonCode: SelectionReasonCode
): SelectionDecision['evidenceRefs'] {
  const refs: SelectionDecision['evidenceRefs'] = [];
  for (const contribution of decision.contributions ?? []) {
    if (contribution.reasonCode !== reasonCode) continue;
    const evidenceId = contribution.evidence?.evidenceId;
    if (typeof evidenceId === 'string' && evidenceId.trim()) {
      refs.push({ kind: 'preference_evidence', id: evidenceId.trim() });
    }
  }
  return refs;
}

function sharedAction(action: SelectionPolicyAction): SelectionAction {
  const actions: Record<SelectionPolicyAction, SelectionAction> = {
    admit: 'admitted',
    reject: 'rejected',
    include: 'recalled',
    suppress: 'suppressed',
    rank: 'ranked',
    select: 'selected',
    defer: 'deferred'
  };
  return actions[action];
}

function provenanceForReason(reason: SelectionReasonCode): SelectionDecision['provenance']['source'] {
  if (reason.startsWith('explicit_')) {
    return reason.endsWith('_exclusion') ? 'explicit_exclusion' : 'explicit_request';
  }
  if (reason.startsWith('active_directive')) return 'active_directive';
  if (reason.includes('preference')) return 'preference_evidence';
  if (reason.startsWith('exposure_') || reason.startsWith('early_skip_')) return 'listening_exposure';
  if (reason.startsWith('rotation_')) return 'selection_rotation';
  if (reason.startsWith('retrieval_')) return 'retrieval_history';
  if (reason.startsWith('upcoming_queue_') || reason.includes('idempotency')) return 'queue';
  if (reason.startsWith('batch_')) return 'batch_diversity';
  if (reason.startsWith('trend_')) return 'trend';
  if (
    reason === 'candidate_quality'
    || reason === 'semantic_compatibility'
    || reason === 'ranking_scored'
  ) return 'candidate_quality';
  if (
    reason === 'invalid_track_identity'
    || reason === 'copyright_unavailable'
    || reason === 'privilege_unavailable'
    || reason === 'privilege_notice'
    || reason === 'final_eligible'
  ) return 'playback_eligibility';
  return 'system';
}
