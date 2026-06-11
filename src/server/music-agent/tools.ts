import type { NcmClient } from '../ncm/client.js';
import { getMusicKnowledgeSlice } from './knowledge.js';
import {
  diversifyCandidates,
  isHardFilteredCandidate,
  rankCandidates,
  resolveTitlePollution,
  scoreCandidateForRanking
} from './rank.js';
import { buildTrendContext, type TrendCapableNcmClient } from './trends.js';
import {
  queryPlanSchema,
  type AgentBudget,
  type CandidateSource,
  type MusicAgentContextSummary,
  type MusicCandidateQualitySignals,
  type MusicAgentToolName,
  type MusicCandidate,
  type MusicCandidateScores,
  type QueryPlan,
  type TrendContext
} from './schema.js';
import type { CandidatePool } from './candidates.js';

export type ToolObservation = {
  summary: string;
  candidateCount: number;
  problems?: string[];
};

export type MusicAgentTool = (
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<ToolObservation>;

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>> & {
  prepare_for_ranking?: MusicAgentTool;
};

type MusicAgentNcmClient = Pick<
  NcmClient,
  'getLikedSongIds' | 'getSongDetails' | 'searchSongs' | 'getPlaylistDetail'
> & Partial<TrendCapableNcmClient>;

export type CreateMusicAgentToolsInput = {
  userId: string;
  ncmClient: MusicAgentNcmClient;
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  budget: AgentBudget;
  maxTrendFetchMs?: number;
  maxNcmSearches?: number;
  maxPlaylistFetches?: number;
};

type NcmTrackLike = {
  id?: number | string | null;
  name?: string | null;
  artists?: string[] | null;
  qualitySignals?: MusicCandidateQualitySignals | null;
};

type ToolState = {
  queryPlan: QueryPlan | null;
  trendContext: TrendContext | null;
  ncmSearches: number;
  playlistFetches: number;
  qualityPreparedIds: Set<string>;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const SUMMARY_MAX_CHARS = 900;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_LIKED_RECALL_LIMIT = 60;
const AUTO_FILL_DEFAULT_LIKED_RECALL_LIMIT = 8;
const AUTO_FILL_MAX_LIKED_RECALL_LIMIT = 10;
const MAX_SEARCH_RECALL_LIMIT = 20;
const MAX_TREND_RECALL_LIMIT = 10;
const MAX_STYLE_EXPANSION_RECALL_LIMIT = 10;
const MAX_RANK_DISPLAY_LIMIT = 20;
const MAX_DIVERSIFY_DISPLAY_LIMIT = 5;
const AVOID_ARTIST_PENALTY_THRESHOLD = 0.18;
const MAX_QUERY_RECALL_PER_PRIMARY_ARTIST = 2;
const LIKED_RECALL_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_RECALL_CACHE_TTL_MS = 30 * 60 * 1000;
const QUALITY_DETAIL_BATCH_LIMIT = 80;
const QUALITY_SOURCES = new Set<CandidateSource>(['search', 'style_expansion', 'trend']);
const likedRecallCache = new Map<string, CacheEntry<NcmTrackLike[]>>();
const searchRecallCache = new Map<string, CacheEntry<NcmTrackLike[]>>();

export function createMusicAgentTools(input: CreateMusicAgentToolsInput): MusicAgentToolRegistry {
  const state: ToolState = {
    queryPlan: null,
    trendContext: null,
    ncmSearches: 0,
    playlistFetches: 0,
    qualityPreparedIds: new Set()
  };
  const limits = {
    maxNcmSearches: input.maxNcmSearches ?? input.budget.maxNcmSearches,
    maxPlaylistFetches: input.maxPlaylistFetches ?? input.budget.maxPlaylistFetches,
    maxTrendFetchMs: input.maxTrendFetchMs ?? input.budget.maxTrendFetchMs
  };

  const registry: MusicAgentToolRegistry = {
    prepare_for_ranking: async (_toolInput, signal) => prepareCandidateQuality(input, state, signal),

    get_context_summary: async (_toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      return observation(input.candidatePool, summarizeContext(input.context));
    },

    get_music_knowledge: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const text = [
        stringValue(toolInput.text),
        stringValue(toolInput.userText),
        input.context.currentUserText,
        input.context.activeDirective,
        input.context.currentPlanSegment ?? '',
        input.context.tasteSummary,
        input.context.recentPreferenceSummary
      ].filter(Boolean).join(' ');
      const slice = getMusicKnowledgeSlice({
        text,
        daypart: input.context.currentMoment.daypart
      });
      return observation(input.candidatePool, summarizeKnowledge(slice));
    },

    get_trend_context: async (_toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      if (!isTrendCapable(input.ncmClient)) {
        return observation(input.candidatePool, 'trend context unavailable: NCM client has no trend methods.', [
          'trend-capable NCM client is unavailable'
        ]);
      }
      try {
        state.trendContext = await buildTrendContext({
          ncmClient: input.ncmClient,
          locale: 'zh-CN',
          maxFetchMs: limits.maxTrendFetchMs
        });
        return observation(input.candidatePool, summarizeTrendContext(state.trendContext));
      } catch (error) {
        return observation(input.candidatePool, 'trend context failed.', [formatError(error)]);
      }
    },

    expand_queries: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const parsed = queryPlanSchema.safeParse(toolInput);
      state.queryPlan = withContextAvoidArtists(
        parsed.success ? parsed.data : defaultQueryPlan(input.context, toolInput),
        input.context
      );
      return observation(input.candidatePool, summarizeQueryPlan(state.queryPlan), parsed.success ? [] : [
        'invalid query plan input; using context-derived defaults'
      ]);
    },

    recall_from_liked: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = likedRecallLimit(toolInput.limit, input.context);
      try {
        const tracks = await getLikedRecallTracks(input, limit, signal);
        if (tracks === 'aborted') return abortedObservation(input.candidatePool);
        if (tracks.length === 0) {
          return observation(input.candidatePool, 'liked recall found no liked ids.');
        }
        const added = upsertTracks(input.candidatePool, tracks, 'liked', {
          evidence: '网易云红心歌曲',
          scores: sourceScores('liked', input.context)
        }).added;
        return observation(input.candidatePool, `liked recall added ${added} candidates from ${tracks.length} ids.`);
      } catch (error) {
        return observation(input.candidatePool, 'liked recall failed.', [formatError(error)]);
      }
    },

    recall_from_playlists: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const playlistIds = uniqueStrings([
        ...stringArrayValue(toolInput.playlistIds),
        ...stringArrayValue(toolInput.ids),
        stringValue(toolInput.playlistId)
      ]);
      if (playlistIds.length === 0) {
        return observation(input.candidatePool, 'playlist recall skipped: no playlist ids.', [
          'no playlist ids provided'
        ]);
      }

      let added = 0;
      const problems: string[] = [];
      for (const playlistId of playlistIds) {
        if (signal?.aborted) return abortedObservation(input.candidatePool);
        if (!consumePlaylistFetch(state, limits.maxPlaylistFetches)) {
          problems.push('playlist fetch budget exhausted');
          break;
        }
        try {
          const detail = await input.ncmClient.getPlaylistDetail(playlistId);
          if (!detail) {
            problems.push(`playlist ${playlistId} not found`);
            continue;
          }
          added += upsertTracks(input.candidatePool, detail.tracks, 'playlist', {
            evidence: `歌单 ${detail.name}`,
            scores: sourceScores('playlist', input.context)
          }).added;
        } catch (error) {
          problems.push(`playlist ${playlistId}: ${formatError(error)}`);
        }
      }

      return observation(input.candidatePool, `playlist recall added ${added} candidates.`, problems);
    },

    recall_from_plan_segment: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const queries = uniqueStrings([
        ...stringArrayValue(toolInput.queries),
        ...extractPlanQueries(input.context.currentPlanSegment)
      ]).slice(0, 6);
      return recallFromQueries({
        queries,
        source: 'plan',
        evidencePrefix: '计划段落',
        scores: sourceScores('plan', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal
      });
    },

    recall_from_ncm_search: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const queries = uniqueStrings([
        ...stringArrayValue(toolInput.queries),
        stringValue(toolInput.query),
        ...(input.context.actionQueries ?? []),
        ...(state.queryPlan
          ? [
              ...state.queryPlan.intentQueries,
              ...state.queryPlan.tasteAnchorQueries,
              ...state.queryPlan.planQueries,
              ...state.queryPlan.explorationQueries
            ]
          : [])
      ]).slice(0, 8);
      return recallFromQueries({
        queries,
        source: 'search',
        evidencePrefix: '网易云搜索',
        scores: sourceScores('search', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_RECALL_LIMIT)
      });
    },

    recall_from_trending: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      return recallFromQueries({
        queries: trendRecallQueries(state, toolInput),
        source: 'trend',
        evidencePrefix: '趋势线索',
        scores: sourceScores('trend', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, 5, MAX_TREND_RECALL_LIMIT)
      });
    },

    recall_from_style_expansion: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const queries = styleExpansionQueries(input.context, toolInput);
      return recallFromQueries({
        queries,
        source: 'style_expansion',
        evidencePrefix: '风格扩展',
        scores: sourceScores('style_expansion', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, 5, MAX_STYLE_EXPANSION_RECALL_LIMIT)
      });
    },

    recall_auto_fill_mix: async (_toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      if (!state.queryPlan) {
        state.queryPlan = withContextAvoidArtists(defaultQueryPlan(input.context, {}), input.context);
      }

      const summaries: string[] = [];
      const problems: string[] = [];

      const search = await recallFromQueries({
        queries: autoFillSearchQueries(input.context, state.queryPlan),
        source: 'search',
        evidencePrefix: '网易云搜索',
        scores: sourceScores('search', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: DEFAULT_SEARCH_LIMIT
      });
      summaries.push(search.summary);
      problems.push(...(search.problems ?? []));
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool)) {
        return observation(input.candidatePool, `auto-fill mix: ${summaries.join(' | ')}`, problems);
      }

      const style = await recallFromQueries({
        queries: styleExpansionQueries(input.context, {}),
        source: 'style_expansion',
        evidencePrefix: '风格扩展',
        scores: sourceScores('style_expansion', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: 5
      });
      summaries.push(style.summary);
      problems.push(...(style.problems ?? []));
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool)) {
        return observation(input.candidatePool, `auto-fill mix: ${summaries.join(' | ')}`, problems);
      }

      const trend = await recallFromQueries({
        queries: trendRecallQueries(state, {}),
        source: 'trend',
        evidencePrefix: '趋势线索',
        scores: sourceScores('trend', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: 5
      });
      summaries.push(trend.summary);
      problems.push(...(trend.problems ?? []));

      return observation(input.candidatePool, `auto-fill mix: ${summaries.join(' | ')}`, problems);
    },

    rank_candidates: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const qualityObservation = await prepareCandidateQuality(input, state, signal);
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = boundedPositiveInt(toolInput.limit, 8, MAX_RANK_DISPLAY_LIMIT);
      const options = rankOptions(input.context);
      const top = rankCandidates(input.candidatePool.list(), limit, options);
      return observation(input.candidatePool, summarizeCandidates('ranked candidates', top, options), qualityObservation.problems);
    },

    diversify_candidates: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const qualityObservation = await prepareCandidateQuality(input, state, signal);
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = boundedPositiveInt(toolInput.limit, 2, MAX_DIVERSIFY_DISPLAY_LIMIT);
      const options = rankOptions(input.context);
      const diversified = diversifyCandidates(rankCandidates(input.candidatePool.list(), 20, options), limit);
      return observation(input.candidatePool, summarizeCandidates('diversified candidates', diversified, options), qualityObservation.problems);
    },

    finalize_pick: async (_toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const qualityObservation = await prepareCandidateQuality(input, state, signal);
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const options = rankOptions(input.context);
      const top = rankCandidates(input.candidatePool.list(), 5, options);
      return observation(input.candidatePool, summarizeCandidates('finalize candidates', top, options), qualityObservation.problems);
    }
  };

  return registry;
}

