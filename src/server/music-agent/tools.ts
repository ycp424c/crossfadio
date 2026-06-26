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
  webMusicDiscoveryInputSchema,
  type AgentBudget,
  type CandidateSource,
  type MusicAgentContextSummary,
  type MusicAgentToolName,
  type MusicCandidate,
  type MusicCandidateScores,
  type QueryFunnelEntry,
  type QueryPlan,
  type TrendContext,
  type WebMusicDiscoveryInput
} from './schema.js';
import type { CandidatePool } from './candidates.js';
import {
  candidateFromTrack,
  emptyUpsertTracksResult,
  mergeUpsertTracksResult,
  sourceScores,
  summarizeCandidateAdmission,
  usesExternalQuality,
  type UpsertTracksResult
} from './candidate-admission.js';
import {
  normalizeSearchQuery,
  prepareSearchQueriesForRecall,
  recordUserQueryFunnel,
  sanitizeSearchQuery
} from './query-stats.js';
import {
  filterExactSongSearchQueries,
  formatNoExecutableQueryReason,
  prepareRecallQueryEligibility,
  SEMANTIC_ONLY_QUERY_PROBLEM
} from './recall-query-filtering.js';
import {
  filterWebDiscoveryHintsForRecall as filterWebDiscoveryHintsByPolicy,
  parseMusicEntityHints
} from './web-discovery-hints.js';
import {
  autoFillWebDiscoveryInput,
  DEFAULT_WEB_DISCOVERY_HINT_LIMIT,
  isExplicitWebExploreIntent,
  parseWebMusicDiscoveryInput,
  selectWebDiscoveryStyle,
  WEB_DISCOVERY_MAX_HINT_LIMIT
} from './web-discovery-planning.js';
import {
  autoFillSearchQueries,
  styleExpansionQueries,
  styleSeedQueryModifiers
} from './query-planning.js';
import {
  getLikedRecallTracks,
  type NcmTrackLike
} from './liked-recall.js';
import {
  queryFunnelSnapshot,
  recordFinalQueryFunnel,
  recordQueryFunnelSearch,
  recordQueryFunnelSnapshot,
  searchRunKey,
  type QueryFunnelAccumulator
} from './query-funnel.js';
import type { FinalPick } from './schema.js';
import {
  albumMatchesEntity,
  albumMatchesKnownEntityFields,
  entityArtistName,
  entityFromStoredRecord,
  entityId,
  entityLabel,
  entityTitle,
  findVerifiedAlbum,
  isVerifiedTrackEntity,
  parseEntityRecallInput,
  tokenMatches,
  trackMatchesArtist,
  trackMatchesKnownEntityFields,
  type MusicEntityHypothesis
} from './entity-hypotheses.js';
import {
  findSimilarMusicEntities
} from '../store/music-entities.js';
import type { WebMusicDiscoveryProvider } from './web-discovery.js';
import { artistKeys } from './artists.js';

export type ToolObservation = {
  summary: string;
  candidateCount: number;
  problems?: string[];
  data?: Record<string, unknown>;
};

