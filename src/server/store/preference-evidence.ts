import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db.js';

export const INFERRED_PREFERENCE_WINDOW_DAYS = 60;
export const INFERRED_PREFERENCE_HALF_LIFE_DAYS = 21;

export const preferenceSourceRefSchema = z.object({
  messageId: z.number().int().positive().optional(),
  episodeId: z.string().trim().min(1).max(100).optional(),
  eventId: z.string().trim().min(1).max(100).optional(),
  sourceId: z.string().trim().min(1).max(200).optional()
}).strict().refine(
  (value) => value.messageId !== undefined
    || value.episodeId !== undefined
    || value.eventId !== undefined
    || value.sourceId !== undefined,
  'Preference source ref must identify a source'
);

const savePreferenceEvidenceSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  evidenceKind: z.enum(['expressed', 'inferred']),
  subjectType: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
  subjectKey: z.string().trim().min(1).max(300),
  polarity: z.enum(['positive', 'negative']),
  strength: z.enum(['weak', 'medium', 'strong']),
  confidence: z.number().min(0).max(1),
  sourceKind: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  sourceRefs: z.array(preferenceSourceRefSchema).min(1).max(20),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  extractorVersion: z.string().trim().min(1).max(100).nullable().optional(),
  payload: z.record(z.unknown()).optional()
}).strict();

export type PreferenceSourceRef = z.infer<typeof preferenceSourceRefSchema>;
export type SavePreferenceEvidenceInput = z.input<typeof savePreferenceEvidenceSchema>;

export type PreferenceEvidenceRecord = {
  id: string;
  userId: string;
  evidenceKind: 'expressed' | 'inferred';
  subjectType: string;
  subjectKey: string;
  polarity: 'positive' | 'negative';
  strength: 'weak' | 'medium' | 'strong';
  confidence: number;
  sourceKind: string;
  sourceRefs: PreferenceSourceRef[];
  observedAt: string;
  expiresAt: string | null;
  extractorVersion: string | null;
  supersededById: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type EffectivePreferenceSignal = {
  subjectType: string;
  subjectKey: string;
  polarity: 'positive' | 'negative';
  score: number;
  evidenceCount: number;
  evidenceIds: string[];
  evidenceKind: 'expressed' | 'inferred';
  observedAt: string;
};

export function savePreferenceEvidence(input: SavePreferenceEvidenceInput): PreferenceEvidenceRecord {
  const parsed = savePreferenceEvidenceSchema.parse(input);
  const subjectKey = normalizeSubjectKey(parsed.subjectKey);
  const sourceRefs = canonicalSourceRefs(parsed.sourceRefs);
  const sourceRefsJson = JSON.stringify(sourceRefs);
  const extractorVersion = parsed.extractorVersion ?? null;
  const existing = getDb().prepare<[
    string, string, string, string, string, string, string, string | null
  ], PreferenceEvidenceRow>(
    `SELECT * FROM preference_evidence
     WHERE user_id = ? AND evidence_kind = ? AND subject_type = ? AND subject_key = ?
       AND polarity = ? AND source_kind = ? AND source_refs_json = ?
       AND extractor_version IS ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(
    parsed.userId,
    parsed.evidenceKind,
    parsed.subjectType,
    subjectKey,
    parsed.polarity,
    parsed.sourceKind,
    sourceRefsJson,
    extractorVersion
  );
  if (existing) return mapPreferenceEvidenceRow(existing);

  const semanticRetry = sourceRefs.some((ref) => ref.messageId !== undefined)
    ? getDb().prepare<[string, string, string, string], PreferenceEvidenceRow>(
      `SELECT * FROM preference_evidence
       WHERE user_id = ? AND subject_type = ? AND subject_key = ? AND polarity = ?
       ORDER BY CASE evidence_kind WHEN 'expressed' THEN 0 ELSE 1 END,
                observed_at DESC, created_at DESC`
    ).all(parsed.userId, parsed.subjectType, subjectKey, parsed.polarity)
      .find((row) => sourceRefsHaveSameMessages(parseSourceRefs(row.source_refs_json), sourceRefs))
    : undefined;
  if (semanticRetry) return mapPreferenceEvidenceRow(semanticRetry);

  const id = randomUUID();
  const expiresAt = resolveExpiresAt(parsed.evidenceKind, parsed.observedAt, parsed.expiresAt);
  const timestamp = new Date().toISOString();
  const db = getDb();

  db.transaction(() => {
    const activeContrary = parsed.evidenceKind === 'expressed'
      ? db.prepare<[string, string, string, string], PreferenceEvidenceRow>(
        `SELECT * FROM preference_evidence
         WHERE user_id = ?
           AND subject_type = ?
           AND subject_key = ?
           AND polarity <> ?
           AND superseded_by_id IS NULL
         ORDER BY julianday(observed_at) DESC, created_at DESC`
      ).all(
        parsed.userId,
        parsed.subjectType,
        subjectKey,
        parsed.polarity
      )
      : [];
    const supersedingContrary = activeContrary
      .filter((row) => row.evidence_kind === 'expressed')
      .filter((row) => compareExpressedOrder(
        row.observed_at, parseSourceRefs(row.source_refs_json), parsed.observedAt, sourceRefs
      ) > 0)
      .sort((left, right) => compareExpressedOrder(
        right.observed_at,
        parseSourceRefs(right.source_refs_json),
        left.observed_at,
        parseSourceRefs(left.source_refs_json)
      ))[0];

    db.prepare(
      `INSERT INTO preference_evidence (
        id, user_id, evidence_kind, subject_type, subject_key, polarity, strength,
        confidence, source_kind, source_refs_json, observed_at, expires_at,
        extractor_version, superseded_by_id, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      parsed.userId,
      parsed.evidenceKind,
      parsed.subjectType,
      subjectKey,
      parsed.polarity,
      parsed.strength,
      parsed.confidence,
      parsed.sourceKind,
      sourceRefsJson,
      parsed.observedAt,
      expiresAt,
      extractorVersion,
      supersedingContrary?.id ?? null,
      JSON.stringify(parsed.payload ?? {}),
      timestamp,
      timestamp
    );

    if (parsed.evidenceKind === 'expressed' && !supersedingContrary) {
      const supersede = db.prepare(
        `UPDATE preference_evidence
         SET superseded_by_id = ?, updated_at = ?
         WHERE id = ? AND superseded_by_id IS NULL`
      );
      for (const row of activeContrary) {
        const olderOrEqual = row.evidence_kind === 'inferred'
          ? Date.parse(row.observed_at) <= Date.parse(parsed.observedAt)
          : compareExpressedOrder(
              parsed.observedAt,
              sourceRefs,
              row.observed_at,
              parseSourceRefs(row.source_refs_json)
            ) >= 0;
        if (olderOrEqual) supersede.run(id, timestamp, row.id);
      }
    }
  })();

  return getPreferenceEvidenceById(parsed.userId, id)!;
}