async function getLikedRecallTracks(
  input: CreateMusicAgentToolsInput,
  limit: number,
  signal?: AbortSignal
): Promise<NcmTrackLike[] | 'aborted'> {
  const cacheKey = `${input.userId}:${limit}`;
  const cached = readCache(likedRecallCache, cacheKey);
  if (cached) return cached;

  const ids = (await input.ncmClient.getLikedSongIds()).slice(0, limit).map(String);
  if (signal?.aborted) return 'aborted';
  if (ids.length === 0) {
    writeCache(likedRecallCache, cacheKey, [], LIKED_RECALL_CACHE_TTL_MS);
    return [];
  }
  const tracks = await input.ncmClient.getSongDetails(ids);
  writeCache(likedRecallCache, cacheKey, tracks, LIKED_RECALL_CACHE_TTL_MS);
  return tracks;
}

async function prepareCandidateQuality(
  input: CreateMusicAgentToolsInput,
  state: ToolState,
  signal?: AbortSignal
): Promise<ToolObservation> {
  const candidates = input.candidatePool.list();
  const ids = candidates
    .filter(usesExternalQuality)
    .map((candidate) => candidate.id)
    .filter((id) => !state.qualityPreparedIds.has(id));

  const problems: string[] = [];
  let preparedCount = 0;
  for (let start = 0; start < ids.length; start += QUALITY_DETAIL_BATCH_LIMIT) {
    if (signal?.aborted) return abortedObservation(input.candidatePool);
    const batchIds = ids.slice(start, start + QUALITY_DETAIL_BATCH_LIMIT);
    try {
      const details = await input.ncmClient.getSongDetails(batchIds);
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      for (const detail of details) {
        const id = detail.id === undefined || detail.id === null ? '' : String(detail.id);
        input.candidatePool.mergeQualitySignals(id, detail.qualitySignals);
      }
      preparedCount += batchIds.length;
      for (const id of batchIds) state.qualityPreparedIds.add(id);
    } catch (error) {
      problems.push(`quality detail failed: ${formatError(error)}`);
    }
  }

  const filteredCount = input.candidatePool.list().filter(isHardFilteredCandidate).length;
  if (filteredCount > 0) {
    problems.push(`filtered ${filteredCount} low-quality external candidates`);
  }

  return observation(
    input.candidatePool,
    preparedCount > 0
      ? `quality signals prepared for ${preparedCount} external candidates.`
      : 'quality signals already prepared.',
    problems
  );
}

