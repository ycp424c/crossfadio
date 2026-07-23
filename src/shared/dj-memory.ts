import { z } from 'zod';

export const DJ_MEMORY_SCHEMA_VERSION = 1 as const;
export const SELECTION_ROTATION_HISTORY_PICK_LIMIT = 4000;

export const djMemorySourceKindSchema = z.enum([
  'queue',
  'listening_episodes',
  'selection_rotation',
  'preference_evidence',
  'active_directive',
  'explicit_exclusions',
  'temporary_queue_exclusions',
  'personal_dj_context',
  'taste_profile',
  'retrieval_history',
  'dj_configuration',
  'dj_session_log',
  'current_moment',
  'daily_theme',
  'weather'
]);

export const djMemorySourceMetadataSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: djMemorySourceKindSchema,
  authority: z.enum([
    'authoritative',
    'derived',
    'advisory',
    'operational',
    'continuity'
  ]),
  freshness: z.enum(['fresh', 'stale', 'expired']),
  observedAt: z.string().datetime({ offset: true }).optional(),
  loadedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  recordCount: z.number().int().nonnegative()
}).strict();

export const djMemorySnapshotMetadataSchema = z.object({
  schemaVersion: z.literal(DJ_MEMORY_SCHEMA_VERSION),
  snapshotId: z.string().trim().min(1).max(100),
  userId: z.string().trim().min(1).max(200),
  assembledAt: z.string().datetime({ offset: true }),
  sources: z.array(djMemorySourceMetadataSchema).max(20)
}).strict();

export const djMemoryFactValueSchema = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(300)).max(20)
]);

export const djMemoryProjectionFactSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  value: djMemoryFactValueSchema.optional(),
  entity: z.object({
    type: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
    key: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(300).optional()
  }).strict().optional(),
  sourceId: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional()
}).strict();

const projectionBaseShape = {
  schemaVersion: z.literal(DJ_MEMORY_SCHEMA_VERSION),
  snapshotId: z.string().trim().min(1).max(100),
  assembledAt: z.string().datetime({ offset: true }),
  sources: z.array(djMemorySourceMetadataSchema).max(20)
};

export const chatDjMemoryProjectionSchema = z.object({
  ...projectionBaseShape,
  purpose: z.literal('chat'),
  facts: z.array(djMemoryProjectionFactSchema).max(48)
}).strict();

export const selectionDjMemoryProjectionSchema = z.object({
  ...projectionBaseShape,
  purpose: z.literal('selection'),
  facts: z.array(djMemoryProjectionFactSchema).max(96)
}).strict();

export const segueDjMemoryProjectionSchema = z.object({
  ...projectionBaseShape,
  purpose: z.literal('segue'),
  facts: z.array(djMemoryProjectionFactSchema).max(32)
}).strict();

export const djMemoryProjectionSchema = z.discriminatedUnion('purpose', [
  chatDjMemoryProjectionSchema,
  selectionDjMemoryProjectionSchema,
  segueDjMemoryProjectionSchema
]);

export type DjMemorySourceKind = z.infer<typeof djMemorySourceKindSchema>;
export type DjMemorySourceMetadata = z.infer<typeof djMemorySourceMetadataSchema>;
export type DjMemorySnapshotMetadata = z.infer<typeof djMemorySnapshotMetadataSchema>;
export type DjMemoryProjectionFact = z.infer<typeof djMemoryProjectionFactSchema>;
export type ChatDjMemoryProjection = z.infer<typeof chatDjMemoryProjectionSchema>;
export type SelectionDjMemoryProjection = z.infer<typeof selectionDjMemoryProjectionSchema>;
export type SegueDjMemoryProjection = z.infer<typeof segueDjMemoryProjectionSchema>;
export type DjMemoryProjection = z.infer<typeof djMemoryProjectionSchema>;
