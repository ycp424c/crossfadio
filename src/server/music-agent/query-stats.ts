import type { CandidateSource, QueryFunnelEntry } from './schema.js';
import {
  getUserQueryStats,
  recordMusicQueryFunnel,
  type MusicQueryStatsRecord
} from '../store/music-query-stats.js';

export type PrepareSearchQueriesInput = {
  userId: string;
  queries: string[];
  source: CandidateSource;
  maxQueries: number;
};

export type PreparedSearchQueries = {
  queries: string[];
  funnelEntries: QueryFunnelEntry[];
};

type ScoredQuery = QueryFunnelEntry & {
  index: number;
  cooldowned: boolean;
};

const RECENT_REPEAT_PENALTY = 0.32;
const RECENT_WINDOW_PENALTY = 0.2;
const SEEN_BEFORE_PENALTY = 0.08;
const GOOD_SELECTION_BOOST = 0.12;
const OK_SELECTION_BOOST = 0.06;
const LOW_SELECTION_PENALTY = 0.08;
const EMPTY_RESULT_PENALTY = 0.1;
const LOW_YIELD_COOLDOWN_SEARCHES = 2;
const LOW_YIELD_COOLDOWN_WINDOW = 3;

export function sanitizeSearchQuery(query: string): string {
  return compactWhitespace(query);
}

export function normalizeSearchQuery(query: string): string {
  return sanitizeSearchQuery(query).toLowerCase();
}

export function prepareSearchQueriesForRecall(input: PrepareSearchQueriesInput): PreparedSearchQueries {
  const stats = getUserQueryStats(input.userId);
  const statsByKey = new Map(
    stats
      .filter((item) => item.source === input.source)
      .map((item) => [item.normalized_query, item])
  );
  const mostRecentOrder = Math.max(0, ...stats.map((item) => item.last_used_order));
  const uniqueQueries = uniqueSanitizedQueries(input.queries);

  const scored = uniqueQueries.map((query, index): ScoredQuery => {
    const normalizedQuery = normalizeSearchQuery(query);
    const history = statsByKey.get(normalizedQuery) ?? null;
    const repeatPenalty = queryRepeatPenalty(history, mostRecentOrder);
    const selectionRate = querySelectionRate(history);
    const cooldowned = isLowYieldCooldown(history, mostRecentOrder);
    const scoreMultiplier = clamp(
      1 - repeatPenalty + queryQualityAdjustment(history, selectionRate),
      0.65,
      1.15
    );

    return {
      query,
      normalizedQuery,
      source: input.source,
      searchedCount: 0,
      resultCount: 0,
      addedCount: 0,
      selectedCount: 0,
      scoreMultiplier,
      repeatPenalty,
      selectionRate,
      index,
      cooldowned
    };
  });

  const eligible = scored.filter((item) => !item.cooldowned);
  const ranked = eligible.length > 0 ? eligible : scored;
  const funnelEntries = ranked
    .sort((left, right) => right.scoreMultiplier - left.scoreMultiplier || left.index - right.index)
    .slice(0, Math.max(0, input.maxQueries))
    .map(({ index: _index, cooldowned: _cooldowned, ...entry }) => entry);

  return {
    queries: funnelEntries.map((entry) => entry.query),
    funnelEntries
  };
}

export function recordUserQueryFunnel(userId: string, entries: QueryFunnelEntry[]): void {
  recordMusicQueryFunnel(userId, entries.map((entry) => ({
    query: entry.query,
    normalizedQuery: entry.normalizedQuery,
    source: entry.source,
    searchedCount: entry.searchedCount,
    resultCount: entry.resultCount,
    addedCount: entry.addedCount,
    selectedCount: entry.selectedCount
  })));
}

function uniqueSanitizedQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of queries) {
    const sanitized = sanitizeSearchQuery(query);
    if (!sanitized) continue;
    const normalized = normalizeSearchQuery(sanitized);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(sanitized);
  }
  return result;
}

function queryRepeatPenalty(history: MusicQueryStatsRecord | null, mostRecentOrder: number): number {
  if (!history) return 0;
  if (history.last_used_order === mostRecentOrder) return RECENT_REPEAT_PENALTY;
  if (history.last_used_order >= mostRecentOrder - 3) return RECENT_WINDOW_PENALTY;
  return SEEN_BEFORE_PENALTY;
}

function querySelectionRate(history: MusicQueryStatsRecord | null): number | null {
  if (!history || history.added_count <= 0) return null;
  return roundRate(history.selected_count / history.added_count);
}

function queryQualityAdjustment(history: MusicQueryStatsRecord | null, selectionRate: number | null): number {
  if (!history) return 0;
  if (history.result_count === 0) return -EMPTY_RESULT_PENALTY;
  if (selectionRate === null) return 0;
  if (selectionRate >= 0.35) return GOOD_SELECTION_BOOST;
  if (selectionRate >= 0.15) return OK_SELECTION_BOOST;
  if (history.searched_count >= 2) return -LOW_SELECTION_PENALTY;
  return 0;
}

function isLowYieldCooldown(history: MusicQueryStatsRecord | null, mostRecentOrder: number): boolean {
  if (!history) return false;
  if (history.last_used_order < mostRecentOrder - LOW_YIELD_COOLDOWN_WINDOW) return false;
  if (history.searched_count < LOW_YIELD_COOLDOWN_SEARCHES) return false;
  if (history.result_count > 0 && history.added_count === 0) return true;
  return history.added_count >= 2 && history.selected_count === 0 && history.searched_count >= 3;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}