function autoFillSearchQueries(context: MusicAgentContextSummary, queryPlan: QueryPlan): string[] {
  return uniqueStrings([
    ...(context.actionQueries ?? []),
    ...queryPlan.intentQueries,
    ...queryPlan.tasteAnchorQueries,
    ...queryPlan.planQueries,
    ...queryPlan.explorationQueries
  ]).slice(0, 8);
}

function styleExpansionQueries(context: MusicAgentContextSummary, toolInput: Record<string, unknown>): string[] {
  const text = [
    stringValue(toolInput.text),
    context.currentUserText,
    context.activeDirective,
    context.tasteSummary,
    context.recentPreferenceSummary
  ].filter(Boolean).join(' ');
  const knowledge = getMusicKnowledgeSlice({
    text,
    daypart: context.currentMoment.daypart
  });
  return uniqueStrings([
    ...stringArrayValue(toolInput.queries),
    ...knowledge.queryTemplates,
    ...knowledge.styleAdjacency
  ]).slice(0, 8);
}

function trendRecallQueries(state: ToolState, toolInput: Record<string, unknown>): string[] {
  const trendContext = state.trendContext;
  const trendQueries = trendContext
    ? [
        ...trendContext.chartTrackHints.map((hint) => `${hint.title} ${hint.artist}`),
        ...trendContext.hotStyles,
        ...trendContext.hotArtists
      ]
    : state.queryPlan?.trendQueries ?? [];
  return uniqueStrings([...stringArrayValue(toolInput.queries), ...trendQueries]).slice(0, 8);
}

