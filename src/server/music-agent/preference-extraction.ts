import { z } from 'zod';
import { getDb } from '../store/db.js';
import {
  completePreferenceExtractionBatch,
  deadLetterPreferenceExtractionBatch,
  getPreferenceExtractionBatch,
  markPreferenceExtractionBatchRetryable
} from '../store/preference-extraction-batches.js';
import { createPreferenceExtractionBatch } from '../store/preference-extraction-batches.js';
import { savePreferenceEvidence } from '../store/preference-evidence.js';
import { getMessagesByIds, markMessagesExtracted } from '../store/messages.js';
import type { LlmCompleteOptions, LlmMessage } from '../llm/client.js';

export const PREFERENCE_EXTRACTION_VERSION = 'preference-extractor-v1';
export const MAX_PREFERENCE_EXTRACTION_ATTEMPTS = 8;

export function enqueuePreferenceExtractionMessage(input: {
  userId: string;
  messageId: number;
  createdAt?: string;
}) {
  return createPreferenceExtractionBatch({
    userId: input.userId,
    sourceKey: `message:${input.messageId}`,
    messageIds: [input.messageId],
    extractorVersion: PREFERENCE_EXTRACTION_VERSION,
    ...(input.createdAt ? { createdAt: input.createdAt } : {})
  });
}

export const extractedPreferenceEvidenceSchema = z.object({
  evidenceKind: z.enum(['expressed', 'inferred']),
  subject: z.object({
    type: z.enum(['artist', 'track', 'album', 'genre', 'style', 'scene', 'relationship']),
    key: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(300).optional()
  }).strict(),
  polarity: z.enum(['positive', 'negative']),
  strength: z.enum(['weak', 'medium', 'strong']),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(z.object({
    messageId: z.number().int().positive()
  }).strict()).min(1).max(20),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional()
}).strict();

export const preferenceExtractionOutputSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('evidence'),
    evidence: z.array(extractedPreferenceEvidenceSchema).min(1).max(20)
  }).strict(),
  z.object({ result: z.literal('no_evidence') }).strict()
]);

export type PreferenceExtractionApplyResult =
  | { status: 'succeeded'; evidenceIds: string[] }
  | { status: 'no_evidence'; evidenceIds: [] }
  | { status: 'retryable'; evidenceIds: []; errorCode: string }
  | { status: 'dead_lettered'; evidenceIds: []; errorCode: string }
  | { status: 'stale_attempt'; evidenceIds: [] }
  | { status: 'already_completed'; evidenceIds: [] };

export type PreferenceExtractionClient = {
  complete(
    messages: LlmMessage[],
    options?: LlmCompleteOptions
  ): Promise<{ content: string }>;
};

export async function runPreferenceExtractionBatch(input: {
  batch: import('../store/preference-extraction-batches.js').PreferenceExtractionBatch;
  client: PreferenceExtractionClient;
  signal?: AbortSignal;
  attemptedAt?: string;
}): Promise<PreferenceExtractionApplyResult> {
  if (!input.batch.leaseToken) return { status: 'stale_attempt', evidenceIds: [] };
  const messages = getMessagesByIds(input.batch.userId, input.batch.messageIds);
  if (messages.length !== input.batch.messageIds.length) {
    return recordPreferenceExtractionFailure({
      userId: input.batch.userId,
      batchId: input.batch.id,
      leaseToken: input.batch.leaseToken,
      errorCode: 'transport_error',
      attemptedAt: input.attemptedAt
    });
  }

  try {
    const response = await input.client.complete(buildPreferenceExtractionMessages(messages), {
      temperature: 0,
      maxTokens: 1_600,
      responseFormat: { type: 'json_object' },
      thinking: { type: 'disabled' },
      signal: input.signal
    });
    if (input.signal?.aborted) throw abortError(input.signal.reason);
    const result = applyPreferenceExtractionOutput({
      userId: input.batch.userId,
      batchId: input.batch.id,
      leaseToken: input.batch.leaseToken,
      output: response.content,
      completedAt: input.attemptedAt,
      attemptedAt: input.attemptedAt
    });
    if (result.status === 'succeeded' || result.status === 'no_evidence') {
      markMessagesExtracted(input.batch.userId, input.batch.messageIds);
    }
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return recordPreferenceExtractionFailure({
      userId: input.batch.userId,
      batchId: input.batch.id,
      leaseToken: input.batch.leaseToken,
      errorCode: preferenceExtractionTransportError(error),
      attemptedAt: input.attemptedAt
    });
  }
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'preference_extraction_aborted');
  error.name = 'AbortError';
  return error;
}

