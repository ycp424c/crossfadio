import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

const eventBaseSchema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  causationEventId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  trackId: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional()
});

const listenerRequestReceivedPayloadSchema = z.object({
  messageId: z.number().int().positive().optional(),
  requestSummary: z.string().min(1).max(800),
  intent: z.string().min(1).max(80).optional()
}).strict();

const directiveUpdatedPayloadSchema = z.object({
  directive: z.string().max(800).nullable(),
  source: z.enum(['chat', 'settings', 'fallback', 'system']).default('system')
}).strict();

const personalContextUploadedPayloadSchema = z.object({
  contextId: z.string().min(1),
  generatedAt: z.string().min(1).optional(),
  uploadedAt: z.string().min(1),
  source: z.object({
    kind: z.string().min(1).max(80)
  }).strict(),
  musicHintCount: z.number().int().nonnegative().default(0)
}).strict();

const selectionStartedPayloadSchema = z.object({
  trigger: z.enum(['auto_fill', 'manual_pick_next', 'chat_recommend', 'system']).default('system'),
  targetCount: z.number().int().positive().optional(),
  activeDirective: z.string().max(800).optional(),
  batchRationale: z.string().max(1000).optional()
}).strict();

const trackSelectedPayloadSchema = z.object({
  trackId: z.string().min(1),
  trackName: z.string().min(1).max(300),
  artist: z.string().max(300).optional(),
  selectionRationale: z.string().min(1).max(1000),
  batchRationale: z.string().max(1000).optional(),
  source: z.string().min(1).max(80).optional(),
  pickOrder: z.number().int().positive().optional()
}).strict();

const finalPickDiagnosticsPayloadSchema = z.object({
  targetPickCount: z.number().int().nonnegative(),
  rawPickCount: z.number().int().nonnegative(),
  eligiblePickCount: z.number().int().nonnegative(),
  acceptedPickCount: z.number().int().nonnegative(),
  droppedPickCount: z.number().int().nonnegative(),
  titleMotifDroppedCount: z.number().int().nonnegative(),
  rankedBackfillCount: z.number().int().nonnegative(),
  rejectedPickCount: z.number().int().nonnegative(),
  semanticConflictDroppedCount: z.number().int().nonnegative().default(0),
  qualityDroppedCount: z.number().int().nonnegative().default(0),
  unassessedDroppedCount: z.number().int().nonnegative().default(0),
  assessmentValidationFailureCount: z.number().int().nonnegative().default(0)
}).strict();

const selectionCompletedPayloadSchema = z.object({
  finalTrackIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  finalRationale: z.string().min(1).max(1000),
  proposedRationale: z.string().min(1).max(1000).optional(),
  targetCount: z.number().int().positive().optional(),
  requestedPickCount: z.number().int().nonnegative().optional(),
  appendedCount: z.number().int().positive(),
  finalPickDiagnostics: finalPickDiagnosticsPayloadSchema.optional(),
  skippedPicks: z.array(z.object({
    id: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(300).optional(),
    artist: z.string().min(1).max(300).optional(),
    dedupeKey: z.string().min(1).max(1000).optional(),
    reason: z.enum(['id_excluded', 'dedupe_excluded', 'no_remaining_slots'])
  }).strict()).max(20)
}).strict();

const queueChangedPayloadSchema = z.object({
  action: z.enum(['append', 'swap_next', 'skip', 'ban_track', 'ban_artist']),
  trackIds: z.array(z.string().min(1)).max(20),
  position: z.enum(['end', 'after_current']).optional(),
  beforeCurrentTrackId: z.string().min(1).optional(),
  afterQueuePreview: z.array(z.object({
    id: z.string().min(1),
    name: z.string().max(300).optional(),
    artist: z.string().max(300).optional()
  }).strict()).max(12).default([])
}).strict();

const segueGeneratedPayloadSchema = z.object({
  fromTrackId: z.string().min(1),
  toTrackId: z.string().min(1),
  selectionEventId: z.string().min(1).optional(),
  segueSummary: z.string().min(1).max(1000)
}).strict();

export const djEventTypeSchema = z.enum([
  'listener_request_received',
  'directive_updated',
  'personal_context_uploaded',
  'selection_started',
  'track_selected',
  'selection_completed',
  'queue_changed',
  'segue_generated'
]);

export type DjEventType = z.infer<typeof djEventTypeSchema>;

const payloadSchemas = {
  listener_request_received: listenerRequestReceivedPayloadSchema,
  directive_updated: directiveUpdatedPayloadSchema,
  personal_context_uploaded: personalContextUploadedPayloadSchema,
  selection_started: selectionStartedPayloadSchema,
  track_selected: trackSelectedPayloadSchema,
  selection_completed: selectionCompletedPayloadSchema,
  queue_changed: queueChangedPayloadSchema,
  segue_generated: segueGeneratedPayloadSchema
} satisfies Record<DjEventType, z.ZodTypeAny>;

export type DjEventRow = {
  id: string;
  user_id: string;
  type: DjEventType;
  correlation_id: string;
  causation_event_id: string | null;
  run_id: string | null;
  track_id: string | null;
  payload_json: string;
  created_at: string;
};

export type AppendDjEventInput = z.infer<typeof eventBaseSchema> & {
  type: DjEventType;
  payload: unknown;
};

export type DjEventRecord = {
  id: string;
  userId: string;
  type: DjEventType;
  correlationId: string;
  causationEventId: string | null;
  runId: string | null;
  trackId: string | null;
  payload: unknown;
  createdAt: string;
};

export function appendDjEvent(input: AppendDjEventInput): DjEventRecord {
  const base = eventBaseSchema.extend({ type: djEventTypeSchema }).parse(input);
  const payload = payloadSchemas[base.type].parse(input.payload);
  const id = randomUUID();
  const correlationId = base.correlationId ?? id;
  const createdAt = base.createdAt ?? new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO dj_events (
        id, user_id, type, correlation_id, causation_event_id, run_id, track_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      base.userId,
      base.type,
      correlationId,
      base.causationEventId ?? null,
      base.runId ?? null,
      base.trackId ?? null,
      JSON.stringify(payload),
      createdAt
    );

  return {
    id,
    userId: base.userId,
    type: base.type,
    correlationId,
    causationEventId: base.causationEventId ?? null,
    runId: base.runId ?? null,
    trackId: base.trackId ?? null,
    payload,
    createdAt
  };
}

export function withDjEventTransaction<T>(operation: () => T): T {
  return getDb().transaction(operation)();
}

export function getRecentDjEvents(userId: string, limit = 50): DjEventRecord[] {
  const rows = getDb()
    .prepare<[string, number], DjEventRow>(
      `SELECT * FROM dj_events
       WHERE user_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(userId, limit);
  return rows.map(mapDjEventRow);
}

export function getRecentTrackSelectedEvent(
  userId: string,
  trackId: string
): DjEventRecord | null {
  const row = getDb()
    .prepare<[string, string], DjEventRow>(
      `SELECT * FROM dj_events
       WHERE user_id = ? AND type = 'track_selected' AND track_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(userId, trackId);
  return row ? mapDjEventRow(row) : null;
}

function mapDjEventRow(row: DjEventRow): DjEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    correlationId: row.correlation_id,
    causationEventId: row.causation_event_id,
    runId: row.run_id,
    trackId: row.track_id,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  };
}