function hasEnoughAutoFillNonLikedCandidates(pool: CandidatePool): boolean {
  return pool.list().filter((candidate) => !candidate.sources.includes('liked')).length >= 8;
}

function likedRecallLimit(value: unknown, context: MusicAgentContextSummary): number {
  if (context.request !== 'auto-fill') {
    return boundedPositiveInt(value, 30, MAX_LIKED_RECALL_LIMIT);
  }
  return boundedPositiveInt(value, AUTO_FILL_DEFAULT_LIKED_RECALL_LIMIT, AUTO_FILL_MAX_LIKED_RECALL_LIMIT);
}

function rankOptions(context: MusicAgentContextSummary) {
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty]))
  };
}

function withContextAvoidArtists(plan: QueryPlan, context: MusicAgentContextSummary): QueryPlan {
  const avoidArtists = uniqueStrings([
    ...plan.avoidArtists,
    ...avoidArtistsFromContext(context)
  ]);
  return queryPlanSchema.parse({
    ...plan,
    avoidArtists,
    negativeTerms: uniqueStrings([...plan.negativeTerms, ...avoidArtists.map((artist) => `artist:${artist}`)])
  });
}

function avoidArtistsFromContext(context: MusicAgentContextSummary): string[] {
  return (context.recentArtistPenalties ?? [])
    .filter((item) => item.penalty >= AVOID_ARTIST_PENALTY_THRESHOLD)
    .map((item) => item.artist);
}

