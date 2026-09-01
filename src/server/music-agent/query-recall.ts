import { randomUUID } from 'node:crypto';

import type { CandidatePool } from './candidates.js';
import {
  emptyUpsertTracksResult,
  mergeUpsertTracksResult,
  summarizeCandidateAdmission,
  upsertTracks
} from './candidate-admission.js';
import type { EntityRecallNcmClient } from './entity-recall.js';
import { recallFromEntity } from './entity-recall.js';
import {
  artistFallbackNameFromQuery,
  readRecallSearchCache,
  recallSearchCacheKey,
  writeRecallSearchCache,
  type RecallSearchCacheEntry
} from './recall-search.js';
import {
  formatNoExecutableQueryReason,
  prepareRecallQueryEligibility,
  SEMANTIC_ONLY_QUERY_PROBLEM
} from './recall-query-filtering.js';
import {
  recordQueryFunnelSearch,
  searchRunKey,
  type QueryFunnelState
} from './query-funnel.js';
import {
  normalizeSearchQuery,
  prepareRetrievalQueries,
} from './retrieval-history.js';
import type { RetrievalRequestKind } from '../store/retrieval-attempts.js';
import {
  recallFromSemanticEntities,
  type MusicAgentEmbeddingClient
} from './semantic-recall.js';
import type {
  CandidateProvenanceKind,
  CandidateSource,
  MusicAgentContextSummary,
  MusicCandidateScores,
  QueryPlan
} from './schema.js';
import type { NcmTrackLike } from './liked-recall.js';
import { artistKeys } from './artists.js';
import {
  buildSourceReservoirIdentity,
  isSourceReservoirFetchAvailable,
  recordSourceReservoirFetch,
  type SourceReservoirSourceKind
} from '../store/source-reservoir.js';

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_ENTITY_RECALL_LIMIT = 5;
const DEFAULT_ENTITY_SEARCH_LIMIT = 3;
const MAX_ARTIST_FALLBACKS_PER_RECALL = 2;
const SEARCH_RECALL_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RECALL_QUERY_COUNT = 8;

const searchRecallCache = new Map<string, RecallSearchCacheEntry<NcmTrackLike[]>>();

export type QueryRecallState = QueryFunnelState & {
  searchedQueryLimits: Map<string, number>;
  retrievalRunId?: string;
  retrievalRequestKind?: RetrievalRequestKind;
};

export type QueryRecallRunOptions = {
  queries: string[];
  source: CandidateSource;
  evidencePrefix: string;
  scores: MusicCandidateScores;
  userId: string;
  ncmClient: EntityRecallNcmClient;
  candidatePool: CandidatePool;
  context: MusicAgentContextSummary;
  queryPlan: QueryPlan | null;
  queryState: QueryRecallState;
  embeddingClient?: MusicAgentEmbeddingClient | null;
  embeddingModel?: string | null;
  consumeNcmSearch: () => boolean;
  consumePlaylistFetch: () => boolean;
  signal?: AbortSignal;
  limit?: number;
  runId?: string;
  requestKind?: RetrievalRequestKind;
  now?: Date;
  sourceReservoirEnabled?: boolean;
};

export type QueryRecallRunResult = {
  summary: string;
  problems: string[];
  fetchedSourceCount: number;
  aborted?: boolean;
};

