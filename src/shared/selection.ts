import { z } from 'zod';

export const SELECTION_TRACE_SCHEMA_VERSION = 1 as const;
export const SELECTION_JOURNEY_SCHEMA_VERSION = 1 as const;

export const selectionStageSchema = z.enum([
  'admission',
  'recall',
  'ranking',
  'batch',
  'final'
]);

export const selectionActionSchema = z.enum([
  'admitted',
  'rejected',
  'recalled',
  'suppressed',
  'promoted',
  'lowered',
  'ranked',
  'kept',
  'selected',
  'deferred',
  'skipped'
]);

export const selectionReasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(80);

export const selectionProvenanceSourceSchema = z.enum([
  'objective_constraint',
  'playback_eligibility',
  'explicit_exclusion',
  'explicit_request',
  'active_directive',
  'preference_evidence',
  'listening_exposure',
  'retrieval_history',
  'queue',
  'candidate_quality',
  'personal_dj_context',
  'taste_profile',
  'batch_diversity',
  'trend',
  'system'
]);

export const selectionDecisionProvenanceSchema = z.object({
  source: selectionProvenanceSourceSchema,
  sourceRef: z.string().trim().min(1).max(200).optional()
}).strict();

export const selectionEvidenceRefSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]*$/).max(60),
  id: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime({ offset: true }).optional()
}).strict();

export const selectionDecisionSchema = z.object({
  stage: selectionStageSchema,
  action: selectionActionSchema,
  reasonCode: selectionReasonCodeSchema,
  candidateId: z.string().trim().min(1).max(200).optional(),
  provenance: selectionDecisionProvenanceSchema,
  evidenceRefs: z.array(selectionEvidenceRefSchema).max(8).default([])
}).strict();

export const selectionDecisionTraceSchema = z.object({
  schemaVersion: z.literal(SELECTION_TRACE_SCHEMA_VERSION),
  runId: z.string().trim().min(1).max(100),
  mode: z.enum(['autonomous', 'explicit_request']),
  createdAt: z.string().datetime({ offset: true }),
  decisions: z.array(selectionDecisionSchema).max(500)
}).strict();

export const selectionJourneyStageSchema = z.enum([
  'understanding',
  'recall',
  'filtering',
  'balancing',
  'finalizing'
]);

export const selectionJourneyStageSnapshotSchema = z.object({
  stage: selectionJourneyStageSchema,
  status: z.enum(['pending', 'active', 'completed']),
  title: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(500),
  reasonCodes: z.array(selectionReasonCodeSchema).max(8).default([])
}).strict();

export const selectionJourneyCandidateSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  artist: z.string().trim().max(300),
  state: z.enum(['considering', 'excluded', 'selected'])
}).strict();

export const selectionJourneyPickSchema = z.object({
  trackId: z.string().trim().min(1).max(200),
  trackName: z.string().trim().min(1).max(300),
  artist: z.string().trim().max(300),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const selectionJourneyNarrationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({
    status: z.literal('polished'),
    text: z.string().trim().min(1).max(1200)
  }).strict(),
  z.object({ status: z.literal('failed') }).strict()
]);

export const selectionJourneySnapshotSchema = z.object({
  schemaVersion: z.literal(SELECTION_JOURNEY_SCHEMA_VERSION),
  runId: z.string().trim().min(1).max(100),
  journeyVersion: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed', 'superseded']),
  summary: z.string().trim().min(1).max(500),
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  stages: z.array(selectionJourneyStageSnapshotSchema).max(5),
  candidates: z.array(selectionJourneyCandidateSchema).max(8),
  selections: z.array(selectionJourneyPickSchema).max(5),
  narration: selectionJourneyNarrationSchema
}).strict();

export const selectionJourneySseEventSchema = z.object({
  type: z.literal('selection.journey'),
  snapshot: selectionJourneySnapshotSchema
}).strict();

export type SelectionStage = z.infer<typeof selectionStageSchema>;
export type SelectionAction = z.infer<typeof selectionActionSchema>;
export type SelectionReasonCode = z.infer<typeof selectionReasonCodeSchema>;
export type SelectionDecision = z.infer<typeof selectionDecisionSchema>;
export type SelectionDecisionTrace = z.infer<typeof selectionDecisionTraceSchema>;
export type SelectionJourneyStage = z.infer<typeof selectionJourneyStageSchema>;
export type SelectionJourneySnapshot = z.infer<typeof selectionJourneySnapshotSchema>;
export type SelectionJourneySseEvent = z.infer<typeof selectionJourneySseEventSchema>;