export type MusicAgentTool = (
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<ToolObservation>;

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>> & {
  prepare_for_ranking?: MusicAgentTool;
  getQueryFunnel?: () => QueryFunnelEntry[];
  recordQueryFunnel?: () => void;
  recordFinalPicks?: (picks: FinalPick[]) => void;
};

export type MusicAgentEmbeddingClient = {
  embed: (
    input: string | string[],
    opts?: { signal?: AbortSignal }
  ) => Promise<{ vectors: Float32Array[]; model: string; dimensions: number }>;
};

type EntityCapableNcmClient = Pick<
  NcmClient,
  'searchArtists'
  | 'getArtistTopSongs'
  | 'searchAlbums'
  | 'getArtistAlbums'
  | 'getAlbumDetail'
  | 'searchPlaylists'
>;

type MusicAgentNcmClient = Pick<
  NcmClient,
  'getLikedSongIds' | 'getSongDetails' | 'searchSongs' | 'getPlaylistDetail'
> & Partial<TrendCapableNcmClient> & Partial<EntityCapableNcmClient>;

export type CreateMusicAgentToolsInput = {
  userId: string;
  ncmClient: MusicAgentNcmClient;
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  budget: AgentBudget;
  maxTrendFetchMs?: number;
  maxNcmSearches?: number;
  maxPlaylistFetches?: number;
  targetPickCount?: number;
  embeddingClient?: MusicAgentEmbeddingClient | null;
  embeddingModel?: string | null;
  webMusicDiscoveryProvider?: WebMusicDiscoveryProvider | null;
  maxWebDiscoveryMs?: number;
  maxWebDiscoveryHints?: number;
};

type ToolState = {
  queryPlan: QueryPlan | null;
  trendContext: TrendContext | null;
  ncmSearches: number;
  playlistFetches: number;
  qualityPreparedIds: Set<string>;
  queryFunnel: Map<string, QueryFunnelAccumulator>;
  searchedQueryLimits: Map<string, number>;
  webDiscoveryCalled: boolean;
};

type AutoFillMixStage = {
  stage: 'search' | 'style_expansion' | 'trend' | 'web_discovery' | 'web_hint_recall';
  summary: string;
  candidateCount: number;
  problems: string[];
  data?: Record<string, unknown>;
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
const AUTO_FILL_LIKED_RECALL_SCAN_MULTIPLIER = 3;
const MAX_SEARCH_RECALL_LIMIT = 20;
const MAX_TREND_RECALL_LIMIT = 10;
const MAX_STYLE_EXPANSION_RECALL_LIMIT = 10;
const DEFAULT_ENTITY_RECALL_LIMIT = 5;
const DEFAULT_ENTITY_SEARCH_LIMIT = 3;
const DEFAULT_SEMANTIC_ENTITY_LIMIT = 8;
const MAX_ENTITY_RECALL_LIMIT = 10;
const MAX_ENTITY_RECALL_COUNT = 8;
const MAX_RANK_DISPLAY_LIMIT = 20;
const MAX_DIVERSIFY_DISPLAY_LIMIT = 5;
const AVOID_ARTIST_PENALTY_THRESHOLD = 0.18;
const MAX_QUERY_RECALL_PER_ARTIST_KEY = 2;
const MAX_ARTIST_FALLBACKS_PER_RECALL = 2;
const SEARCH_RECALL_CACHE_TTL_MS = 30 * 60 * 1000;
const QUALITY_DETAIL_BATCH_LIMIT = 80;
const MAX_RECALL_QUERY_COUNT = 8;
const AUTO_FILL_MIN_RECALL_NON_LIKED_TARGET = 8;
const DEFAULT_WEB_DISCOVERY_TIMEOUT_MS = 6_000;
const WEB_DISCOVERY_ENTITY_RECALL_LIMIT = 1;
const searchRecallCache = new Map<string, CacheEntry<NcmTrackLike[]>>();
export function createMusicAgentTools(input: CreateMusicAgentToolsInput): MusicAgentToolRegistry {
  const state: ToolState = {
    queryPlan: null,
    trendContext: null,
    ncmSearches: 0,
    playlistFetches: 0,
    qualityPreparedIds: new Set(),
    queryFunnel: new Map(),
    searchedQueryLimits: new Map(),
    webDiscoveryCalled: false
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
      const emptyParsedPlan = parsed.success && !hasQueryPlanRecallQueries(parsed.data);
      state.queryPlan = sanitizeQueryPlan(withContextAvoidArtists(
        parsed.success
          ? (emptyParsedPlan
              ? mergeQueryPlans(defaultQueryPlan(input.context, toolInput), parsed.data)
              : parsed.data)
          : defaultQueryPlan(input.context, toolInput),
        input.context
      ));
      return observation(input.candidatePool, summarizeQueryPlan(state.queryPlan), [
        ...(parsed.success ? [] : ['invalid query plan input; using context-derived defaults']),
        ...(emptyParsedPlan ? ['empty query plan input; using context-derived defaults'] : [])
      ]);
    },

    recall_from_liked: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = likedRecallLimit(toolInput.limit, input.context);
      const scanLimit = likedRecallScanLimit(limit, input.context);
      try {
        const tracks = await getLikedRecallTracks(input, scanLimit, signal);
        if (tracks === 'aborted') return abortedObservation(input.candidatePool);
        if (tracks.length === 0) {
          return observation(input.candidatePool, 'liked recall found no liked ids.');
        }
        const avoidArtists = new Set(
          [
            ...avoidArtistsFromContext(input.context),
            ...(state.queryPlan?.avoidArtists ?? [])
          ].flatMap(artistKeys)
        );
        const artistCounts = countArtistKeys(input.candidatePool.list());
        const result = upsertTracks(input.candidatePool, tracks, 'liked', {
          evidence: '网易云红心歌曲',
          scores: sourceScores('liked', input.context),
          avoidArtists,
          artistCounts,
          maxAccepted: limit
        });
        return observation(
          input.candidatePool,
          `liked recall added ${result.added} candidates from ${tracks.length} ids.`,
          [
            ...(result.skippedAvoidedArtists > 0 ? [`skipped ${result.skippedAvoidedArtists} tracks from recently repeated artists`] : []),
            ...(result.skippedArtistCap > 0 ? [`skipped ${result.skippedArtistCap} tracks after per-artist recall cap`] : [])
          ]
        );
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
              ...state.queryPlan.exactTrackQueries,
              ...state.queryPlan.intentQueries,
              ...state.queryPlan.tasteAnchorQueries,
              ...state.queryPlan.planQueries,
              ...state.queryPlan.explorationQueries
            ]
          : [])
      ]);
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

    recall_from_entities: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const parsedInput = parseEntityRecallInput(toolInput);
      const entities = parsedInput.entities.slice(0, MAX_ENTITY_RECALL_COUNT);
      if (entities.length === 0) {
        return observation(input.candidatePool, 'entity recall skipped: no entities.', [
          'no music entities provided',
          ...parsedInput.problems
        ]);
      }

      const limit = boundedPositiveInt(toolInput.limit, DEFAULT_ENTITY_RECALL_LIMIT, MAX_ENTITY_RECALL_LIMIT);
      const searchLimit = Math.min(limit, DEFAULT_ENTITY_SEARCH_LIMIT);
      const avoidArtists = new Set(
        [
          ...avoidArtistsFromContext(input.context),
          ...(state.queryPlan?.avoidArtists ?? [])
        ].flatMap(artistKeys)
      );
      const artistCounts = countArtistKeys(input.candidatePool.list());
      const problems: string[] = [...parsedInput.problems];
      let added = 0;

      for (const entity of entities) {
        if (signal?.aborted) return abortedObservation(input.candidatePool);
        const result = await recallFromEntity({
          entity,
          input,
          state,
          limit,
          searchLimit,
          maxSearches: limits.maxNcmSearches,
          maxPlaylistFetches: limits.maxPlaylistFetches,
          avoidArtists,
          artistCounts,
          signal
        });
        added += result.added;
        problems.push(...result.problems);
      }

      return observation(
        input.candidatePool,
        `entity recall expanded ${entities.length} entities and added ${added} candidates.`,
        problems
      );
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
        state.queryPlan = sanitizeQueryPlan(withContextAvoidArtists(defaultQueryPlan(input.context, {}), input.context));
      }

      const summaries: string[] = [];
      const problems: string[] = [];
      const stages: AutoFillMixStage[] = [];
      const addStage = (stage: AutoFillMixStage['stage'], result: ToolObservation) => {
        summaries.push(result.summary);
        problems.push(...(result.problems ?? []));
        stages.push(autoFillMixStage(stage, result));
      };
      const finish = () => autoFillMixObservation(input, summaries, problems, stages);

      const searchQueries = autoFillSearchQueries(input.context, state.queryPlan);
      const search = await recallFromQueries({
        queries: searchQueries,
        source: 'search',
        evidencePrefix: '网易云搜索',
        scores: sourceScores('search', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: DEFAULT_SEARCH_LIMIT
      });
      addStage('search', search);
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool, input.targetPickCount)) {
        return finish();
      }

      const style = await recallFromQueries({
        queries: styleExpansionQueries(input.context, { excludeQueries: searchQueries }),
        source: 'style_expansion',
        evidencePrefix: '风格扩展',
        scores: sourceScores('style_expansion', input.context),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: 5
      });
      addStage('style_expansion', style);
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool, input.targetPickCount)) {
        return finish();
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
      addStage('trend', trend);
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool, input.targetPickCount)) {
        return finish();
      }

      const web = await webMusicDiscovery({
        toolInput: autoFillWebDiscoveryInput(input.context, state.queryPlan),
        input,
        state,
        signal
      });
      addStage('web_discovery', web);
      if (web.data?.hints) {
        const webRecall = await recallFromWebDiscoveryHints({
          hints: web.data.hints,
          input,
          state,
          maxSearches: limits.maxNcmSearches,
          maxPlaylistFetches: limits.maxPlaylistFetches,
          signal,
          limit: WEB_DISCOVERY_ENTITY_RECALL_LIMIT
        });
        summaries.push(webRecall.summary);
        problems.push(...webRecall.problems);
        stages.push({
          stage: 'web_hint_recall',
          summary: webRecall.summary,
          candidateCount: input.candidatePool.count(),
          problems: webRecall.problems,
          data: { hintCount: objectArrayValue(web.data.hints).length }
        });
      }

      return finish();
    },

    web_music_discovery: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      return webMusicDiscovery({
        toolInput,
        input,
        state,
        signal
      });
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

  return {
    ...registry,
    getQueryFunnel: () => queryFunnelSnapshot(state),
    recordQueryFunnel: () => recordQueryFunnelSnapshot(input.userId, state, recordUserQueryFunnel),
    recordFinalPicks: (picks) => recordFinalQueryFunnel(input.userId, state, picks, recordUserQueryFunnel)
  };
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

