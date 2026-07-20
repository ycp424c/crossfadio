import { createHash } from 'node:crypto';
import {
  SELECTION_TRACE_SCHEMA_VERSION,
  selectionDecisionTraceSchema,
  type SelectionDecision,
  type SelectionDecisionTrace
} from '../../shared/selection.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import type { FinalQueueDecision } from './musicAgentPickNextResult.js';
import {
  boundSelectionDecisions,
  sharedDecisionsFromPolicy
} from '../music-agent/selection-policy/decision-trace.js';
import {
  sanitizePublicSelectionReason,
  type SelectionJourneyCandidateFact
} from './selection-journey.js';

export function createEmptySelectionTrace(input: {
  runId: string;
  mode: SelectionDecisionTrace['mode'];
  createdAt: string;
}): SelectionDecisionTrace {
  return selectionDecisionTraceSchema.parse({
    schemaVersion: SELECTION_TRACE_SCHEMA_VERSION,
    runId: input.runId,
    mode: input.mode,
    createdAt: input.createdAt,
    decisions: []
  });
}

export function createFailedSelectionTrace(input: {
  runId: string;
  mode: SelectionDecisionTrace['mode'];
  createdAt: string;
}): SelectionDecisionTrace {
  return selectionDecisionTraceSchema.parse({
    ...createEmptySelectionTrace(input),
    decisions: [decision('final', 'skipped', 'selection_failed', 'system')]
  });
}

export function createSelectionTraceFromDecisions(input: {
  runId: string;
  mode: SelectionDecisionTrace['mode'];
  createdAt: string;
  decisions: SelectionDecision[];
}): SelectionDecisionTrace {
  return selectionDecisionTraceSchema.parse({
    schemaVersion: SELECTION_TRACE_SCHEMA_VERSION,
    runId: input.runId,
    mode: input.mode,
    createdAt: input.createdAt,
    decisions: dedupeDecisions(input.decisions)
  });
}

export function selectionTraceFromMusicAgentOutput(input: {
  runId: string;
  createdAt: string;
  output: MusicAgentRunOutput;
  finalQueueDecisions?: FinalQueueDecision[];
}): { trace: SelectionDecisionTrace; candidates: SelectionJourneyCandidateFact[] } {
  const candidates = candidateFacts(input.output);
  const decisions = dedupeDecisions([
    ...(input.output.selectionDecisions ?? []),
    ...(input.finalQueueDecisions ?? []).flatMap((item) => sharedDecisionsFromPolicy({
      candidateId: item.candidateId,
      decision: item.decision
    })),
    ...(input.output.status === 'ok'
      ? []
      : [decision('final', 'skipped', 'selection_failed', 'system')])
  ]);
  return {
    trace: selectionDecisionTraceSchema.parse({
      schemaVersion: SELECTION_TRACE_SCHEMA_VERSION,
      runId: input.runId,
      mode: input.output.mode === 'chat_recommend' ? 'explicit_request' : 'autonomous',
      createdAt: input.createdAt,
      decisions
    }),
    candidates
  };
}

function dedupeDecisions(decisions: SelectionDecision[]): SelectionDecision[] {
  const seen = new Set<string>();
  return boundSelectionDecisions(decisions.filter((item) => {
    const key = [
      item.stage,
      item.action,
      item.reasonCode,
      item.candidateId ?? '',
      item.provenance.source,
      item.provenance.sourceRef ?? ''
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function selectionTraceFactsHash(input: {
  trace: SelectionDecisionTrace;
  candidates: SelectionJourneyCandidateFact[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ trace: input.trace, candidates: input.candidates }))
    .digest('hex');
}

function candidateFacts(output: MusicAgentRunOutput): SelectionJourneyCandidateFact[] {
  const byId = new Map<string, SelectionJourneyCandidateFact>();
  for (const pick of output.picks) {
    const selectionReason = sanitizePublicSelectionReason(pick.reason);
    byId.set(pick.id, {
      id: pick.id,
      name: pick.name?.trim() || pick.id,
      artist: pick.artist?.trim() || '',
      ...(selectionReason ? { selectionReason } : {})
    });
  }
  for (const row of [...output.candidateScoreTable].sort((left, right) => left.rank - right.rank)) {
    if (byId.has(row.id)) continue;
    byId.set(row.id, { id: row.id, name: row.song || row.id, artist: row.artist });
  }
  return [...byId.values()].slice(0, 8);
}

function decision(
  stage: SelectionDecision['stage'],
  action: SelectionDecision['action'],
  reasonCode: string,
  source: SelectionDecision['provenance']['source'],
  candidateId?: string
): SelectionDecision {
  return {
    stage,
    action,
    reasonCode,
    ...(candidateId ? { candidateId } : {}),
    provenance: { source },
    evidenceRefs: []
  };
}