export function applyPreferenceExtractionOutput(input: {
  userId: string;
  batchId: string;
  leaseToken: string;
  output: unknown;
  completedAt?: string;
  attemptedAt?: string;
}): PreferenceExtractionApplyResult {
  const completedAt = new Date(
    input.completedAt ?? input.attemptedAt ?? Date.now()
  ).toISOString();
  const batch = getPreferenceExtractionBatch(input.userId, input.batchId);
  if (!batch) throw new Error('preference_extraction_batch_not_found');
  if (batch.status === 'succeeded' || batch.status === 'no_evidence' || batch.status === 'dead') {
    return { status: 'already_completed', evidenceIds: [] };
  }
  if (
    batch.status !== 'processing'
    || batch.leaseToken !== input.leaseToken
    || !batch.leaseUntil
    || Date.parse(batch.leaseUntil) <= Date.parse(completedAt)
  ) {
    return { status: 'stale_attempt', evidenceIds: [] };
  }

  const decoded = decodeWireOutput(input.output);
  const parsed = preferenceExtractionOutputSchema.safeParse(decoded.value);
  if (!parsed.success) {
    return recordRetryableFailure({
      userId: input.userId,
      batchId: batch.id,
      leaseToken: input.leaseToken,
      attemptCount: batch.attemptCount,
      errorCode: decoded.malformed ? 'malformed_output' : 'schema_mismatch',
      attemptedAt: input.attemptedAt
    });
  }

  if (parsed.data.result === 'no_evidence') {
    const completed = completePreferenceExtractionBatch({
      userId: input.userId,
      id: batch.id,
      leaseToken: input.leaseToken,
      outcome: 'no_evidence',
      completedAt
    });
    return completed
      ? { status: 'no_evidence', evidenceIds: [] }
      : { status: 'stale_attempt', evidenceIds: [] };
  }

  const batchMessageIds = new Set(batch.messageIds);
  if (parsed.data.evidence.some((item) => (
    item.sourceRefs.some((ref) => !batchMessageIds.has(ref.messageId))
  ))) {
    return recordRetryableFailure({
      userId: input.userId,
      batchId: batch.id,
      leaseToken: input.leaseToken,
      attemptCount: batch.attemptCount,
      errorCode: 'source_mismatch',
      attemptedAt: input.attemptedAt
    });
  }

  const sourceMessages = getMessagesByIds(input.userId, batch.messageIds);
  const observedAtByMessageId = new Map(sourceMessages.map((message) => [
    message.id,
    sqliteTimestampToIso(message.created_at)
  ]));
  if (observedAtByMessageId.size !== batch.messageIds.length) {
    return recordRetryableFailure({
      userId: input.userId,
      batchId: batch.id,
      leaseToken: input.leaseToken,
      attemptCount: batch.attemptCount,
      errorCode: 'source_mismatch',
      attemptedAt: input.attemptedAt
    });
  }

  const extractedEvidence = parsed.data.evidence;
  const evidenceIds = getDb().transaction(() => {
    const claimed = getPreferenceExtractionBatch(input.userId, input.batchId);
    if (
      claimed?.status !== 'processing'
      || claimed.leaseToken !== input.leaseToken
      || !claimed.leaseUntil
      || Date.parse(claimed.leaseUntil) <= Date.parse(completedAt)
    ) return null;
    const completed = completePreferenceExtractionBatch({
      userId: input.userId,
      id: batch.id,
      leaseToken: input.leaseToken,
      outcome: 'succeeded',
      completedAt
    });
    if (!completed) return null;
    const ids = extractedEvidence.map((item) => {
      const observedAt = latestObservedAt(item.sourceRefs.map((ref) => (
        observedAtByMessageId.get(ref.messageId)!
      )));
      return savePreferenceEvidence({
        userId: input.userId,
        evidenceKind: item.evidenceKind,
        subjectType: item.subject.type,
        subjectKey: item.subject.key,
        polarity: item.polarity,
        strength: item.strength,
        confidence: item.confidence,
        sourceKind: 'chat_extraction',
        sourceRefs: item.sourceRefs,
        observedAt,
        extractorVersion: batch.extractorVersion,
        payload: {
          batchId: batch.id,
          ...(item.subject.label ? { subjectLabel: item.subject.label } : {})
        }
      }).id;
    });
    return ids;
  }).immediate();
  if (!evidenceIds) return { status: 'stale_attempt', evidenceIds: [] };
  return { status: 'succeeded', evidenceIds };
}

