import {
  SELECTION_TRACE_SCHEMA_VERSION,
  selectionDecisionTraceSchema,
  type SelectionDecision,
  type SelectionDecisionTrace
} from '../../shared/selection.js';
import type { SelectionPhaseDecision } from '../music-agent/selection-policy/types.js';
import { sharedDecisionsFromPolicy } from '../music-agent/selection-policy/decision-trace.js';

export type SelectionTraceCollector = {
  record(input: RecordSelectionTraceDecisionInput): void;
  snapshot(): SelectionDecisionTrace;
};

export type RecordSelectionTraceDecisionInput = {
  decision: SelectionPhaseDecision;
  candidateId?: string;
  provenance?: SelectionDecision['provenance'];
  evidenceRefs?: SelectionDecision['evidenceRefs'];
};

export function createSelectionTraceCollector(input: {
  runId: string;
  mode: SelectionDecisionTrace['mode'];
  createdAt?: string;
}): SelectionTraceCollector {
  const decisions: SelectionDecision[] = [];
  const base = selectionDecisionTraceSchema.pick({
    schemaVersion: true,
    runId: true,
    mode: true,
    createdAt: true,
    decisions: true
  }).omit({ decisions: true }).parse({
    schemaVersion: SELECTION_TRACE_SCHEMA_VERSION,
    runId: input.runId,
    mode: input.mode,
    createdAt: input.createdAt ?? new Date().toISOString()
  });

  return {
    record(recordInput) {
      if (decisions.length >= 500) return;
      decisions.push(...sharedDecisionsFromPolicy(recordInput).slice(0, 500 - decisions.length));
    },
    snapshot() {
      return selectionDecisionTraceSchema.parse({
        ...base,
        decisions: structuredClone(decisions)
      });
    }
  };
}

export function projectSelectionTraceForPrompt(trace: SelectionDecisionTrace): {
  schemaVersion: number;
  mode: SelectionDecisionTrace['mode'];
  decisions: Array<Omit<SelectionDecision, 'evidenceRefs'>>;
} {
  const parsed = selectionDecisionTraceSchema.parse(trace);
  return {
    schemaVersion: parsed.schemaVersion,
    mode: parsed.mode,
    decisions: parsed.decisions.map(({ evidenceRefs: _evidenceRefs, ...decision }) => decision)
  };
}

export function projectSelectionTraceForLog(
  trace: SelectionDecisionTrace,
  operational: { timingMs?: number; errorCode?: string } = {}
): {
  runId: string;
  decisionCount: number;
  stageCounts: Partial<Record<SelectionDecision['stage'], number>>;
  finalReasonCodes: string[];
  timingMs?: number;
  errorCode?: string;
} {
  const parsed = selectionDecisionTraceSchema.parse(trace);
  if (operational.timingMs !== undefined && (!Number.isFinite(operational.timingMs) || operational.timingMs < 0)) {
    throw new Error('Selection trace timingMs must be a non-negative finite number');
  }
  if (operational.errorCode !== undefined && !/^[a-z][a-z0-9_]{0,79}$/.test(operational.errorCode)) {
    throw new Error('Selection trace errorCode must be a stable code');
  }
  const stageCounts: Partial<Record<SelectionDecision['stage'], number>> = {};
  for (const decision of parsed.decisions) {
    stageCounts[decision.stage] = (stageCounts[decision.stage] ?? 0) + 1;
  }
  return {
    runId: parsed.runId,
    decisionCount: parsed.decisions.length,
    stageCounts,
    finalReasonCodes: Array.from(new Set(
      parsed.decisions
        .filter((decision) => decision.stage === 'final')
        .map((decision) => decision.reasonCode)
    )),
    ...(operational.timingMs !== undefined ? { timingMs: operational.timingMs } : {}),
    ...(operational.errorCode !== undefined ? { errorCode: operational.errorCode } : {})
  };
}
