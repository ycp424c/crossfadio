import { randomUUID } from 'node:crypto';

import type { FinalPick } from './schema.js';
import type { CandidateSource, QueryFunnelEntry } from './schema.js';
import type { NcmTrackLike } from './liked-recall.js';
import { normalizeSearchQuery } from './retrieval-history.js';
import type { RetrievalRequestKind } from '../store/retrieval-attempts.js';

export type QueryFunnelAccumulator = QueryFunnelEntry & {
  candidateIds: Set<string>;
  resultIds: Set<string>;
  order: number;
};

export type QueryFunnelState = {
  queryFunnel: Map<string, QueryFunnelAccumulator>;
  retrievalRunId?: string;
  retrievalRequestKind?: RetrievalRequestKind;
  retrievalAttemptedAt?: Date;
};

export type QueryFunnelPool = {
  has: (id: string) => boolean;
};

export type QueryFunnelRecorder = (input: {
  userId: string;
  runId: string;
  requestKind: RetrievalRequestKind;
  attemptedAt: Date;
  entries: QueryFunnelEntry[];
}) => void;

export function createQueryFunnelState(input: {
  runId?: string;
  requestKind?: RetrievalRequestKind;
  attemptedAt?: Date;
} = {}): QueryFunnelState {
  return {
    queryFunnel: new Map(),
    retrievalRunId: input.runId ?? randomUUID(),
    retrievalRequestKind: input.requestKind ?? 'autonomous',
    retrievalAttemptedAt: input.attemptedAt ?? new Date(),
  };
}

export function recordQueryFunnelSearch(
  state: QueryFunnelState,
  input: {
    seed?: QueryFunnelEntry;
    query: string;
    source: CandidateSource;
    tracks: NcmTrackLike[];
    admittedTracks?: NcmTrackLike[];
    resultCount: number;
    addedCount: number;
    pool: QueryFunnelPool;
  }
): void {
  const normalizedQuery = normalizeSearchQuery(input.query);
  if (!normalizedQuery) return;
  const key = queryFunnelKey(input.source, normalizedQuery);
  const existing = state.queryFunnel.get(key);
  const admittedTracks = input.admittedTracks ?? input.tracks;
  const candidateIds = new Set(
    admittedTracks
      .map((track) => track.id === undefined || track.id === null ? '' : String(track.id).trim())
      .filter((id) => id && input.pool.has(id))
  );
  const resultIds = new Set(input.tracks.map(trackResultKey).filter(Boolean));
  if (existing) {
    const uniqueAddedCount = [...candidateIds].filter((id) => !existing.candidateIds.has(id)).length;
    existing.searchedCount += 1;
    existing.resultCount += input.resultCount;
    existing.addedCount += uniqueAddedCount;
    for (const id of candidateIds) existing.candidateIds.add(id);
    for (const id of resultIds) existing.resultIds.add(id);
    existing.uniqueResultCount = existing.resultIds.size;
    return;
  }

  state.queryFunnel.set(key, {
    ...(input.seed ?? {
      query: input.query,
      normalizedQuery,
      source: input.source,
      searchedCount: 0,
      resultCount: 0,
      uniqueResultCount: 0,
      addedCount: 0,
      selectedCount: 0,
      scoreMultiplier: 1,
      repeatPenalty: 0,
      selectionRate: null
    }),
    searchedCount: 1,
    resultCount: input.resultCount,
    uniqueResultCount: resultIds.size,
    addedCount: candidateIds.size,
    selectedCount: 0,
    candidateIds,
    resultIds,
    order: state.queryFunnel.size
  });
}

export function queryFunnelSnapshot(state: QueryFunnelState): QueryFunnelEntry[] {
  return [...state.queryFunnel.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ candidateIds: _candidateIds, resultIds: _resultIds, order: _order, ...entry }) => ({ ...entry }));
}

export function recordQueryFunnelSnapshot(
  userId: string,
  state: QueryFunnelState,
  recorder: QueryFunnelRecorder
): void {
  recorderInput(userId, state, queryFunnelSnapshot(state), recorder);
}

export function recordFinalQueryFunnel(
  userId: string,
  state: QueryFunnelState,
  picks: Array<Pick<FinalPick, 'id'>>,
  recorder: QueryFunnelRecorder
): void {
  const pickedIds = new Set(picks.map((pick) => pick.id));
  for (const entry of state.queryFunnel.values()) {
    entry.selectedCount = [...entry.candidateIds].filter((id) => pickedIds.has(id)).length;
  }
  recorderInput(userId, state, queryFunnelSnapshot(state), recorder);
}

function recorderInput(
  userId: string,
  state: QueryFunnelState,
  entries: QueryFunnelEntry[],
  recorder: QueryFunnelRecorder,
): void {
  state.retrievalRunId ??= randomUUID();
  state.retrievalRequestKind ??= 'autonomous';
  state.retrievalAttemptedAt ??= new Date();
  recorder({
    userId,
    runId: state.retrievalRunId,
    requestKind: state.retrievalRequestKind,
    attemptedAt: state.retrievalAttemptedAt,
    entries,
  });
}

export function queryFunnelKey(source: CandidateSource, normalizedQuery: string): string {
  return `${source}:${normalizedQuery}`;
}

export function searchRunKey(_source: CandidateSource, query: string, _limit: number): string {
  return normalizeSearchQuery(query);
}

export function trackResultKey(track: NcmTrackLike, index: number): string {
  const id = track.id === undefined || track.id === null ? '' : String(track.id).trim();
  if (id) return id;
  const name = track.name?.trim() ?? '';
  const artist = track.artists?.join('/').trim() ?? '';
  return name || artist ? `${normalizeSearchQuery(name)}::${normalizeSearchQuery(artist)}::${index}` : '';
}