function latestObservedAt(values: string[]): string {
  return values.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

export function recordPreferenceExtractionFailure(input: {
  userId: string;
  batchId: string;
  leaseToken: string;
  errorCode: 'timeout' | 'transport_error' | 'rate_limited';
  attemptedAt?: string;
}): PreferenceExtractionApplyResult {
  const attemptedAt = new Date(input.attemptedAt ?? Date.now()).toISOString();
  const batch = getPreferenceExtractionBatch(input.userId, input.batchId);
  if (!batch) throw new Error('preference_extraction_batch_not_found');
  if (batch.status === 'succeeded' || batch.status === 'no_evidence' || batch.status === 'dead') {
    return { status: 'already_completed', evidenceIds: [] };
  }
  if (
    batch.status !== 'processing'
    || batch.leaseToken !== input.leaseToken
    || !batch.leaseUntil
    || Date.parse(batch.leaseUntil) <= Date.parse(attemptedAt)
  ) {
    return { status: 'stale_attempt', evidenceIds: [] };
  }
  return recordRetryableFailure({
    userId: input.userId,
    batchId: batch.id,
    leaseToken: input.leaseToken,
    attemptCount: batch.attemptCount,
    errorCode: input.errorCode,
    attemptedAt
  });
}

function decodeWireOutput(value: unknown): { value: unknown; malformed: boolean } {
  if (typeof value !== 'string') return { value, malformed: false };
  try {
    return { value: JSON.parse(value) as unknown, malformed: false };
  } catch {
    return { value, malformed: true };
  }
}

function buildPreferenceExtractionMessages(
  messages: Array<{ id: number; role: string; content: string; created_at: string }>
): LlmMessage[] {
  const source = messages.map((message) => ({
    messageId: message.id,
    role: message.role,
    content: message.content,
    observedAt: sqliteTimestampToIso(message.created_at)
  }));
  return [
    {
      role: 'system',
      content: [
        'Extract only explicit or strongly supported music preferences from the supplied chat messages.',
        'Return JSON with either {"result":"no_evidence"} or {"result":"evidence","evidence":[...]}.',
        'Each evidence item requires evidenceKind, subject {type,key,label?}, polarity, strength, confidence, sourceRefs, observedAt.',
        'Use only supplied messageId values and copy the corresponding observedAt exactly.',
        'Temporary listening instructions are not durable preference evidence. Explicit bans are exclusions, not preferences.',
        'Do not include explanations or hidden reasoning.'
      ].join(' ')
    },
    { role: 'user', content: JSON.stringify({ messages: source }) }
  ];
}

function sqliteTimestampToIso(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(normalized) ? normalized : `${normalized}Z`;
  const timestamp = Date.parse(withZone);
  if (!Number.isFinite(timestamp)) throw new Error('invalid_message_created_at');
  return new Date(timestamp).toISOString();
}

function preferenceExtractionTransportError(
  error: unknown
): 'timeout' | 'transport_error' | 'rate_limited' {
  if (error instanceof Error && (error.name === 'AbortError' || /timeout|aborted/iu.test(error.message))) {
    return 'timeout';
  }
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : null;
  return status === 429 ? 'rate_limited' : 'transport_error';
}

function recordRetryableFailure(input: {
  userId: string;
  batchId: string;
  leaseToken: string;
  attemptCount: number;
  errorCode: string;
  attemptedAt?: string;
}): PreferenceExtractionApplyResult {
  const attemptedAt = input.attemptedAt ?? new Date().toISOString();
  if (input.attemptCount >= MAX_PREFERENCE_EXTRACTION_ATTEMPTS) {
    const dead = deadLetterPreferenceExtractionBatch({
      userId: input.userId,
      id: input.batchId,
      leaseToken: input.leaseToken,
      errorCode: input.errorCode,
      attemptedAt
    });
    return dead
      ? { status: 'dead_lettered', evidenceIds: [], errorCode: input.errorCode }
      : { status: 'stale_attempt', evidenceIds: [] };
  }
  const delayMinutes = Math.min(60, Math.pow(2, Math.max(0, input.attemptCount - 1)));
  const nextAttemptAt = new Date(
    Date.parse(attemptedAt) + delayMinutes * 60 * 1000
  ).toISOString();
  const retryable = markPreferenceExtractionBatchRetryable({
    userId: input.userId,
    id: input.batchId,
    leaseToken: input.leaseToken,
    errorCode: input.errorCode,
    attemptedAt,
    nextAttemptAt
  });
  return retryable
    ? { status: 'retryable', evidenceIds: [], errorCode: input.errorCode }
    : { status: 'stale_attempt', evidenceIds: [] };
}