async function webMusicDiscovery(options: {
  toolInput: Record<string, unknown>;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  signal?: AbortSignal;
}): Promise<ToolObservation> {
  const discoveryInput = parseWebMusicDiscoveryInput(options.toolInput, options.input);
  const gate = evaluateWebMusicDiscoveryGate({
    discoveryInput,
    input: options.input,
    state: options.state
  });
  const baseData = {
    allowed: gate.allowed,
    signals: gate.signals,
    intentCluster: gate.intentCluster
  };

  if (!gate.allowed) {
    return observation(
      options.input.candidatePool,
      `web discovery skipped: ${gate.reason}.`,
      [`web discovery denied: ${gate.reason}`],
      baseData
    );
  }
  if (!options.input.webMusicDiscoveryProvider) {
    return observation(
      options.input.candidatePool,
      'web discovery unavailable: provider is not configured.',
      ['web discovery unavailable: provider is not configured'],
      baseData
    );
  }

  options.state.webDiscoveryCalled = true;
  const maxHints = boundedPositiveInt(
    options.toolInput.maxHints,
    options.input.maxWebDiscoveryHints ?? DEFAULT_WEB_DISCOVERY_HINT_LIMIT,
    Math.min(options.input.maxWebDiscoveryHints ?? WEB_DISCOVERY_MAX_HINT_LIMIT, WEB_DISCOVERY_MAX_HINT_LIMIT)
  );
  const request = webMusicDiscoveryInputSchema.parse({
    ...discoveryInput,
    maxHints
  });

  try {
    const result = await withTimeout(
      options.input.webMusicDiscoveryProvider.discover(request, { signal: options.signal }),
      options.input.maxWebDiscoveryMs ?? DEFAULT_WEB_DISCOVERY_TIMEOUT_MS
    );
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    if (result.timedOut) {
      return observation(
        options.input.candidatePool,
        'web discovery timed out before returning hints.',
        ['web discovery timeout'],
        { ...baseData, hints: [] }
      );
    }

    const parsed = parseMusicEntityHints(result.value, maxHints);
    return observation(
      options.input.candidatePool,
      `web discovery returned ${parsed.hints.length} hints from ${result.value.length} raw hints.`,
      parsed.problems,
      { ...baseData, hints: parsed.hints }
    );
  } catch (error) {
    return observation(
      options.input.candidatePool,
      'web discovery failed before returning hints.',
      [`web discovery failed: ${formatError(error)}`],
      { ...baseData, hints: [] }
    );
  }
}

function evaluateWebMusicDiscoveryGate(options: {
  discoveryInput: WebMusicDiscoveryInput;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
}): { allowed: boolean; reason?: string; signals: string[]; intentCluster: string } {
  const intentCluster = webDiscoveryIntentCluster(options.input.userId, options.discoveryInput.intent);
  if (options.input.context.discoveryMode === 'comfort') {
    return { allowed: false, reason: 'discovery mode is comfort', signals: [], intentCluster };
  }
  if (options.state.webDiscoveryCalled) {
    return { allowed: false, reason: 'already called in this run', signals: [], intentCluster };
  }

  const signals = webDiscoveryGapSignals(options.input, options.state);
  if (isExplicitWebExploreIntent(options.discoveryInput, options.input.context)) {
    return { allowed: true, signals: ['explicit_explore_intent', ...signals], intentCluster };
  }
  if (signals.length >= 2) {
    return { allowed: true, signals, intentCluster };
  }
  return { allowed: false, reason: 'exploration gap is not strong enough', signals, intentCluster };
}

function webDiscoveryGapSignals(input: CreateMusicAgentToolsInput, state: ToolState): string[] {
  const candidates = input.candidatePool.list();
  const nonLikedCount = candidates.filter((candidate) => candidate.sources.some((source) => source !== 'liked')).length;
  const target = input.context.request === 'auto-fill'
    ? autoFillRecallNonLikedTarget(input.targetPickCount)
    : Math.max(1, input.targetPickCount ?? 2);
  const externalSources = new Set(
    candidates.flatMap((candidate) => candidate.sources.filter((source) => source !== 'liked'))
  );
  const sourceCounts = countArtistKeys(candidates);
  const maxArtistCount = Math.max(0, ...sourceCounts.values());
  const queryFunnel = queryFunnelSnapshot(state);
  return [
    nonLikedCount < target ? 'sparse_external_candidates' : '',
    externalSources.size <= 1 ? 'low_source_diversity' : '',
    candidates.length >= 3 && maxArtistCount / candidates.length >= 0.6 ? 'artist_clustered' : '',
    queryFunnel.some((entry) => entry.resultCount > 0 && entry.addedCount === 0) ? 'query_funnel_low_yield' : '',
    state.ncmSearches > 0 && nonLikedCount === 0 ? 'semantic_or_exact_discovery_empty' : ''
  ].filter(Boolean);
}

