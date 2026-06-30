import type { CandidatePool } from './candidates.js';
import {
  countCandidateArtistKeys,
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
  prepareSearchQueriesForRecall
} from './query-stats.js';
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
import {
  getCachedLikedIds,
  getCachedLikedProfile,
  type LikedRecallProfile,
  type NcmTrackLike
} from './liked-recall.js';
import { artistKeys } from './artists.js';

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_ENTITY_RECALL_LIMIT = 5;
const DEFAULT_ENTITY_SEARCH_LIMIT = 3;
const MAX_ARTIST_FALLBACKS_PER_RECALL = 2;
const SEARCH_RECALL_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RECALL_QUERY_COUNT = 8;
const EXPLORE_LIKED_ARTIST_SEARCH_PENALTY = 0.04;
const EXPLORE_LIKED_SEARCH_GUARD_SOURCES = new Set<CandidateSource>(['search', 'style_expansion', 'trend']);

const searchRecallCache = new Map<string, RecallSearchCacheEntry<NcmTrackLike[]>>();

export type QueryRecallState = QueryFunnelState & {
  searchedQueryLimits: Map<string, number>;
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
  avoidArtists: ReadonlySet<string>;
  consumeNcmSearch: () => boolean;
  consumePlaylistFetch: () => boolean;
  signal?: AbortSignal;
  limit?: number;
};

export type QueryRecallRunResult = {
  summary: string;
  problems: string[];
  aborted?: boolean;
};