async function recallFromQueries(options: {
  queries: string[];
  source: CandidateSource;
  evidencePrefix: string;
  scores: MusicCandidateScores;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  signal?: AbortSignal;
  limit?: number;
}): Promise<ToolObservation> {
  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(options.input.context),
      ...(options.state.queryPlan?.avoidArtists ?? [])
    ].map(primaryArtist).filter(Boolean)
  );
  const { queries, skipped: skippedAvoidedQueries } = filterAvoidedQueries(uniqueStrings(options.queries).filter(Boolean), avoidArtists);
  if (queries.length === 0) {
    return observation(options.input.candidatePool, `${options.evidencePrefix} recall skipped: no queries.`, [
      'no search queries available',
      ...(skippedAvoidedQueries > 0 ? [`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`] : [])
    ]);
  }

  let added = 0;
  let skippedAvoidedArtists = 0;
  let skippedArtistCap = 0;
  const searched: string[] = [];
  const problems: string[] = [];
  const artistCounts = countPrimaryArtists(options.input.candidatePool.list());

  for (const query of queries) {
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    try {
      const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
      const cacheKey = searchCacheKey(query, limit);
      let tracks = readCache(searchRecallCache, cacheKey);
      if (!tracks) {
        if (!consumeNcmSearch(options.state, options.maxSearches)) {
          problems.push('NCM search budget exhausted');
          break;
        }
        tracks = await options.input.ncmClient.searchSongs(query, limit);
        writeCache(searchRecallCache, cacheKey, tracks, SEARCH_RECALL_CACHE_TTL_MS);
      }
      searched.push(query);
      const result = upsertTracks(options.input.candidatePool, tracks, options.source, {
        evidence: `${options.evidencePrefix}: ${query}`,
        scores: options.scores,
        avoidArtists,
        artistCounts
      });
      added += result.added;
      skippedAvoidedArtists += result.skippedAvoidedArtists;
      skippedArtistCap += result.skippedArtistCap;
    } catch (error) {
      problems.push(`${query}: ${formatError(error)}`);
    }
  }
  if (skippedAvoidedQueries > 0) problems.push(`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`);
  if (skippedAvoidedArtists > 0) problems.push(`skipped ${skippedAvoidedArtists} tracks from recently repeated artists`);
  if (skippedArtistCap > 0) problems.push(`skipped ${skippedArtistCap} tracks after per-artist recall cap`);

  return observation(
    options.input.candidatePool,
    `${options.evidencePrefix} recall searched ${searched.length} queries and added ${added} candidates: ${searched.join('、') || 'none'}.`,
    problems
  );
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function searchCacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}::${limit}`;
}

function upsertTracks(
  pool: CandidatePool,
  tracks: NcmTrackLike[],
  source: CandidateSource,
  options: {
    evidence: string;
    scores: MusicCandidateScores;
    avoidArtists?: ReadonlySet<string>;
    artistCounts?: Map<string, number>;
  }
): { added: number; skippedAvoidedArtists: number; skippedArtistCap: number } {
  let added = 0;
  let skippedAvoidedArtists = 0;
  let skippedArtistCap = 0;
  const artistCounts = options.artistCounts ?? new Map<string, number>();
  for (const track of tracks) {
    const candidate = candidateFromTrack(track, source, options);
    if (!candidate) continue;
    const artist = primaryArtist(candidate.artist);
    if (artist && options.avoidArtists?.has(artist)) {
      skippedAvoidedArtists += 1;
      continue;
    }
    if (artist && (artistCounts.get(artist) ?? 0) >= MAX_QUERY_RECALL_PER_PRIMARY_ARTIST) {
      skippedArtistCap += 1;
      continue;
    }
    const before = pool.count();
    pool.upsert(candidate);
    if (pool.count() > before || pool.has(candidate.id)) {
      added += 1;
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    }
  }
  return { added, skippedAvoidedArtists, skippedArtistCap };
}

function candidateFromTrack(
  track: NcmTrackLike,
  source: CandidateSource,
  options: { evidence: string; scores: MusicCandidateScores }
): MusicCandidate | null {
  const id = track.id === undefined || track.id === null ? '' : String(track.id).trim();
  const name = track.name?.trim() ?? '';
  const artist = (track.artists ?? []).map((item) => item.trim()).filter(Boolean).join(' / ');
  if (!id || !name || !artist) return null;

  return {
    id,
    name,
    artist,
    sources: [source],
    evidence: [options.evidence],
    scores: { ...options.scores },
    ...qualitySignalsProperty(track.qualitySignals ?? undefined)
  };
}

function usesExternalQuality(candidate: MusicCandidate): boolean {
  return candidate.sources.every((source) => QUALITY_SOURCES.has(source));
}

function qualitySignalsProperty(
  qualitySignals: MusicCandidateQualitySignals | undefined
): { qualitySignals?: MusicCandidateQualitySignals } {
  return qualitySignals ? { qualitySignals: { ...qualitySignals } } : {};
}

function sourceScores(source: CandidateSource, context: MusicAgentContextSummary): MusicCandidateScores {
  const mode = context.discoveryMode;
  const base: MusicCandidateScores = {
    intentMatch: 0.62,
    tasteMatch: 0.58,
    timeFit: 0.55,
    planFit: 0.35,
    novelty: 0.45,
    recentPenalty: 0,
    skipPenalty: 0,
    sourceConfidence: 0.58
  };

  if (source === 'liked') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.7, tasteMatch: 0.94, sourceConfidence: 0.88, novelty: 0.35 }
      : { ...base, intentMatch: 0.62, tasteMatch: 0.72, sourceConfidence: 0.68, novelty: 0.32 };
  }
  if (source === 'playlist') {
    return mode === 'comfort'
      ? { ...base, tasteMatch: 0.8, sourceConfidence: 0.78 }
      : { ...base, tasteMatch: 0.66, sourceConfidence: 0.62, novelty: 0.48 };
  }
  if (source === 'plan') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.76, planFit: 0.86, sourceConfidence: 0.72 }
      : { ...base, intentMatch: 0.72, planFit: 0.76, sourceConfidence: 0.62, novelty: 0.5 };
  }
  if (source === 'trend') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.54, tasteMatch: 0.46, novelty: 0.62, sourceConfidence: 0.58 }
      : { ...base, intentMatch: 0.66, tasteMatch: 0.52, novelty: 0.82, sourceConfidence: 0.7 };
  }
  if (source === 'style_expansion') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.66, tasteMatch: 0.62, novelty: 0.58, sourceConfidence: 0.58 }
      : { ...base, intentMatch: 0.78, tasteMatch: 0.62, novelty: 0.8, sourceConfidence: 0.72 };
  }
  return mode === 'comfort'
    ? base
    : { ...base, intentMatch: 0.76, tasteMatch: 0.64, novelty: 0.78, sourceConfidence: 0.72 };
}

function observation(pool: CandidatePool, summary: string, problems: string[] = []): ToolObservation {
  return {
    summary: truncate(summary, SUMMARY_MAX_CHARS),
    candidateCount: pool.count(),
    ...(problems.length > 0 ? { problems: problems.map((problem) => truncate(problem, 240)) } : {})
  };
}

function abortedObservation(pool: CandidatePool): ToolObservation {
  return observation(pool, 'tool aborted before making external calls.', ['aborted']);
}

function summarizeContext(context: MusicAgentContextSummary): string {
  return truncate([
    `request=${context.request}`,
    context.currentUserText ? `currentUserText=${context.currentUserText}` : '',
    `moment=${context.currentMoment.localTime} ${context.currentMoment.daypart}`,
    context.currentMoment.weather ? `weather=${context.currentMoment.weather}` : '',
    context.currentMoment.dailyTheme ? `theme=${context.currentMoment.dailyTheme}` : '',
    context.activeDirective ? `directive=${context.activeDirective}` : '',
    context.currentPlanSegment ? `plan=${context.currentPlanSegment}` : '',
    context.tasteSummary ? `taste=${context.tasteSummary}` : '',
    context.recentPreferenceSummary ? `recentPreference=${context.recentPreferenceSummary}` : '',
    context.recentPlaySignals ? `recentPlays=${context.recentPlaySignals}` : '',
    context.queueStateSummary ? `queue=${context.queueStateSummary}` : '',
    context.bannedSummary ? `banned=${context.bannedSummary}` : ''
  ].filter(Boolean).join('; '), SUMMARY_MAX_CHARS);
}

function summarizeKnowledge(slice: ReturnType<typeof getMusicKnowledgeSlice>): string {
  return truncate([
    slice.styleAdjacency.length ? `styleAdjacency=${slice.styleAdjacency.join('、')}` : '',
    slice.sceneRules.length ? `sceneRules=${slice.sceneRules.join('；')}` : '',
    slice.queryTemplates.length ? `queryTemplates=${slice.queryTemplates.join('、')}` : '',
    slice.diversityRules.length ? `diversityRules=${slice.diversityRules.join('；')}` : '',
    slice.negativeMappings.length ? `negativeMappings=${slice.negativeMappings.join('；')}` : ''
  ].filter(Boolean).join('; ') || 'no focused music knowledge matched.', SUMMARY_MAX_CHARS);
}

function summarizeTrendContext(context: TrendContext): string {
  return truncate([
    `trend confidence=${context.confidence}`,
    context.sources.length ? `sources=${context.sources.join(',')}` : '',
    context.hotArtists.length ? `hotArtists=${context.hotArtists.slice(0, 8).join('、')}` : '',
    context.hotStyles.length ? `hotStyles=${context.hotStyles.slice(0, 8).join('、')}` : '',
    context.chartTrackHints.length
      ? `tracks=${context.chartTrackHints.slice(0, 8).map((hint) => `${hint.title}-${hint.artist}`).join('、')}`
      : ''
  ].filter(Boolean).join('; ') || 'trend context is empty.', SUMMARY_MAX_CHARS);
}

function summarizeQueryPlan(plan: QueryPlan): string {
  return truncate([
    plan.intentQueries.length ? `intent=${plan.intentQueries.join('、')}` : '',
    plan.tasteAnchorQueries.length ? `taste=${plan.tasteAnchorQueries.join('、')}` : '',
    plan.planQueries.length ? `plan=${plan.planQueries.join('、')}` : '',
    plan.trendQueries.length ? `trend=${plan.trendQueries.join('、')}` : '',
    plan.explorationQueries.length ? `explore=${plan.explorationQueries.join('、')}` : '',
    plan.avoidArtists.length ? `avoidArtists=${plan.avoidArtists.join('、')}` : '',
    plan.negativeTerms.length ? `negative=${plan.negativeTerms.join('、')}` : '',
    plan.rationale ? `rationale=${plan.rationale}` : ''
  ].filter(Boolean).join('; ') || 'query plan is empty.', SUMMARY_MAX_CHARS);
}

function summarizeCandidates(
  label: string,
  candidates: MusicCandidate[],
  options: ReturnType<typeof rankOptions> = { artistPenalties: new Map() }
): string {
  if (candidates.length === 0) return `${label}: candidate pool is empty.`;
  return truncate(
    `${label}: ${candidates.map((candidate) => {
      const breakdown = scoreCandidateForRanking(candidate, options);
      return [
        `${candidate.id}:${candidate.name}-${candidate.artist}`,
        `score=${breakdown.baseScore.toFixed(3)}`,
        breakdown.artistPenalty > 0 ? `artistPenalty=${breakdown.artistPenalty.toFixed(3)}` : '',
        breakdown.qualityPenalty > 0 ? `qualityPenalty=${breakdown.qualityPenalty.toFixed(3)}` : '',
        breakdown.titlePollutionPenalty > 0 ? `titlePollution=${resolveTitlePollution(candidate)}` : '',
        `adjusted=${breakdown.adjustedScore.toFixed(3)}`
      ].filter(Boolean).join(' ');
    }).join(' | ')}`,
    SUMMARY_MAX_CHARS
  );
}

function defaultQueryPlan(
  context: MusicAgentContextSummary,
  input: Record<string, unknown>
): QueryPlan {
  const baseText = [
    stringValue(input.text),
    stringValue(input.userText),
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective,
    context.currentPlanSegment ?? '',
    context.tasteSummary,
    context.recentPreferenceSummary,
    context.currentMoment.daypart
  ].filter(Boolean).join(' ');
  const knowledge = getMusicKnowledgeSlice({
    text: baseText,
    daypart: context.currentMoment.daypart
  });

  return queryPlanSchema.parse({
    intentQueries: uniqueStrings([
      ...stringArrayValue(input.queries),
      stringValue(input.query),
      ...(context.actionQueries ?? []),
      ...knowledge.queryTemplates.slice(0, 4)
    ]),
    tasteAnchorQueries: uniqueStrings(knowledge.styleAdjacency.slice(0, 4)),
    planQueries: extractPlanQueries(context.currentPlanSegment),
    trendQueries: [],
    explorationQueries: uniqueStrings(knowledge.styleAdjacency.slice(0, 3)),
    avoidArtists: avoidArtistsFromContext(context),
    negativeTerms: knowledge.negativeMappings,
    rationale: 'context-derived fallback query plan'
  });
}

function countPrimaryArtists(candidates: MusicCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const artist = primaryArtist(candidate.artist);
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return counts;
}

function filterAvoidedQueries(queries: string[], avoidArtists: ReadonlySet<string>): { queries: string[]; skipped: number } {
  if (avoidArtists.size === 0) return { queries, skipped: 0 };
  const kept: string[] = [];
  let skipped = 0;
  for (const query of queries) {
    const normalized = query.toLowerCase();
    if ([...avoidArtists].some((artist) => artist && normalized.includes(artist))) {
      skipped += 1;
      continue;
    }
    kept.push(query);
  }
  return { queries: kept, skipped };
}

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase();
}

function extractPlanQueries(planSegment: string | null): string[] {
  if (!planSegment) return [];
  const tracks = planSegment.match(/tracks=([^；;]+)/)?.[1];
  if (!tracks) return [];
  return tracks.split(/[、,，/]+/).map((item) => item.trim()).filter(Boolean);
}

function consumeNcmSearch(state: ToolState, maxSearches: number): boolean {
  if (state.ncmSearches >= maxSearches) return false;
  state.ncmSearches += 1;
  return true;
}

function consumePlaylistFetch(state: ToolState, maxPlaylistFetches: number): boolean {
  if (state.playlistFetches >= maxPlaylistFetches) return false;
  state.playlistFetches += 1;
  return true;
}

function isTrendCapable(client: MusicAgentNcmClient): client is MusicAgentNcmClient & TrendCapableNcmClient {
  return (
    typeof client.getSearchHotDetail === 'function' &&
    typeof client.getTopSongHints === 'function' &&
    typeof client.getArtistToplist === 'function'
  );
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveInt(value, fallback), max);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...<truncated>`;
}