function webDiscoveryIntentCluster(userId: string, intent: string): string {
  const cluster = normalizeSearchQuery(intent).slice(0, 120) || 'default';
  return `${userId}:${cluster}`;
}

async function recallFromWebDiscoveryHints(options: {
  hints: unknown;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  maxPlaylistFetches: number;
  signal?: AbortSignal;
  limit: number;
}): Promise<{ summary: string; problems: string[] }> {
  const filteredHints = filterWebDiscoveryHintsForRecall(options.hints, options.input, options.state);
  const parsedInput = parseEntityRecallInput({ hints: filteredHints.hints });
  const entities = parsedInput.entities.slice(0, MAX_ENTITY_RECALL_COUNT);
  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(options.input.context),
      ...(options.state.queryPlan?.avoidArtists ?? [])
    ].flatMap(artistKeys)
  );
  const artistCounts = countArtistKeys(options.input.candidatePool.list());
  const problems = [...filteredHints.problems, ...parsedInput.problems];
  let added = 0;

  for (const entity of entities) {
    if (options.signal?.aborted) return { summary: 'web hint entity recall aborted.', problems: ['aborted'] };
    const result = await recallFromEntity({
      entity,
      input: options.input,
      state: options.state,
      limit: options.limit,
      searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
      maxSearches: options.maxSearches,
      maxPlaylistFetches: options.maxPlaylistFetches,
      avoidArtists,
      artistCounts,
      signal: options.signal
    });
    added += result.added;
    problems.push(...result.problems);
  }

  return {
    summary: `web hint entity recall added ${added} candidates from ${entities.length} entities.`,
    problems
  };
}

function filterWebDiscoveryHintsForRecall(
  value: unknown,
  input: CreateMusicAgentToolsInput,
  state: ToolState
): { hints: unknown[]; problems: string[] } {
  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(input.context),
      ...(state.queryPlan?.avoidArtists ?? [])
    ].flatMap(artistKeys)
  );
  const expectedStyle = selectWebDiscoveryStyle(input.context, state.queryPlan);
  return filterWebDiscoveryHintsByPolicy(value, {
    avoidArtists,
    expectedStyle
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function autoFillMixStage(stage: AutoFillMixStage['stage'], result: ToolObservation): AutoFillMixStage {
  return {
    stage,
    summary: result.summary,
    candidateCount: result.candidateCount,
    problems: result.problems ?? [],
    ...(result.data ? { data: result.data } : {})
  };
}

function autoFillMixObservation(
  input: CreateMusicAgentToolsInput,
  summaries: string[],
  problems: string[],
  stages: AutoFillMixStage[]
): ToolObservation {
  return observation(
    input.candidatePool,
    `auto-fill mix: ${summaries.join(' | ')}`,
    problems,
    { stages }
  );
}

function hasEnoughAutoFillNonLikedCandidates(pool: CandidatePool, targetPickCount: number | undefined): boolean {
  return pool.list().filter((candidate) => !candidate.sources.includes('liked')).length >= autoFillRecallNonLikedTarget(targetPickCount);
}

function autoFillRecallNonLikedTarget(targetPickCount: number | undefined): number {
  const parsedTarget = Number.isFinite(targetPickCount) && targetPickCount ? Math.max(1, Math.floor(targetPickCount)) : 2;
  return Math.max(AUTO_FILL_MIN_RECALL_NON_LIKED_TARGET, parsedTarget * 2);
}

function likedRecallLimit(value: unknown, context: MusicAgentContextSummary): number {
  if (context.request !== 'auto-fill') {
    return boundedPositiveInt(value, 30, MAX_LIKED_RECALL_LIMIT);
  }
  return boundedPositiveInt(value, AUTO_FILL_DEFAULT_LIKED_RECALL_LIMIT, AUTO_FILL_MAX_LIKED_RECALL_LIMIT);
}

function likedRecallScanLimit(limit: number, context: MusicAgentContextSummary): number {
  if (context.request !== 'auto-fill') return limit;
  return Math.min(MAX_LIKED_RECALL_LIMIT, Math.max(limit, limit * AUTO_FILL_LIKED_RECALL_SCAN_MULTIPLIER));
}

function rankOptions(context: MusicAgentContextSummary) {
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty])),
    trackPenalties: new Map((context.recentTrackPenalties ?? []).map((item) => [item.trackKey, item.penalty]))
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

function sanitizeQueryPlan(plan: QueryPlan): QueryPlan {
  return queryPlanSchema.parse({
    ...plan,
    exactTrackQueries: uniqueStrings(plan.exactTrackQueries.map(sanitizeSearchQuery)),
    intentQueries: uniqueStrings(plan.intentQueries.map(sanitizeSearchQuery)),
    tasteAnchorQueries: uniqueStrings(plan.tasteAnchorQueries.map(sanitizeSearchQuery)),
    planQueries: uniqueStrings(plan.planQueries.map(sanitizeSearchQuery)),
    trendQueries: uniqueStrings(plan.trendQueries.map(sanitizeSearchQuery)),
    explorationQueries: uniqueStrings(plan.explorationQueries.map(sanitizeSearchQuery)),
    styleHints: uniqueStrings(plan.styleHints.map(sanitizeSearchQuery)),
    listeningConstraints: uniqueStrings(plan.listeningConstraints.map(sanitizeSearchQuery))
  });
}

function hasQueryPlanRecallQueries(plan: QueryPlan): boolean {
  return [
    ...plan.exactTrackQueries,
    ...plan.intentQueries,
    ...plan.tasteAnchorQueries,
    ...plan.planQueries,
    ...plan.trendQueries,
    ...plan.explorationQueries
  ].some((query) => sanitizeSearchQuery(query).length > 0);
}