export function listEffectivePreferenceEvidence(
  userId: string,
  options: { now?: Date; limit?: number } = {}
): PreferenceEvidenceRecord[] {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const inferredCutoff = new Date(
    now.getTime() - INFERRED_PREFERENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDb().prepare<[string, string, string, number], PreferenceEvidenceRow>(
    `SELECT * FROM preference_evidence
     WHERE user_id = ?
       AND superseded_by_id IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (evidence_kind = 'expressed' OR observed_at >= ?)
     ORDER BY observed_at DESC, created_at DESC
     LIMIT ?`
  ).all(userId, nowIso, inferredCutoff, limit);
  return rows.map(mapPreferenceEvidenceRow);
}

export function getPreferenceEvidenceById(
  userId: string,
  id: string
): PreferenceEvidenceRecord | null {
  const row = getDb().prepare<[string, string], PreferenceEvidenceRow>(
    `SELECT * FROM preference_evidence WHERE user_id = ? AND id = ?`
  ).get(userId, id);
  return row ? mapPreferenceEvidenceRow(row) : null;
}

export function getEffectivePreferenceSignals(
  userId: string,
  options: { now?: Date } = {}
): EffectivePreferenceSignal[] {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const inferredCutoff = new Date(
    now.getTime() - INFERRED_PREFERENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const records = getDb().prepare<[string, string, string], PreferenceEvidenceRow>(
    `SELECT * FROM preference_evidence
     WHERE user_id = ?
       AND superseded_by_id IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (evidence_kind = 'expressed' OR observed_at >= ?)
     ORDER BY observed_at DESC, created_at DESC`
  ).iterate(userId, nowIso, inferredCutoff);
  const groups = new Map<string, EffectivePreferenceSignal>();

  for (const row of records) {
    const record = mapPreferenceEvidenceRow(row);
    const key = [
      record.evidenceKind,
      record.subjectType,
      record.subjectKey,
      record.polarity
    ].join('\u0000');
    const current = groups.get(key) ?? {
      subjectType: record.subjectType,
      subjectKey: record.subjectKey,
      polarity: record.polarity,
      score: 0,
      evidenceCount: 0,
      evidenceIds: [],
      evidenceKind: record.evidenceKind,
      observedAt: record.observedAt
    };
    const strengthWeight = { weak: 0.35, medium: 0.65, strong: 1 }[record.strength];
    const ageDays = Math.max(0, now.getTime() - Date.parse(record.observedAt)) / (24 * 60 * 60 * 1000);
    const freshnessWeight = record.evidenceKind === 'inferred'
      ? Math.pow(0.5, ageDays / INFERRED_PREFERENCE_HALF_LIFE_DAYS)
      : 1;
    current.score = Math.min(
      1,
      current.score + record.confidence * strengthWeight * freshnessWeight
    );
    current.evidenceCount += 1;
    if (current.evidenceIds.length < 20) current.evidenceIds.push(record.id);
    if (Date.parse(record.observedAt) > Date.parse(current.observedAt)) {
      current.observedAt = record.observedAt;
    }
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((signal) => ({ ...signal, score: roundScore(signal.score) }))
    .sort((a, b) => (
      (a.evidenceKind === b.evidenceKind ? 0 : a.evidenceKind === 'expressed' ? -1 : 1)
      || b.score - a.score
      || Date.parse(b.observedAt) - Date.parse(a.observedAt)
      || a.subjectKey.localeCompare(b.subjectKey)
    ));
}

export function cleanupExpiredInferredPreferenceEvidence(now: Date = new Date()): number {
  return getDb().prepare(`
    DELETE FROM preference_evidence
    WHERE evidence_kind = 'inferred'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).run(now.toISOString()).changes;
}

function resolveExpiresAt(
  evidenceKind: 'expressed' | 'inferred',
  observedAt: string,
  declared: string | null | undefined
): string | null {
  if (evidenceKind === 'expressed') return null;
  const maximum = Date.parse(observedAt) + INFERRED_PREFERENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (!declared) return new Date(maximum).toISOString();
  return new Date(Math.min(maximum, Date.parse(declared))).toISOString();
}

function normalizeSubjectKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function compareExpressedOrder(
  leftObservedAt: string,
  leftRefs: PreferenceSourceRef[],
  rightObservedAt: string,
  rightRefs: PreferenceSourceRef[]
): number {
  const timeDelta = Date.parse(leftObservedAt) - Date.parse(rightObservedAt);
  if (timeDelta !== 0) return timeDelta;
  const leftMessageId = maximumMessageId(leftRefs);
  const rightMessageId = maximumMessageId(rightRefs);
  if (leftMessageId !== null && rightMessageId !== null) return leftMessageId - rightMessageId;
  return 0;
}

function maximumMessageId(refs: PreferenceSourceRef[]): number | null {
  const ids = refs.flatMap((ref) => ref.messageId === undefined ? [] : [ref.messageId]);
  return ids.length > 0 ? Math.max(...ids) : null;
}

function canonicalSourceRefs(sourceRefs: PreferenceSourceRef[]): PreferenceSourceRef[] {
  return [...sourceRefs].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

function sourceRefsHaveSameMessages(
  left: PreferenceSourceRef[],
  right: PreferenceSourceRef[]
): boolean {
  const messages = (refs: PreferenceSourceRef[]) => [...new Set(refs.flatMap((ref) => (
    ref.messageId === undefined ? [] : [ref.messageId]
  )))].sort((a, b) => a - b);
  const leftMessageIds = messages(left);
  const rightMessageIds = messages(right);
  return leftMessageIds.length > 0
    && leftMessageIds.length === rightMessageIds.length
    && leftMessageIds.every((id, index) => id === rightMessageIds[index]);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type PreferenceEvidenceRow = {
  id: string;
  user_id: string;
  evidence_kind: 'expressed' | 'inferred';
  subject_type: string;
  subject_key: string;
  polarity: 'positive' | 'negative';
  strength: 'weak' | 'medium' | 'strong';
  confidence: number;
  source_kind: string;
  source_refs_json: string;
  observed_at: string;
  expires_at: string | null;
  extractor_version: string | null;
  superseded_by_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

function mapPreferenceEvidenceRow(row: PreferenceEvidenceRow): PreferenceEvidenceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    evidenceKind: row.evidence_kind,
    subjectType: row.subject_type,
    subjectKey: row.subject_key,
    polarity: row.polarity,
    strength: row.strength,
    confidence: row.confidence,
    sourceKind: row.source_kind,
    sourceRefs: parseSourceRefs(row.source_refs_json),
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    extractorVersion: row.extractor_version,
    supersededById: row.superseded_by_id,
    payload: parseRecord(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseSourceRefs(value: string): PreferenceSourceRef[] {
  try {
    const parsed = z.array(preferenceSourceRefSchema).safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
