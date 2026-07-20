import type { SelectionPhaseDecision, SelectionPolicyPhase } from './types.js';

export type SelectionPolicyTrace = {
  decisions: SelectionPhaseDecision[];
};

export function createSelectionPolicyTrace(): SelectionPolicyTrace {
  return { decisions: [] };
}

export function appendSelectionPolicyDecision(
  trace: SelectionPolicyTrace,
  decision: SelectionPhaseDecision
): SelectionPolicyTrace {
  return { decisions: [...trace.decisions, cloneDecision(decision)] };
}

export function latestSelectionPolicyDecision(
  trace: SelectionPolicyTrace,
  phase: SelectionPolicyPhase
): SelectionPhaseDecision | null {
  return [...trace.decisions].reverse().find((decision) => decision.phase === phase) ?? null;
}

function cloneDecision(decision: SelectionPhaseDecision): SelectionPhaseDecision {
  return {
    ...decision,
    reasonCodes: [...decision.reasonCodes],
    ...(decision.contributions
      ? { contributions: decision.contributions.map((contribution) => ({ ...contribution })) }
      : {})
  };
}