function mergeQueryPlans(base: QueryPlan, overlay: QueryPlan): QueryPlan {
  return queryPlanSchema.parse({
    exactTrackQueries: overlay.exactTrackQueries.length > 0 ? overlay.exactTrackQueries : base.exactTrackQueries,
    intentQueries: overlay.intentQueries.length > 0 ? overlay.intentQueries : base.intentQueries,
    tasteAnchorQueries: overlay.tasteAnchorQueries.length > 0 ? overlay.tasteAnchorQueries : base.tasteAnchorQueries,
    planQueries: overlay.planQueries.length > 0 ? overlay.planQueries : base.planQueries,
    trendQueries: overlay.trendQueries.length > 0 ? overlay.trendQueries : base.trendQueries,
    explorationQueries: overlay.explorationQueries.length > 0 ? overlay.explorationQueries : base.explorationQueries,
    styleHints: uniqueStrings([...base.styleHints, ...overlay.styleHints]),
    listeningConstraints: uniqueStrings([...base.listeningConstraints, ...overlay.listeningConstraints]),
    avoidArtists: uniqueStrings([...base.avoidArtists, ...overlay.avoidArtists]),
    negativeTerms: uniqueStrings([...base.negativeTerms, ...overlay.negativeTerms]),
    rationale: overlay.rationale || base.rationale
  });
}

function avoidArtistsFromContext(context: MusicAgentContextSummary): string[] {
  return (context.recentArtistPenalties ?? [])
    .filter((item) => item.penalty >= AVOID_ARTIST_PENALTY_THRESHOLD)
    .map((item) => item.artist);
}

async function recallFromEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  limit: number;
  searchLimit: number;
  maxSearches: number;
  maxPlaylistFetches: number;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  signal?: AbortSignal;
}): Promise<{ added: number; problems: string[] }> {
  try {
    if (options.entity.type === 'track') return recallTrackEntity(options);
    if (options.entity.type === 'artist') return recallArtistEntity(options);
    if (options.entity.type === 'album') return recallAlbumEntity(options);
    return recallPlaylistEntity(options);
  } catch (error) {
    return {
      added: 0,
      problems: [`${options.entity.type} entity ${entityLabel(options.entity)}: ${formatError(error)}`]
    };
  }
}