export async function runRecallFromQueries(options: QueryRecallRunOptions): Promise<QueryRecallRunResult> {
  const {
    sanitizedQueries,
    artistFilteredQueries,
    exactTrackQueries,
    skippedAvoidedQueries,
    skippedSemanticQueries
  } = prepareRecallQueryEligibility(options.queries, options.avoidArtists);
  const preparedQueries = prepareSearchQueriesForRecall({
    userId: options.userId,
    queries: exactTrackQueries,
    source: options.source,
    maxQueries: MAX_RECALL_QUERY_COUNT
  });
  const queries = preparedQueries.queries;
  const funnelSeeds = new Map(
    preparedQueries.funnelEntries.map((entry) => [entry.normalizedQuery, entry])
  );
  if (queries.length === 0) {
    const noQueryReason = formatNoExecutableQueryReason({
      inputQueryCount: options.queries.length,
      sanitizedQueryCount: sanitizedQueries.length,
      artistFilteredQueryCount: artistFilteredQueries.length,
      skippedAvoidedQueries,
      skippedSemanticQueries
    });
    if (skippedSemanticQueries > 0) {
      const semanticRecall = await recallFromSemanticEntities({
        semanticQueries: artistFilteredQueries.length > 0 ? artistFilteredQueries : sanitizedQueries,
        userId: options.userId,
        ncmClient: options.ncmClient,
        candidatePool: options.candidatePool,
        context: options.context,
        queryPlan: options.queryPlan,
        embeddingClient: options.embeddingClient,
        embeddingModel: options.embeddingModel,
        avoidArtists: options.avoidArtists,
        consumeNcmSearch: options.consumeNcmSearch,
        consumePlaylistFetch: options.consumePlaylistFetch,
        signal: options.signal,
        limit: options.limit ?? DEFAULT_ENTITY_RECALL_LIMIT
      });
      if (semanticRecall.attempted) {
        return {
          summary: `${options.evidencePrefix} semantic entity recall added ${semanticRecall.added} candidates from ${semanticRecall.matchCount} matches.`,
          problems: [
            SEMANTIC_ONLY_QUERY_PROBLEM,
            ...semanticRecall.problems,
            ...(skippedAvoidedQueries > 0 ? [`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`] : [])
          ]
        };
      }
    }
    return {
      summary: `${options.evidencePrefix} recall skipped: no queries (${noQueryReason}).`,
      problems: [
        'no search queries available',
        ...(skippedSemanticQueries > 0 ? [SEMANTIC_ONLY_QUERY_PROBLEM] : []),
        ...(skippedAvoidedQueries > 0 ? [`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`] : [])
      ]
    };
  }

  let added = 0;
  let skippedAvoidedArtists = 0;
  let skippedArtistCap = 0;
  let skippedRepeatedQueries = 0;
  let skippedLikedTracks = 0;
  let likedArtistPenalizedTracks = 0;
  const searched: string[] = [];
  const artistFallbacks: string[] = [];
  let artistFallbackAdded = 0;
  const problems: string[] = [];
  const admissionTotals = emptyUpsertTracksResult();
  const artistCounts = countCandidateArtistKeys(options.candidatePool.list());
  const attemptedArtistFallbacks = new Set<string>();
  let attemptedArtistFallbackCount = 0;
  let likedSearchGuard: ExploreLikedSearchGuard | null | undefined;

  for (const query of queries) {
    if (options.signal?.aborted) return { summary: 'aborted', problems: ['aborted'], aborted: true };
    try {
      const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
      const runSearchKey = searchRunKey(options.source, query, limit);
      const coveredLimit = options.queryState.searchedQueryLimits.get(runSearchKey) ?? 0;
      if (coveredLimit >= limit) {
        skippedRepeatedQueries += 1;
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
      if (rawTracks.length > 0 && likedSearchGuard === undefined) {
        likedSearchGuard = await loadExploreLikedSearchGuard(options);
        if (options.signal?.aborted) return { summary: 'aborted', problems: ['aborted'], aborted: true };
        if (likedSearchGuard) problems.push(...likedSearchGuard.problems);
      }
      const likedProfile = likedSearchGuard?.profile ?? null;
      const likedFilter = filterExploreLikedTracks(rawTracks, likedProfile);
      tracks = likedFilter.tracks;
      skippedLikedTracks += likedFilter.skipped;
      const likedArtistPenaltyCount = countLikedArtistMatches(tracks, likedProfile);
      const result = upsertTracks(options.candidatePool, tracks, options.source, {
        evidence: `${options.evidencePrefix}: ${query}`,
        scores: options.scores,
        scoreForTrack: likedProfile?.artistKeys.size
          ? (track) => scoreWithExploreLikedArtistPenalty(track, options.scores, likedProfile)
          : undefined,
        avoidArtists: options.avoidArtists,
        artistCounts,
        provenanceKind: recallQueryProvenanceKind(options.source)
      });
      likedArtistPenalizedTracks += likedArtistPenaltyCount;
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
      skippedAvoidedArtists += result.skippedAvoidedArtists;
      skippedArtistCap += result.skippedArtistCap;
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
        const avoided = fallbackArtistKeys.some((artistKey) => options.avoidArtists.has(artistKey));
        if (artist && fallbackArtistKeys.length > 0 && !alreadyAttempted && !avoided) {
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
            avoidArtists: options.avoidArtists,
            artistCounts,
            provenanceKind: recallQueryProvenanceKind(options.source),
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
  if (skippedAvoidedQueries > 0) problems.push(`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`);
  if (skippedSemanticQueries > 0) problems.push(SEMANTIC_ONLY_QUERY_PROBLEM);
  if (skippedLikedTracks > 0) problems.push(`skipped ${skippedLikedTracks} liked tracks from discovery search results`);
  if (likedArtistPenalizedTracks > 0) problems.push(`applied weak liked-artist penalty to ${likedArtistPenalizedTracks} discovery search candidates`);
  if (skippedRepeatedQueries > 0) {
    problems.push(skippedRepeatedQueries === 1
      ? 'skipped 1 repeated search query in this run'
      : `skipped ${skippedRepeatedQueries} repeated search queries in this run`);
  }
  if (skippedAvoidedArtists > 0) problems.push(`skipped ${skippedAvoidedArtists} tracks from recently repeated artists`);
  if (skippedArtistCap > 0) problems.push(`skipped ${skippedArtistCap} tracks after per-artist recall cap`);
  const admissionSummary = summarizeCandidateAdmission(admissionTotals);
  if (admissionSummary) problems.push(admissionSummary);
  if (preparedQueries.funnelEntries.some((entry) => entry.scoreMultiplier !== 1 || entry.repeatPenalty > 0)) {
    problems.push('reweighted search queries with user query history');
  }

  return {
    summary: `${options.evidencePrefix} recall searched ${searched.length} queries and added ${added} candidates: ${searched.join('、') || 'none'}.` +
      (artistFallbacks.length > 0 ? ` artist fallback added ${artistFallbackAdded} candidates from ${artistFallbacks.join('、')}.` : ''),
    problems
  };
}

type ExploreLikedSearchGuard = {
  profile: LikedRecallProfile | null;
  problems: string[];
};

async function loadExploreLikedSearchGuard(options: QueryRecallRunOptions): Promise<ExploreLikedSearchGuard | null> {
  if (!shouldApplyExploreLikedSearchGuard(options)) return null;

  try {
    return {
      profile: await getCachedLikedProfile({
        userId: options.userId,
        ncmClient: options.ncmClient
      }),
      problems: []
    };
  } catch (error) {
    try {
      const ids = await getCachedLikedIds({
        userId: options.userId,
        ncmClient: options.ncmClient
      });
      return {
        profile: { ids: new Set(ids), artistKeys: new Set() },
        problems: [`liked artist profile unavailable: ${formatError(error)}`]
      };
    } catch (idError) {
      return {
        profile: null,
        problems: [`liked search dedupe unavailable: ${formatError(idError)}`]
      };
    }
  }
}

function shouldApplyExploreLikedSearchGuard(options: QueryRecallRunOptions): boolean {
  return options.context.discoveryMode === 'explore' && EXPLORE_LIKED_SEARCH_GUARD_SOURCES.has(options.source);
}

function filterExploreLikedTracks(
  tracks: NcmTrackLike[],
  profile: LikedRecallProfile | null
): { tracks: NcmTrackLike[]; skipped: number } {
  if (!profile || profile.ids.size === 0) {
    return { tracks, skipped: 0 };
  }

  const filtered = tracks.filter((track) => !profile.ids.has(normalizeTrackId(track)));
  return {
    tracks: filtered,
    skipped: tracks.length - filtered.length
  };
}

function countLikedArtistMatches(tracks: NcmTrackLike[], profile: LikedRecallProfile | null): number {
  if (!profile || profile.artistKeys.size === 0) return 0;
  return tracks.filter((track) => trackMatchesLikedArtist(track, profile)).length;
}

function scoreWithExploreLikedArtistPenalty(
  track: NcmTrackLike,
  baseScores: MusicCandidateScores,
  profile: LikedRecallProfile
): MusicCandidateScores {
  if (!trackMatchesLikedArtist(track, profile)) return baseScores;
  return {
    ...baseScores,
    recentPenalty: baseScores.recentPenalty + EXPLORE_LIKED_ARTIST_SEARCH_PENALTY
  };
}

function trackMatchesLikedArtist(track: NcmTrackLike, profile: LikedRecallProfile): boolean {
  return (track.artists ?? [])
    .flatMap(artistKeys)
    .some((artist) => profile.artistKeys.has(artist));
}

function normalizeTrackId(track: NcmTrackLike): string {
  return track.id === undefined || track.id === null ? '' : String(track.id).trim();
}

function recallQueryProvenanceKind(source: CandidateSource): CandidateProvenanceKind {
  if (source === 'trend') return 'trend_recall';
  if (source === 'style_expansion') return 'style_expansion';
  if (source === 'plan') return 'plan';
  if (source === 'playlist') return 'playlist';
  if (source === 'liked') return 'liked';
  return 'exact_recall';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