export async function runRecallFromQueries(options: QueryRecallRunOptions): Promise<QueryRecallRunResult> {
  const {
    sanitizedQueries,
    exactTrackQueries,
    skippedSemanticQueries
  } = prepareRecallQueryEligibility(options.queries);
  const runId = options.runId ?? options.queryState.retrievalRunId ?? randomUUID();
  const requestKind = options.requestKind
    ?? options.queryState.retrievalRequestKind
    ?? (options.context.request === 'auto-fill' ? 'autonomous' : 'explicit_request');
  options.queryState.retrievalRunId = runId;
  options.queryState.retrievalRequestKind = requestKind;
  options.queryState.retrievalAttemptedAt ??= options.now ?? new Date();
  const preparedQueries = prepareRetrievalQueries({
    userId: options.userId,
    runId,
    requestKind,
    queries: exactTrackQueries,
    source: options.source,
    maxQueries: MAX_RECALL_QUERY_COUNT,
    now: options.now,
  });
  const queries = preparedQueries.queries;
  const funnelSeeds = new Map(
    preparedQueries.funnelEntries.map((entry) => [entry.normalizedQuery, entry])
  );
  if (queries.length === 0) {
    const noQueryReason = formatNoExecutableQueryReason({
      inputQueryCount: options.queries.length,
      sanitizedQueryCount: sanitizedQueries.length,
      skippedSemanticQueries
    });
    if (skippedSemanticQueries > 0) {
      const semanticRecall = await recallFromSemanticEntities({
        semanticQueries: sanitizedQueries,
        userId: options.userId,
        ncmClient: options.ncmClient,
        candidatePool: options.candidatePool,
        context: options.context,
        queryPlan: options.queryPlan,
        embeddingClient: options.embeddingClient,
        embeddingModel: options.embeddingModel,
        consumeNcmSearch: options.consumeNcmSearch,
        consumePlaylistFetch: options.consumePlaylistFetch,
        ...(options.sourceReservoirEnabled ? { sourceReservoir: {
          userId: options.userId,
          runId,
          requestKind,
          ...(options.now ? { now: options.now } : {})
        } } : {}),
        signal: options.signal,
        limit: options.limit ?? DEFAULT_ENTITY_RECALL_LIMIT
      });
      if (semanticRecall.attempted) {
        return {
          summary: `${options.evidencePrefix} semantic entity recall added ${semanticRecall.added} candidates from ${semanticRecall.matchCount} matches.`,
          problems: [
            SEMANTIC_ONLY_QUERY_PROBLEM,
            ...semanticRecall.problems
          ],
          fetchedSourceCount: semanticRecall.fetchedSourceCount ?? 0
        };
      }
    }
    return {
      summary: `${options.evidencePrefix} recall skipped: no queries (${noQueryReason}).`,
      problems: [
        preparedQueries.status === 'alternative_query_required'
          ? 'alternative_query_required'
          : 'no search queries available',
        ...(skippedSemanticQueries > 0 ? [SEMANTIC_ONLY_QUERY_PROBLEM] : [])
      ],
      fetchedSourceCount: 0
    };
  }

  let added = 0;
  let skippedRepeatedQueries = 0;
  let skippedReservoirSources = 0;
  let fetchedSourceCount = 0;
  const searched: string[] = [];
  const artistFallbacks: string[] = [];
  let artistFallbackAdded = 0;
  const problems: string[] = [];
  const admissionTotals = emptyUpsertTracksResult();
  const attemptedArtistFallbacks = new Set<string>();
  let attemptedArtistFallbackCount = 0;

  for (const query of queries) {
    if (options.signal?.aborted) {
      return { summary: 'aborted', problems: ['aborted'], fetchedSourceCount, aborted: true };
    }
    try {
      const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
      const runSearchKey = searchRunKey(options.source, query, limit);
      const coveredLimit = options.queryState.searchedQueryLimits.get(runSearchKey) ?? 0;
      if (coveredLimit >= limit) {
        skippedRepeatedQueries += 1;
        continue;
      }
      const reservoirIdentity = buildSourceReservoirIdentity({
        sourceKind: reservoirSourceKind(options.source),
        sourceRef: normalizeSearchQuery(query)
      });
      if (options.sourceReservoirEnabled && !isSourceReservoirFetchAvailable({
        userId: options.userId,
        identity: reservoirIdentity,
        requestKind,
        now: options.now
      })) {
        skippedReservoirSources += 1;
        continue;
      }
      const cacheKey = recallSearchCacheKey(query, limit);
      let tracks = readRecallSearchCache(searchRecallCache, cacheKey);
      if (!tracks) {
        if (!options.consumeNcmSearch()) {
          problems.push('NCM search budget exhausted');
          break;
        }
        tracks = await options.ncmClient.searchSongs(query, limit);
        writeRecallSearchCache(searchRecallCache, cacheKey, tracks, SEARCH_RECALL_CACHE_TTL_MS);
      }
      options.queryState.searchedQueryLimits.set(runSearchKey, Math.max(coveredLimit, limit));
      searched.push(query);
      const rawTracks = tracks;
      const result = upsertTracks(options.candidatePool, tracks, options.source, {
        evidence: `${options.evidencePrefix}: ${query}`,
        scores: options.scores,
        provenanceKind: recallQueryProvenanceKind(options.source)
      });
      if (options.sourceReservoirEnabled) try {
        recordSourceReservoirFetch({
          userId: options.userId,
          runId,
          identity: reservoirIdentity,
          displayName: query,
          candidateSource: options.source,
          provenanceKind: recallQueryProvenanceKind(options.source),
          tracks: tracks.filter((track) => options.candidatePool.has(String(track.id ?? ''))),
          fetchedAt: options.now
        });
        fetchedSourceCount += 1;
      } catch (error) {
        problems.push(`${query}: source reservoir write failed: ${formatError(error)}`);
      }
      if (!options.sourceReservoirEnabled) fetchedSourceCount += 1;
      recordQueryFunnelSearch(options.queryState, {
        seed: funnelSeeds.get(normalizeSearchQuery(query)),
        query,
        source: options.source,
        tracks: rawTracks,
        admittedTracks: tracks,
        resultCount: rawTracks.length,
        addedCount: result.added,
        pool: options.candidatePool
      });
      added += result.added;
      mergeUpsertTracksResult(admissionTotals, result);
      const artistFallbackTracks = tracks.length > 0 ? tracks : rawTracks;
      if (
        result.added === 0 &&
        artistFallbackTracks.length > 0 &&
        attemptedArtistFallbackCount < MAX_ARTIST_FALLBACKS_PER_RECALL
      ) {
        const artist = artistFallbackNameFromQuery(query, artistFallbackTracks);
        const fallbackArtistKeys = artistKeys(artist);
        const alreadyAttempted = fallbackArtistKeys.some((artistKey) => attemptedArtistFallbacks.has(artistKey));
        if (artist && fallbackArtistKeys.length > 0 && !alreadyAttempted) {
          for (const artistKey of fallbackArtistKeys) {
            attemptedArtistFallbacks.add(artistKey);
          }
          attemptedArtistFallbackCount += 1;
          const fallback = await recallFromEntity({
            entity: { type: 'artist', name: artist },
            ncmClient: options.ncmClient,
            candidatePool: options.candidatePool,
            context: options.context,
            limit: Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, DEFAULT_ENTITY_RECALL_LIMIT),
            searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
            consumeNcmSearch: options.consumeNcmSearch,
            consumePlaylistFetch: options.consumePlaylistFetch,
            provenanceKind: recallQueryProvenanceKind(options.source),
            ...(options.sourceReservoirEnabled ? { sourceReservoir: {
              userId: options.userId,
              runId,
              requestKind,
              ...(options.now ? { now: options.now } : {})
            } } : {}),
            signal: options.signal
          });
          added += fallback.added;
          artistFallbackAdded += fallback.added;
          if (fallback.added > 0) artistFallbacks.push(artist);
          problems.push(...fallback.problems);
        }
      }
    } catch (error) {
      problems.push(`${query}: ${formatError(error)}`);
    }
  }
  if (skippedSemanticQueries > 0) problems.push(SEMANTIC_ONLY_QUERY_PROBLEM);
  if (skippedRepeatedQueries > 0) {
    problems.push(skippedRepeatedQueries === 1
      ? 'skipped 1 repeated search query in this run'
      : `skipped ${skippedRepeatedQueries} repeated search queries in this run`);
  }
  if (skippedReservoirSources > 0) {
    problems.push(skippedReservoirSources === 1
      ? 'skipped 1 source still inside the 120-minute reservoir window'
      : `skipped ${skippedReservoirSources} sources still inside the 120-minute reservoir window`);
  }
  const admissionSummary = summarizeCandidateAdmission(admissionTotals);
  if (admissionSummary) problems.push(admissionSummary);
  if (preparedQueries.funnelEntries.some((entry) => entry.scoreMultiplier !== 1 || entry.repeatPenalty > 0)) {
    problems.push('reweighted search queries with user query history');
  }

  return {
    summary: `${options.evidencePrefix} recall searched ${searched.length} queries and added ${added} candidates: ${searched.join('、') || 'none'}.` +
      (artistFallbacks.length > 0 ? ` artist fallback added ${artistFallbackAdded} candidates from ${artistFallbacks.join('、')}.` : ''),
    problems,
    fetchedSourceCount
  };
}

function reservoirSourceKind(source: CandidateSource): SourceReservoirSourceKind {
  if (source === 'trend') return 'trend';
  if (source === 'style_expansion') return 'style_expansion';
  if (source === 'playlist') return 'playlist';
  return 'search';
}

function recallQueryProvenanceKind(source: CandidateSource): CandidateProvenanceKind {
  if (source === 'trend') return 'trend_recall';
  if (source === 'style_expansion') return 'style_expansion';
  if (source === 'playlist') return 'playlist';
  if (source === 'liked') return 'liked';
  return 'exact_recall';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