async function recallTrackEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  limit: number;
  maxSearches: number;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  signal?: AbortSignal;
}): Promise<{ added: number; problems: string[] }> {
  const explicitId = entityId(options.entity);
  if (explicitId) {
    const tracks = await options.input.ncmClient.getSongDetails([explicitId]);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    const verifiedTracks = tracks.filter((track) => trackMatchesKnownEntityFields(options.entity, track));
    if (verifiedTracks.length === 0) {
      return { added: 0, problems: [`track entity rejected: ${entityLabel(options.entity)}`] };
    }
    const result = upsertTracks(options.input.candidatePool, verifiedTracks.slice(0, options.limit), 'search', {
      evidence: `实体曲目: ${entityLabel(options.entity)}`,
      scores: sourceScores('search', options.input.context),
      avoidArtists: options.avoidArtists,
      artistCounts: options.artistCounts
    });
    return {
      added: result.added,
      problems: skippedRecallProblems(result)
    };
  }

  const title = entityTitle(options.entity);
  if (!title) {
    return { added: 0, problems: ['track entity skipped: missing title'] };
  }
  if (!consumeNcmSearch(options.state, options.maxSearches)) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const query = uniqueStrings([title, options.entity.artist ?? '']).join(' ');
  const tracks = await options.input.ncmClient.searchSongs(query, options.limit);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };

  const verifiedTracks = tracks.filter((track) => isVerifiedTrackEntity(options.entity, track));
  if (verifiedTracks.length === 0) {
    return { added: 0, problems: [`track entity rejected: ${entityLabel(options.entity)}`] };
  }

  const result = upsertTracks(options.input.candidatePool, verifiedTracks, 'search', {
    evidence: `实体曲目: ${entityLabel(options.entity)}`,
    scores: sourceScores('search', options.input.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function recallArtistEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  limit: number;
  searchLimit: number;
  maxSearches: number;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  signal?: AbortSignal;
}): Promise<{ added: number; problems: string[] }> {
  const artistName = entityArtistName(options.entity);
  if (!artistName && !entityId(options.entity)) {
    return { added: 0, problems: ['artist entity skipped: missing name'] };
  }
  if (!options.input.ncmClient.getArtistTopSongs || (!entityId(options.entity) && !options.input.ncmClient.searchArtists)) {
    return { added: 0, problems: ['artist entity skipped: NCM artist expansion unavailable'] };
  }

  const artistId = await resolveArtistEntity(options);
  if (!artistId) {
    return { added: 0, problems: [`artist entity rejected: ${artistName}`] };
  }
  if (!consumeNcmSearch(options.state, options.maxSearches)) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const tracks = await options.input.ncmClient.getArtistTopSongs(artistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const verifiedTracks = tracks
    .filter((track) => !artistName || trackMatchesArtist(track, artistName))
    .slice(0, options.limit);
  const result = upsertTracks(options.input.candidatePool, verifiedTracks, 'search', {
    evidence: `实体艺人: ${artistName}`,
    scores: sourceScores('search', options.input.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts
  });
  return {
    added: result.added,
    problems: [
      ...(verifiedTracks.length === 0 ? [`artist entity rejected: ${artistName}`] : []),
      ...skippedRecallProblems(result)
    ]
  };
}

async function recallAlbumEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  limit: number;
  searchLimit: number;
  maxSearches: number;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  signal?: AbortSignal;
}): Promise<{ added: number; problems: string[] }> {
  const explicitId = entityId(options.entity);
  if (explicitId) {
    if (!options.input.ncmClient.getAlbumDetail) {
      return { added: 0, problems: ['album entity skipped: NCM album expansion unavailable'] };
    }
    const detail = await options.input.ncmClient.getAlbumDetail(explicitId);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    if (!detail || !albumMatchesKnownEntityFields(options.entity, detail)) {
      return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
    }
    const result = upsertTracks(options.input.candidatePool, detail.tracks.slice(0, options.limit), 'search', {
      evidence: `实体专辑: ${detail.name}`,
      scores: sourceScores('search', options.input.context),
      avoidArtists: options.avoidArtists,
      artistCounts: options.artistCounts
    });
    return {
      added: result.added,
      problems: skippedRecallProblems(result)
    };
  }

  const title = entityTitle(options.entity);
  if (!title) {
    return { added: 0, problems: ['album entity skipped: missing title'] };
  }
  if (!options.input.ncmClient.searchAlbums || !options.input.ncmClient.getAlbumDetail) {
    return { added: 0, problems: ['album entity skipped: NCM album expansion unavailable'] };
  }
  if (!consumeNcmSearch(options.state, options.maxSearches)) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const query = uniqueStrings([title, options.entity.artist ?? '']).join(' ');
  const albums = await options.input.ncmClient.searchAlbums(query, options.searchLimit);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  const album = findVerifiedAlbum(options.entity, albums);
  if (!album) {
    return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
  }
  if (!consumeNcmSearch(options.state, options.maxSearches)) {
    return { added: 0, problems: ['NCM search budget exhausted'] };
  }

  const detail = await options.input.ncmClient.getAlbumDetail(String(album.id));
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  if (!detail || !albumMatchesEntity(options.entity, detail)) {
    return { added: 0, problems: [`album entity rejected: ${entityLabel(options.entity)}`] };
  }

  const result = upsertTracks(options.input.candidatePool, detail.tracks.slice(0, options.limit), 'search', {
    evidence: `实体专辑: ${detail.name}`,
    scores: sourceScores('search', options.input.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function recallPlaylistEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  limit: number;
  searchLimit: number;
  maxSearches: number;
  maxPlaylistFetches: number;
  avoidArtists: ReadonlySet<string>;
  artistCounts: Map<string, number>;
  signal?: AbortSignal;
}): Promise<{ added: number; problems: string[] }> {
  const name = entityTitle(options.entity) || options.entity.query;
  const explicitId = entityId(options.entity);
  if (!name && !explicitId) {
    return { added: 0, problems: ['playlist entity skipped: missing name'] };
  }
  if (!explicitId && !options.input.ncmClient.searchPlaylists) {
    return { added: 0, problems: ['playlist entity skipped: NCM playlist search unavailable'] };
  }

  let playlistId = explicitId;
  if (!playlistId) {
    if (!name) {
      return { added: 0, problems: ['playlist entity skipped: missing name'] };
    }
    if (!consumeNcmSearch(options.state, options.maxSearches)) {
      return { added: 0, problems: ['NCM search budget exhausted'] };
    }
    const playlists = await options.input.ncmClient.searchPlaylists?.(name, options.searchLimit);
    if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
    playlistId = String(playlists?.[0]?.id ?? '');
  }
  if (!playlistId) {
    return { added: 0, problems: [`playlist entity rejected: ${name}`] };
  }
  if (!consumePlaylistFetch(options.state, options.maxPlaylistFetches)) {
    return { added: 0, problems: ['playlist fetch budget exhausted'] };
  }

  const detail = await options.input.ncmClient.getPlaylistDetail(playlistId);
  if (options.signal?.aborted) return { added: 0, problems: ['aborted'] };
  if (!detail) {
    return { added: 0, problems: [`playlist entity rejected: ${name}`] };
  }

  const result = upsertTracks(options.input.candidatePool, detail.tracks.slice(0, options.limit), 'playlist', {
    evidence: `实体歌单: ${detail.name}`,
    scores: sourceScores('playlist', options.input.context),
    avoidArtists: options.avoidArtists,
    artistCounts: options.artistCounts
  });
  return {
    added: result.added,
    problems: skippedRecallProblems(result)
  };
}

async function resolveArtistEntity(options: {
  entity: MusicEntityHypothesis;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  searchLimit: number;
  maxSearches: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const explicitId = entityId(options.entity);
  if (explicitId) return explicitId;
  const name = entityArtistName(options.entity);
  if (!name || !options.input.ncmClient.searchArtists) return null;
  if (!consumeNcmSearch(options.state, options.maxSearches)) return null;

  const artists = await options.input.ncmClient.searchArtists(name, options.searchLimit);
  if (options.signal?.aborted) return null;
  const verified = artists.find((artist) => tokenMatches(name, artist.name));
  return verified ? String(verified.id) : null;
}

function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function skippedRecallProblems(result: { skippedAvoidedArtists: number; skippedArtistCap: number }): string[] {
  return [
    ...(result.skippedAvoidedArtists > 0 ? [`skipped ${result.skippedAvoidedArtists} tracks from recently repeated artists`] : []),
    ...(result.skippedArtistCap > 0 ? [`skipped ${result.skippedArtistCap} tracks after per-artist recall cap`] : [])
  ];
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
    ].flatMap(artistKeys)
  );
  const {
    sanitizedQueries,
    artistFilteredQueries,
    exactTrackQueries,
    skippedAvoidedQueries,
    skippedSemanticQueries
  } = prepareRecallQueryEligibility(options.queries, avoidArtists);
  const preparedQueries = prepareSearchQueriesForRecall({
    userId: options.input.userId,
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
        source: options.source,
        evidencePrefix: options.evidencePrefix,
        scores: options.scores,
        input: options.input,
        state: options.state,
        maxSearches: options.maxSearches,
        signal: options.signal,
        limit: options.limit ?? DEFAULT_ENTITY_RECALL_LIMIT
      });
      if (semanticRecall.attempted) {
        return observation(
          options.input.candidatePool,
          `${options.evidencePrefix} semantic entity recall added ${semanticRecall.added} candidates from ${semanticRecall.matchCount} matches.`,
          [
            SEMANTIC_ONLY_QUERY_PROBLEM,
            ...semanticRecall.problems,
            ...(skippedAvoidedQueries > 0 ? [`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`] : [])
          ]
        );
      }
    }
    return observation(options.input.candidatePool, `${options.evidencePrefix} recall skipped: no queries (${noQueryReason}).`, [
      'no search queries available',
      ...(skippedSemanticQueries > 0 ? [SEMANTIC_ONLY_QUERY_PROBLEM] : []),
      ...(skippedAvoidedQueries > 0 ? [`skipped ${skippedAvoidedQueries} search queries for recently repeated artists`] : [])
    ]);
  }

  let added = 0;
  let skippedAvoidedArtists = 0;
  let skippedArtistCap = 0;
  let skippedRepeatedQueries = 0;
  const searched: string[] = [];
  const artistFallbacks: string[] = [];
  let artistFallbackAdded = 0;
  const problems: string[] = [];
  const admissionTotals = emptyUpsertTracksResult();
  const artistCounts = countArtistKeys(options.input.candidatePool.list());
  const attemptedArtistFallbacks = new Set<string>();
  let attemptedArtistFallbackCount = 0;

  for (const query of queries) {
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    try {
      const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
      const runSearchKey = searchRunKey(options.source, query, limit);
      const coveredLimit = options.state.searchedQueryLimits.get(runSearchKey) ?? 0;
      if (coveredLimit >= limit) {
        skippedRepeatedQueries += 1;
        continue;
      }
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
      options.state.searchedQueryLimits.set(runSearchKey, Math.max(coveredLimit, limit));
      searched.push(query);
      const result = upsertTracks(options.input.candidatePool, tracks, options.source, {
        evidence: `${options.evidencePrefix}: ${query}`,
        scores: options.scores,
        avoidArtists,
        artistCounts
      });
      recordQueryFunnelSearch(options.state, {
        seed: funnelSeeds.get(normalizeSearchQuery(query)),
        query,
        source: options.source,
        tracks,
        resultCount: tracks.length,
        addedCount: result.added,
        pool: options.input.candidatePool
      });
      added += result.added;
      skippedAvoidedArtists += result.skippedAvoidedArtists;
      skippedArtistCap += result.skippedArtistCap;
      mergeUpsertTracksResult(admissionTotals, result);
      if (
        result.added === 0 &&
        tracks.length > 0 &&
        attemptedArtistFallbackCount < MAX_ARTIST_FALLBACKS_PER_RECALL
      ) {
        const artist = artistFallbackNameFromQuery(query, tracks);
        const fallbackArtistKeys = artistKeys(artist);
        const alreadyAttempted = fallbackArtistKeys.some((artistKey) => attemptedArtistFallbacks.has(artistKey));
        const avoided = fallbackArtistKeys.some((artistKey) => avoidArtists.has(artistKey));
        if (artist && fallbackArtistKeys.length > 0 && !alreadyAttempted && !avoided) {
          for (const artistKey of fallbackArtistKeys) {
            attemptedArtistFallbacks.add(artistKey);
          }
          attemptedArtistFallbackCount += 1;
          const fallback = await recallFromEntity({
            entity: { type: 'artist', name: artist },
            input: options.input,
            state: options.state,
            limit: Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, DEFAULT_ENTITY_RECALL_LIMIT),
            searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
            maxSearches: options.maxSearches,
            maxPlaylistFetches: options.input.budget.maxPlaylistFetches,
            avoidArtists,
            artistCounts,
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

  return observation(
    options.input.candidatePool,
    `${options.evidencePrefix} recall searched ${searched.length} queries and added ${added} candidates: ${searched.join('、') || 'none'}.` +
      (artistFallbacks.length > 0 ? ` artist fallback added ${artistFallbackAdded} candidates from ${artistFallbacks.join('、')}.` : ''),
    problems
  );
}

function artistFallbackNameFromQuery(query: string, tracks: NcmTrackLike[]): string {
  const withoutParenthetical = query.replace(/[（(][^）)]*[）)]/g, ' ').trim();
  const dashParts = withoutParenthetical.split(/\s+(?:—|-|–)\s+/).map((part) => part.trim()).filter(Boolean);
  const queryArtist = dashParts.length >= 2 ? dashParts.at(-1) ?? '' : '';
  if (queryArtist) return queryArtist;

  for (const track of tracks) {
    const artist = track.artists?.find((item) => item?.trim());
    if (artist) return artist.trim();
  }
  return '';
}

async function recallFromSemanticEntities(options: {
  semanticQueries: string[];
  source: CandidateSource;
  evidencePrefix: string;
  scores: MusicCandidateScores;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  signal?: AbortSignal;
  limit: number;
}): Promise<{ attempted: boolean; added: number; matchCount: number; problems: string[] }> {
  if (!options.input.embeddingClient || !options.input.embeddingModel) {
    return {
      attempted: false,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery unavailable: embedding client is not configured']
    };
  }

  const text = uniqueStrings([
    ...options.semanticQueries,
    ...(options.state.queryPlan?.styleHints ?? []),
    ...(options.state.queryPlan?.listeningConstraints ?? []),
    options.input.context.currentUserText,
    options.input.context.activeDirective,
    options.input.context.tasteSummary,
    options.input.context.recentPreferenceSummary
  ]).join(' ');
  if (!text) {
    return {
      attempted: false,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery skipped: empty intent text']
    };
  }

  try {
    const embedding = await options.input.embeddingClient.embed(text, { signal: options.signal });
    if (options.signal?.aborted) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['aborted'] };
    }
    const vector = embedding.vectors[0];
    if (!vector || vector.length === 0) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['semantic discovery returned no embedding vector'] };
    }

    const matches = findSimilarMusicEntities({
      userId: options.input.userId,
      model: options.input.embeddingModel,
      vector,
      limit: DEFAULT_SEMANTIC_ENTITY_LIMIT
    });
    if (matches.length === 0) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['semantic discovery found no indexed entities'] };
    }

    const avoidArtists = new Set(
      [
        ...avoidArtistsFromContext(options.input.context),
        ...(options.state.queryPlan?.avoidArtists ?? [])
      ].flatMap(artistKeys)
    );
    const artistCounts = countArtistKeys(options.input.candidatePool.list());
    const problems: string[] = [];
    let added = 0;

    for (const match of matches) {
      if (options.signal?.aborted) {
        return { attempted: true, added, matchCount: matches.length, problems: ['aborted'] };
      }
      const entity = entityFromStoredRecord(match.entity);
      if (!entity) {
        problems.push(`semantic entity skipped: unsupported type ${match.entity.type}`);
        continue;
      }
      const result = await recallFromEntity({
        entity,
        input: options.input,
        state: options.state,
        limit: options.limit,
        searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
        maxSearches: options.maxSearches,
        maxPlaylistFetches: options.input.budget.maxPlaylistFetches,
        avoidArtists,
        artistCounts,
        signal: options.signal
      });
      added += result.added;
      problems.push(...result.problems);
      if (added >= options.limit) break;
    }

    return { attempted: true, added, matchCount: matches.length, problems };
  } catch (error) {
    return {
      attempted: true,
      added: 0,
      matchCount: 0,
      problems: [`semantic discovery failed: ${formatError(error)}`]
    };
  }
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
    maxAccepted?: number;
  }
): UpsertTracksResult {
  const result = emptyUpsertTracksResult();
  const artistCounts = options.artistCounts ?? new Map<string, number>();
  const maxAccepted = options.maxAccepted ?? Number.POSITIVE_INFINITY;
  for (const track of tracks) {
    if (result.added >= maxAccepted) break;
    const candidate = candidateFromTrack(track, source, options);
    if (!candidate) {
      result.invalid += 1;
      continue;
    }
    const artists = artistKeys(candidate.artist);
    if (artists.some((artist) => options.avoidArtists?.has(artist))) {
      result.skippedAvoidedArtists += 1;
      continue;
    }
    if (artists.some((artist) => (artistCounts.get(artist) ?? 0) >= MAX_QUERY_RECALL_PER_ARTIST_KEY)) {
      result.skippedArtistCap += 1;
      continue;
    }
    const upsertResult = pool.upsert(candidate);
    if (upsertResult.status === 'inserted') {
      result.added += 1;
      result.inserted += 1;
      incrementArtistCounts(artistCounts, artists);
    } else if (upsertResult.status === 'merged_by_id') {
      result.added += 1;
      result.mergedById += 1;
      incrementArtistCounts(artistCounts, artists);
    } else if (upsertResult.status === 'merged_by_dedupe') {
      result.added += 1;
      result.mergedByDedupe += 1;
      incrementArtistCounts(artistCounts, artists);
    } else if (upsertResult.status === 'merged_by_id_and_dedupe') {
      result.added += 1;
      result.mergedByIdAndDedupe += 1;
      incrementArtistCounts(artistCounts, artists);
    } else {
      result.rejectedByPool += 1;
      result.rejectedReasons[upsertResult.reason] = (result.rejectedReasons[upsertResult.reason] ?? 0) + 1;
    }
  }
  return result;
}

