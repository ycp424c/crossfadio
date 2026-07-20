import type { CandidateSource, QueryFunnelEntry } from './schema.js';
import {
  appendRetrievalAttempts,
  listRecentRetrievalAttempts,
  type RetrievalAttemptEntry,
  type RetrievalRequestKind,
} from '../store/retrieval-attempts.js';

export type PrepareRetrievalQueriesInput = {
  userId: string;
  runId: string;
  requestKind: RetrievalRequestKind;
  queries: string[];
  source: CandidateSource;
  maxQueries: number;
  now?: Date;
  attemptedInRun?: ReadonlySet<string>;
};

export type PreparedRetrievalQueries = {
  status: 'ready' | 'alternative_query_required';
  queries: string[];
  funnelEntries: QueryFunnelEntry[];
};

const DUPLICATE_BLOCK_MS = 30 * 60 * 1_000;
const SOFT_LOWER_WINDOW_MS = 24 * 60 * 60 * 1_000;
const LOW_YIELD_WINDOW_MS = 24 * 60 * 60 * 1_000;
const LOW_YIELD_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const SOFT_REPEAT_PENALTY = 0.2;

export function sanitizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchQuery(query: string): string {
  return sanitizeSearchQuery(query).toLowerCase();
}

export function prepareRetrievalQueries(
  input: PrepareRetrievalQueriesInput,
): PreparedRetrievalQueries {
  const now = input.now ?? new Date();
  const uniqueQueries = uniqueSanitizedQueries(input.queries);
  const history = listRecentRetrievalAttempts({
    userId: input.userId,
    source: input.source,
    now,
  });
  const persistedInRun = new Set(
    history
      .filter((attempt) => attempt.runId === input.runId)
      .map((attempt) => attempt.normalizedQuery),
  );
  const autonomousHistory = history.filter((attempt) => attempt.requestKind === 'autonomous');
  const latestByQuery = new Map<string, (typeof history)[number]>();
  const historyByQuery = new Map<string, typeof history>();
  for (const attempt of autonomousHistory) {
    if (!latestByQuery.has(attempt.normalizedQuery)) {
      latestByQuery.set(attempt.normalizedQuery, attempt);
    }
    const queryHistory = historyByQuery.get(attempt.normalizedQuery) ?? [];
    queryHistory.push(attempt);
    historyByQuery.set(attempt.normalizedQuery, queryHistory);
  }

  const scored = uniqueQueries.map((query, index) => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (input.attemptedInRun?.has(normalizedQuery) || persistedInRun.has(normalizedQuery)) {
      return { query, normalizedQuery, index, blocked: true, repeatPenalty: 0, selectionRate: null };
    }
    if (input.requestKind === 'explicit_request') {
      return { query, normalizedQuery, index, blocked: false, repeatPenalty: 0, selectionRate: null };
    }
    const latest = latestByQuery.get(normalizedQuery);
    if (!latest) {
      return { query, normalizedQuery, index, blocked: false, repeatPenalty: 0, selectionRate: null };
    }
    const ageMs = now.getTime() - new Date(latest.attemptedAt).getTime();
    const selectionRate = latest.addedCount > 0
      ? Math.round((latest.selectedCount / latest.addedCount) * 1_000) / 1_000
      : null;
    return {
      query,
      normalizedQuery,
      index,
      blocked: ageMs < DUPLICATE_BLOCK_MS
        || isLowYieldCooldown(historyByQuery.get(normalizedQuery) ?? [], now),
      repeatPenalty: ageMs < SOFT_LOWER_WINDOW_MS ? SOFT_REPEAT_PENALTY : 0,
      selectionRate,
    };
  });
  const selected = scored
    .filter((item) => !item.blocked)
    .sort((left, right) => left.repeatPenalty - right.repeatPenalty || left.index - right.index)
    .slice(0, Math.max(0, input.maxQueries));
  const funnelEntries = selected.map((item): QueryFunnelEntry => ({
    query: item.query,
    normalizedQuery: item.normalizedQuery,
    source: input.source,
    searchedCount: 0,
    resultCount: 0,
    addedCount: 0,
    selectedCount: 0,
    scoreMultiplier: 1 - item.repeatPenalty,
    repeatPenalty: item.repeatPenalty,
    selectionRate: item.selectionRate,
  }));

  return {
    status: uniqueQueries.length > 0 && selected.length === 0
      ? 'alternative_query_required'
      : 'ready',
    queries: selected.map((item) => item.query),
    funnelEntries,
  };
}

function isLowYieldCooldown(
  attempts: ReturnType<typeof listRecentRetrievalAttempts>,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  let streak = 0;
  let newestLowYieldAt: number | null = null;
  for (const attempt of attempts) {
    const attemptedAt = new Date(attempt.attemptedAt).getTime();
    if (nowMs - attemptedAt >= LOW_YIELD_WINDOW_MS) break;
    if (attempt.selectedCount > 0) break;
    if (attempt.selectedCount === 0) {
      streak += 1;
      newestLowYieldAt ??= attemptedAt;
    }
    if (streak >= 2) {
      return newestLowYieldAt !== null && nowMs - newestLowYieldAt < LOW_YIELD_COOLDOWN_MS;
    }
  }
  return false;
}

export function recordRetrievalQueryFunnel(input: {
  userId: string;
  runId: string;
  requestKind: RetrievalRequestKind;
  attemptedAt?: Date;
  entries: RetrievalAttemptEntry[];
}): number {
  return appendRetrievalAttempts(input);
}

function uniqueSanitizedQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const rawQuery of queries) {
    const query = sanitizeSearchQuery(rawQuery);
    const normalized = normalizeSearchQuery(query);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(query);
  }
  return unique;
}
