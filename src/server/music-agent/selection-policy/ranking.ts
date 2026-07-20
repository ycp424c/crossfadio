import {
  isCurrentExplicitRequest,
  SELECTION_PRESSURE_PRIORITY,
  type SelectionPhaseDecision,
  type SelectionPolicyCandidate,
  type SelectionPolicyContext,
  type SelectionPressureContribution
} from './types.js';

export type RankingDecision = SelectionPhaseDecision & {
  action: 'rank';
  baseScore: number;
  adjustedScore: number;
  contributions: SelectionPressureContribution[];
};

export function evaluateRanking(input: {
  candidate: SelectionPolicyCandidate;
  context: SelectionPolicyContext;
  baseScore: number;
  pressure?: SelectionPressureContribution[];
}): RankingDecision {
  const explicitBypass = isCurrentExplicitRequest(input.context, input.candidate);
  const contributions = (input.pressure ?? [])
    .map((item, index) => ({ item: { ...item, ...(explicitBypass && item.direction === 'penalty' ? { bypassed: true } : {}) }, index }))
    .sort((left, right) =>
      SELECTION_PRESSURE_PRIORITY[left.item.source] - SELECTION_PRESSURE_PRIORITY[right.item.source]
      || left.index - right.index
    )
    .map(({ item }) => item);
  const adjustment = contributions.reduce((sum, item) => {
    if (item.bypassed) return sum;
    return sum + (item.direction === 'boost' ? item.amount : -item.amount);
  }, 0);

  return {
    phase: 'ranking',
    action: 'rank',
    reasonCodes: ['ranking_scored'],
    baseScore: roundScore(input.baseScore),
    adjustedScore: roundScore(Math.max(0, input.baseScore + adjustment)),
    contributions
  };
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}