function observation(
  pool: CandidatePool,
  summary: string,
  problems: string[] = [],
  data?: Record<string, unknown>
): ToolObservation {
  return {
    summary: truncate(summary, SUMMARY_MAX_CHARS),
    candidateCount: pool.count(),
    ...(problems.length > 0 ? { problems: problems.map((problem) => truncate(problem, 240)) } : {}),
    ...(data ? { data } : {})
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
    slice.sourceStyleSeeds.length ? `sourceStyleSeeds=${slice.sourceStyleSeeds.join('、')}` : '',
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
    plan.exactTrackQueries.length ? `exactTracks=${plan.exactTrackQueries.join('、')}` : '',
    plan.intentQueries.length ? `intent=${plan.intentQueries.join('、')}` : '',
    plan.tasteAnchorQueries.length ? `taste=${plan.tasteAnchorQueries.join('、')}` : '',
    plan.planQueries.length ? `plan=${plan.planQueries.join('、')}` : '',
    plan.trendQueries.length ? `trend=${plan.trendQueries.join('、')}` : '',
    plan.explorationQueries.length ? `explore=${plan.explorationQueries.join('、')}` : '',
    plan.styleHints.length ? `styleHints=${plan.styleHints.join('、')}` : '',
    plan.listeningConstraints.length ? `constraints=${plan.listeningConstraints.join('、')}` : '',
    plan.avoidArtists.length ? `avoidArtists=${plan.avoidArtists.join('、')}` : '',
    plan.negativeTerms.length ? `negative=${plan.negativeTerms.join('、')}` : '',
    plan.rationale ? `rationale=${plan.rationale}` : ''
  ].filter(Boolean).join('; ') || 'query plan is empty.', SUMMARY_MAX_CHARS);
}

function summarizeCandidates(
  label: string,
  candidates: MusicCandidate[],
  options: ReturnType<typeof rankOptions> = { artistPenalties: new Map(), trackPenalties: new Map() }
): string {
  if (candidates.length === 0) return `${label}: candidate pool is empty.`;
  return truncate(
    `${label}: ${candidates.map((candidate) => {
      const breakdown = scoreCandidateForRanking(candidate, options);
      return [
        `${candidate.id}:${candidate.name}-${candidate.artist}`,
        `score=${breakdown.baseScore.toFixed(3)}`,
        breakdown.artistPenalty > 0 ? `artistPenalty=${breakdown.artistPenalty.toFixed(3)}` : '',
        breakdown.trackPenalty > 0 ? `trackPenalty=${breakdown.trackPenalty.toFixed(3)}` : '',
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
  const queryText = [
    stringValue(input.text),
    stringValue(input.userText),
    ...stringArrayValue(input.queries),
    stringValue(input.query),
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].filter(Boolean).join(' ');
  const knowledge = getMusicKnowledgeSlice({
    text: queryText,
    daypart: context.currentMoment.daypart
  });
  const explicitQueries = uniqueStrings([
    ...stringArrayValue(input.queries),
    stringValue(input.query),
    ...(context.actionQueries ?? [])
  ]);
  const planQueries = extractPlanQueries(context.currentPlanSegment);
  const exactTrackQueries = filterExactSongSearchQueries([
    ...explicitQueries,
    ...planQueries
  ]).queries;

  return queryPlanSchema.parse({
    exactTrackQueries,
    intentQueries: explicitQueries,
    tasteAnchorQueries: [],
    planQueries,
    trendQueries: [],
    explorationQueries: [],
    styleHints: uniqueStrings([
      ...knowledge.styleAdjacency,
      ...knowledge.sourceStyleSeeds
    ]),
    listeningConstraints: uniqueStrings([
      context.currentMoment.daypart,
      ...styleSeedQueryModifiers(queryText)
    ]),
    avoidArtists: avoidArtistsFromContext(context),
    negativeTerms: knowledge.negativeMappings,
    rationale: 'context-derived fallback query plan'
  });
}

function countArtistKeys(candidates: MusicCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const artist of artistKeys(candidate.artist)) {
      counts.set(artist, (counts.get(artist) ?? 0) + 1);
    }
  }
  return counts;
}

function incrementArtistCounts(counts: Map<string, number>, artists: string[]): void {
  for (const artist of artists) {
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
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
