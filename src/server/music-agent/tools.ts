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
  musicEntityHintSchema,
  queryPlanSchema,
  webMusicDiscoveryInputSchema,
  type AgentBudget,
  type CandidateSource,
  type MusicEntityHint,
  type MusicAgentContextSummary,
  type MusicCandidateQualitySignals,
  type MusicAgentToolName,
  type MusicCandidate,
  type MusicCandidateScores,
  type QueryFunnelEntry,
  type QueryPlan,
  type TrendContext,
  type WebMusicDiscoveryInput
} from './schema.js';
import type { CandidatePool, CandidatePoolRejectReason } from './candidates.js';
import {
  normalizeSearchQuery,
  prepareSearchQueriesForRecall,
  recordUserQueryFunnel,
  sanitizeSearchQuery
} from './query-stats.js';
import { normalizeMusicTrackToken } from './dedupe.js';
import type { FinalPick } from './schema.js';
import {
  findSimilarMusicEntities,
  type MusicEntityRecord as StoredMusicEntityRecord
} from '../store/music-entities.js';
import type { WebMusicDiscoveryProvider } from './web-discovery.js';

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

type NcmTrackLike = {
  id?: number | string | null;
  name?: string | null;
  artists?: string[] | null;
  qualitySignals?: MusicCandidateQualitySignals | null;
};

type NcmAlbumLike = {
  id: number | string;
  name: string;
  artist?: string | null;
};

type MusicEntityType = 'track' | 'artist' | 'album' | 'playlist';

type MusicEntityHypothesis = {
  type: MusicEntityType;
  title?: string;
  name?: string;
  artist?: string;
  id?: string;
  providerId?: string;
  query?: string;
};

type ToolState = {
  queryPlan: QueryPlan | null;
  trendContext: TrendContext | null;
  ncmSearches: number;
  playlistFetches: number;
  qualityPreparedIds: Set<string>;
  queryFunnel: Map<string, QueryFunnelAccumulator>;
  webDiscoveryCalled: boolean;
};

type AutoFillMixStage = {
  stage: 'search' | 'style_expansion' | 'trend' | 'web_discovery' | 'web_hint_recall';
  summary: string;
  candidateCount: number;
  problems: string[];
  data?: Record<string, unknown>;
};

type UpsertTracksResult = {
  added: number;
  inserted: number;
  mergedById: number;
  mergedByDedupe: number;
  mergedByIdAndDedupe: number;
  invalid: number;
  rejectedByPool: number;
  rejectedReasons: Partial<Record<CandidatePoolRejectReason, number>>;
  skippedAvoidedArtists: number;
  skippedArtistCap: number;
};

type QueryFunnelAccumulator = QueryFunnelEntry & {
  candidateIds: Set<string>;
  order: number;
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
const MAX_QUERY_RECALL_PER_PRIMARY_ARTIST = 2;
const MAX_ARTIST_FALLBACKS_PER_RECALL = 2;
const LIKED_RECALL_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_RECALL_CACHE_TTL_MS = 30 * 60 * 1000;
const QUALITY_DETAIL_BATCH_LIMIT = 80;
const QUALITY_SOURCES = new Set<CandidateSource>(['search', 'style_expansion', 'trend']);
const MAX_RECALL_QUERY_COUNT = 8;
const AUTO_FILL_MIN_RECALL_NON_LIKED_TARGET = 8;
const DEFAULT_WEB_DISCOVERY_TIMEOUT_MS = 6_000;
const DEFAULT_WEB_DISCOVERY_HINT_LIMIT = 6;
const AUTO_FILL_WEB_DISCOVERY_HINT_LIMIT = 8;
const WEB_DISCOVERY_ENTITY_RECALL_LIMIT = 1;
const WEB_DISCOVERY_INTENT_MAX_CHARS = 360;
const WEB_DISCOVERY_MAX_HINT_LIMIT = 12;
const WEB_DISCOVERY_COOLDOWN_MS = 20 * 60 * 1000;
const WEB_HINT_MIN_CONFIDENCE = 0.45;
const SEMANTIC_ONLY_QUERY_PROBLEM = 'skipped semantic-only queries; use semantic discovery before NCM song search';
const SEMANTIC_SONG_SEARCH_PATTERNS = [
  /\b(city\s*pop|indie\s*pop|dream\s*pop|synth[-\s]*pop|cantopop|neo\s*soul|nu\s*jazz|downtempo|electropop)\b/i,
  /\b(indie\s*rock|alternative\s*rock|soft\s*rock|j[-\s]*pop|k[-\s]*pop|c[-\s]*pop)\b/i,
  /\b(female\s*(vocal|singer|artist)|male\s*(vocal|singer|artist)|low\s*energy|medium[-\s]*low\s*energy)\b/i,
  /\b(chill|quiet|focus|workout|relax(?:ed|ing)?|soft|mellow|synth|band|guitar)\b/i,
  /午后|下午|上午|早晨|清晨|晚上|夜晚|深夜|工作|学习|专注|轻松|柔和|不吵|安静|中低能量|低能量|高能量/,
  /女声|男声|女歌手|男歌手|女生唱|男生唱|乐队|律动|合成器|清爽|明亮|提神|低人声|少人声|粤语|华语/
];
const likedRecallCache = new Map<string, CacheEntry<NcmTrackLike[]>>();
const searchRecallCache = new Map<string, CacheEntry<NcmTrackLike[]>>();
const webDiscoveryCooldowns = new Map<string, number>();
const WEB_DISCOVERY_STYLE_PATTERNS: Array<{ pattern: RegExp; style: string; priority: number }> = [
  { pattern: /janice\s*vidal|卫兰|my\s*cookie\s*can|就算世界无童话|cantopop|粤语流行|粤语|港乐|香港流行|广东歌/i, style: 'cantopop', priority: 40 },
  { pattern: /tanya\s*chua|蔡健雅|红色高跟鞋|mandopop|c[-\s]*pop|华语|中文|国语|mandarin/i, style: 'c-pop', priority: 30 },
  { pattern: /city\s*pop|城市流行/i, style: 'city pop', priority: 22 },
  { pattern: /indie\s*folk|独立民谣/i, style: 'indie folk', priority: 21 },
  { pattern: /folk|民谣/i, style: 'folk', priority: 18 },
  { pattern: /singer[-\s]*songwriter|唱作/i, style: 'singer-songwriter', priority: 17 },
  { pattern: /indie\s*pop|独立流行/i, style: 'indie pop', priority: 16 },
  { pattern: /dream\s*pop|梦幻流行/i, style: 'dream pop', priority: 15 },
  { pattern: /synth[-\s]*pop|合成器流行/i, style: 'synth pop', priority: 14 },
  { pattern: /neo\s*soul|新灵魂/i, style: 'neo soul', priority: 13 },
  { pattern: /r\s*&?\s*b|节奏布鲁斯/i, style: 'r&b', priority: 12 },
  { pattern: /jazz|爵士/i, style: 'jazz', priority: 11 },
  { pattern: /ambient|氛围/i, style: 'ambient', priority: 10 },
  { pattern: /downtempo|缓拍/i, style: 'downtempo', priority: 9 },
  { pattern: /alternative\s*rock|另类摇滚/i, style: 'alternative rock', priority: 8 },
  { pattern: /indie\s*rock|独立摇滚/i, style: 'indie rock', priority: 7 },
  { pattern: /j[-\s]*pop|日语|日系/i, style: 'j-pop', priority: 6 },
  { pattern: /k[-\s]*pop|韩语|韩系/i, style: 'k-pop', priority: 5 }
];
const HARD_MISMATCH_WEB_ARTIST_PATTERN =
  /\b(slipknot|metallica|megadeth|slayer|korn|limp bizkit|pantera|system of a down)\b/i;

export function createMusicAgentTools(input: CreateMusicAgentToolsInput): MusicAgentToolRegistry {
  const state: ToolState = {
    queryPlan: null,
    trendContext: null,
    ncmSearches: 0,
    playlistFetches: 0,
    qualityPreparedIds: new Set(),
    queryFunnel: new Map(),
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
        const added = upsertTracks(input.candidatePool, tracks, 'liked', {
          evidence: '网易云红心歌曲',
          scores: sourceScores('liked', input.context),
          maxAccepted: limit
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
        ].map(primaryArtist).filter(Boolean)
      );
      const artistCounts = countPrimaryArtists(input.candidatePool.list());
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
    recordQueryFunnel: () => recordUserQueryFunnel(input.userId, queryFunnelSnapshot(state)),
    recordFinalPicks: (picks) => recordFinalQueryFunnel(input.userId, state, picks)
  };
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
      setWebDiscoveryCooldown(gate.intentCluster);
      return observation(
        options.input.candidatePool,
        'web discovery timed out before returning hints.',
        ['web discovery timeout'],
        { ...baseData, hints: [] }
      );
    }

    const parsed = parseMusicEntityHints(result.value, maxHints);
    setWebDiscoveryCooldown(gate.intentCluster);
    return observation(
      options.input.candidatePool,
      `web discovery returned ${parsed.hints.length} hints from ${result.value.length} raw hints.`,
      parsed.problems,
      { ...baseData, hints: parsed.hints }
    );
  } catch (error) {
    setWebDiscoveryCooldown(gate.intentCluster);
    return observation(
      options.input.candidatePool,
      'web discovery failed before returning hints.',
      [`web discovery failed: ${formatError(error)}`],
      { ...baseData, hints: [] }
    );
  }
}

function parseWebMusicDiscoveryInput(
  toolInput: Record<string, unknown>,
  input: CreateMusicAgentToolsInput
): WebMusicDiscoveryInput {
  const intent = stringValue(toolInput.intent) || webDiscoveryIntentText(input.context) || 'music exploration';
  return webMusicDiscoveryInputSchema.parse({
    intent,
    focus: parseWebDiscoveryFocus(toolInput.focus, intent),
    anchors: objectArrayValue(toolInput.anchors),
    locale: stringValue(toolInput.locale) || defaultWebDiscoveryLocale(input.context),
    freshness: stringValue(toolInput.freshness) || defaultWebDiscoveryFreshness(intent),
    maxHints: boundedPositiveInt(toolInput.maxHints, input.maxWebDiscoveryHints ?? DEFAULT_WEB_DISCOVERY_HINT_LIMIT, WEB_DISCOVERY_MAX_HINT_LIMIT)
  });
}

function parseWebDiscoveryFocus(value: unknown, intent: string): WebMusicDiscoveryInput['focus'] {
  const raw = stringValue(value);
  const allowed = new Set<WebMusicDiscoveryInput['focus']>([
    'style_artists',
    'style_tracks',
    'similar_artists',
    'similar_tracks',
    'new_releases',
    'scene_overview'
  ]);
  if (allowed.has(raw as WebMusicDiscoveryInput['focus'])) return raw as WebMusicDiscoveryInput['focus'];
  if (/新歌|新音乐|recent|new release|fresh/i.test(intent)) return 'new_releases';
  if (/类似|相似|similar|like/i.test(intent)) return 'similar_tracks';
  if (/歌手|artist|艺人/i.test(intent)) return 'style_artists';
  return 'scene_overview';
}

function defaultWebDiscoveryLocale(context: MusicAgentContextSummary): WebMusicDiscoveryInput['locale'] {
  const text = webDiscoveryIntentText(context);
  return /[一-鿿]/.test(text) ? 'zh-CN' : 'global';
}

function defaultWebDiscoveryFreshness(intent: string): WebMusicDiscoveryInput['freshness'] {
  return /新歌|近期|最近|recent|new|fresh|release/i.test(intent) ? 'recent' : 'durable';
}

function autoFillWebDiscoveryInput(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null
): Record<string, unknown> {
  const style = selectWebDiscoveryStyle(context, queryPlan);
  const intent = compactWebDiscoveryIntent(context, queryPlan, style);
  return {
    intent,
    focus: style ? 'style_artists' : 'scene_overview',
    anchors: style ? [{ type: 'style', name: style }] : [],
    locale: /[一-鿿]/.test(intent) ? 'zh-CN' : 'global',
    freshness: hasExplicitRecentWebIntent(context) ? 'recent' : 'durable',
    maxHints: AUTO_FILL_WEB_DISCOVERY_HINT_LIMIT
  };
}

function selectWebDiscoveryStyle(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null
): string {
  const scores = new Map<string, { score: number; priority: number }>();
  const addText = (text: string, weight: number) => {
    if (!text) return;
    for (const item of WEB_DISCOVERY_STYLE_PATTERNS) {
      if (!item.pattern.test(text)) continue;
      const existing = scores.get(item.style) ?? { score: 0, priority: item.priority };
      scores.set(item.style, {
        score: existing.score + weight + item.priority / 100,
        priority: Math.max(existing.priority, item.priority)
      });
    }
  };

  addText([context.currentUserText, ...(context.actionQueries ?? []), context.activeDirective].join(' '), 100);
  addText(context.currentPlanSegment ?? '', 80);
  addText([...(queryPlan?.exactTrackQueries ?? [])].join(' '), 95);
  addText([
    ...(queryPlan?.tasteAnchorQueries ?? []),
    ...(queryPlan?.planQueries ?? []),
    ...(queryPlan?.explorationQueries ?? [])
  ].join(' '), 55);
  addText([...(queryPlan?.styleHints ?? []), ...(queryPlan?.listeningConstraints ?? [])].join(' '), 70);
  addText(context.recentPreferenceSummary, 25);
  addText(context.tasteSummary, 15);

  return [...scores.entries()]
    .sort((left, right) => {
      const scoreDelta = right[1].score - left[1].score;
      if (scoreDelta !== 0) return scoreDelta;
      return right[1].priority - left[1].priority;
    })[0]?.[0] ?? '';
}

function compactWebDiscoveryIntent(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null,
  style: string
): string {
  const parts = uniqueStrings([
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective,
    context.currentPlanSegment ?? '',
    style ? `style:${style}` : '',
    ...(queryPlan?.exactTrackQueries.slice(0, 3) ?? []),
    ...(queryPlan?.tasteAnchorQueries.slice(0, 2) ?? []),
    ...(queryPlan?.planQueries.slice(0, 2) ?? []),
    ...(queryPlan?.explorationQueries.slice(0, 2) ?? []),
    ...(queryPlan?.styleHints.slice(0, 4) ?? []),
    ...(queryPlan?.listeningConstraints.slice(0, 4) ?? [])
  ]);
  return truncate(parts.join(' | ') || style || 'music exploration', WEB_DISCOVERY_INTENT_MAX_CHARS);
}

function hasExplicitRecentWebIntent(context: MusicAgentContextSummary): boolean {
  const text = [
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].join(' ');
  return /新歌|近期|最近|recent|new|fresh|release/i.test(text);
}

function evaluateWebMusicDiscoveryGate(options: {
  discoveryInput: WebMusicDiscoveryInput;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
}): { allowed: boolean; reason?: string; signals: string[]; intentCluster: string } {
  const intentCluster = webDiscoveryCooldownKey(options.input.userId, options.discoveryInput.intent);
  if (options.input.context.discoveryMode === 'comfort') {
    return { allowed: false, reason: 'discovery mode is comfort', signals: [], intentCluster };
  }
  if (options.state.webDiscoveryCalled) {
    return { allowed: false, reason: 'already called in this run', signals: [], intentCluster };
  }
  if (isWebDiscoveryCooldownActive(intentCluster)) {
    return { allowed: false, reason: 'cooldown active for this intent cluster', signals: [], intentCluster };
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
  const sourceCounts = countPrimaryArtists(candidates);
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

function isExplicitWebExploreIntent(
  discoveryInput: WebMusicDiscoveryInput,
  context: MusicAgentContextSummary
): boolean {
  const text = [
    discoveryInput.intent,
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective,
    context.currentPlanSegment ?? ''
  ].join(' ');
  return (
    /探索|发现|找点|新歌|新音乐|类似|相似|小众|冷门|recent|new|discover|explore|similar|fresh|novelty/i.test(text) ||
    discoveryInput.focus === 'new_releases' ||
    discoveryInput.focus === 'similar_artists' ||
    discoveryInput.focus === 'similar_tracks'
  );
}

function webDiscoveryIntentText(context: MusicAgentContextSummary): string {
  return [
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective,
    context.currentPlanSegment ?? ''
  ].filter(Boolean).join(' ');
}

function webDiscoveryCooldownKey(userId: string, intent: string): string {
  const cluster = normalizeSearchQuery(intent).slice(0, 120) || 'default';
  return `${userId}:${cluster}`;
}

function isWebDiscoveryCooldownActive(key: string): boolean {
  const expiresAt = webDiscoveryCooldowns.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    webDiscoveryCooldowns.delete(key);
    return false;
  }
  return true;
}

function setWebDiscoveryCooldown(key: string): void {
  webDiscoveryCooldowns.set(key, Date.now() + WEB_DISCOVERY_COOLDOWN_MS);
}

function parseMusicEntityHints(value: unknown, limit: number): { hints: MusicEntityHint[]; problems: string[] } {
  const rawHints = Array.isArray(value) ? value : [];
  const hints: MusicEntityHint[] = [];
  const problems: string[] = [];
  for (const rawHint of rawHints) {
    if (hints.length >= limit) break;
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      problems.push('web hint skipped: invalid sourced hint');
      continue;
    }
    hints.push(parsed.data);
  }
  return { hints, problems };
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
    ].map(primaryArtist).filter(Boolean)
  );
  const artistCounts = countPrimaryArtists(options.input.candidatePool.list());
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
    ].map(primaryArtist).filter(Boolean)
  );
  const expectedStyle = selectWebDiscoveryStyle(input.context, state.queryPlan);
  const hints: unknown[] = [];
  const problems: string[] = [];

  for (const rawHint of objectArrayValue(value)) {
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      hints.push(rawHint);
      continue;
    }
    const hint = parsed.data;
    const artist = webHintArtistName(hint);
    const artistKey = artist ? primaryArtist(artist) : '';
    if (artistKey && avoidArtists.has(artistKey)) {
      problems.push(`web hint skipped: recently repeated artist ${artist}`);
      continue;
    }
    if (artist && isHardMismatchedWebArtist(artist, expectedStyle || hint.styles.join(' '))) {
      problems.push(`web hint skipped: hard style mismatch for ${artist}`);
      continue;
    }
    hints.push(rawHint);
  }

  return { hints, problems };
}

function webHintArtistName(hint: MusicEntityHint): string {
  if (hint.kind === 'artist') return hint.name;
  if (hint.kind === 'relationship') return hint.relatedName ?? hint.artist ?? hint.name;
  return hint.artist ?? '';
}

function isHardMismatchedWebArtist(artist: string, styleText: string): boolean {
  if (!styleText || !styleDisallowsHeavyRock(styleText)) return false;
  return HARD_MISMATCH_WEB_ARTIST_PATTERN.test(artist);
}

function styleDisallowsHeavyRock(styleText: string): boolean {
  return /cantopop|c[-\s]*pop|j[-\s]*pop|k[-\s]*pop|city\s*pop|indie\s*folk|folk|dream\s*pop|synth[-\s]*pop|singer[-\s]*songwriter|neo\s*soul|r\s*&?\s*b|jazz|ambient|downtempo/i.test(styleText);
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

function autoFillSearchQueries(context: MusicAgentContextSummary, queryPlan: QueryPlan): string[] {
  return uniqueStrings([
    ...(context.actionQueries ?? []),
    ...queryPlan.exactTrackQueries,
    ...queryPlan.intentQueries,
    ...queryPlan.tasteAnchorQueries,
    ...queryPlan.planQueries,
    ...queryPlan.explorationQueries
  ]).slice(0, 8);
}

function styleExpansionQueries(context: MusicAgentContextSummary, toolInput: Record<string, unknown>): string[] {
  const explicitQueries = stringArrayValue(toolInput.queries);
  const excludedQueries = new Set(stringArrayValue(toolInput.excludeQueries).map(normalizeSearchQuery));
  const text = [
    stringValue(toolInput.text),
    stringValue(toolInput.userText),
    ...explicitQueries,
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].filter(Boolean).join(' ');
  const knowledge = getMusicKnowledgeSlice({
    text,
    daypart: context.currentMoment.daypart
  });
  const seedQueries = sourceStyleSeedQueries(knowledge.sourceStyleSeeds, text);
  const fallbackQueries = explicitQueries.length > 0
    ? [...seedQueries, ...knowledge.styleAdjacency]
    : [...seedQueries, ...knowledge.styleAdjacency, ...knowledge.queryTemplates.slice(0, 2)];
  return uniqueStrings([
    ...explicitQueries,
    ...fallbackQueries
  ])
    .filter((query) => !excludedQueries.has(normalizeSearchQuery(query)))
    .slice(0, 8);
}

function sourceStyleSeedQueries(styleSeeds: string[], text: string): string[] {
  const modifiers = styleSeedQueryModifiers(text);
  return uniqueStrings(styleSeeds.flatMap((style) => modifiers.map((modifier) => `${style} ${modifier}`)));
}

function styleSeedQueryModifiers(text: string): string[] {
  const normalized = text.toLowerCase();
  const modifiers: string[] = [];
  if (/rock|摇滚|乐队|guitar|吉他/.test(normalized)) modifiers.push('乐队');
  if (/电子|electronic|synth|合成器/.test(normalized)) modifiers.push('synth');
  if (/女声|女歌手|女生唱|female vocal|female-vocal/.test(normalized)) modifiers.push('女声');
  if (/粤语|港乐|广东歌|cantonese/.test(normalized)) modifiers.push('粤语');
  if (/华语|中文|mandarin/.test(normalized)) modifiers.push('华语');
  if (/别太吵|不要太吵|不吵|安静|轻一点|轻松|quiet|chill/.test(normalized)) modifiers.push('不吵');
  if (/专注|工作|学习|focus|少人声|低人声/.test(normalized)) modifiers.push('低人声');
  if (/跑步|运动|running|workout|高能量|提神/.test(normalized)) modifiers.push('律动');
  return uniqueStrings(modifiers.length > 0 ? modifiers : ['中低能量']);
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
  return Math.max(AUTO_FILL_MIN_RECALL_NON_LIKED_TARGET, parsedTarget * 3);
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

function parseEntityHypotheses(input: Record<string, unknown>): MusicEntityHypothesis[] {
  return [
    ...objectArrayValue(input.entities).map(parseEntityHypothesis),
    ...objectArrayValue(input.tracks).map((item) => parseEntityHypothesis({ ...item, type: 'track' })),
    ...objectArrayValue(input.artists).map((item) => parseEntityHypothesis({ ...item, type: 'artist' })),
    ...objectArrayValue(input.albums).map((item) => parseEntityHypothesis({ ...item, type: 'album' })),
    ...objectArrayValue(input.playlists).map((item) => parseEntityHypothesis({ ...item, type: 'playlist' }))
  ].filter((entity): entity is MusicEntityHypothesis => Boolean(entity));
}

function parseEntityRecallInput(input: Record<string, unknown>): {
  entities: MusicEntityHypothesis[];
  problems: string[];
} {
  const hintResult = parseEntityHypothesesFromHints(input.hints);
  return {
    entities: [
      ...parseEntityHypotheses(input),
      ...hintResult.entities
    ],
    problems: hintResult.problems
  };
}

function parseEntityHypothesesFromHints(value: unknown): {
  entities: MusicEntityHypothesis[];
  problems: string[];
} {
  const entities: MusicEntityHypothesis[] = [];
  const problems: string[] = [];
  for (const rawHint of objectArrayValue(value)) {
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      problems.push('web hint skipped: invalid sourced hint');
      continue;
    }
    const hint = parsed.data;
    if (hint.confidence < WEB_HINT_MIN_CONFIDENCE) {
      problems.push(`web hint skipped: low confidence for ${hint.name}`);
      continue;
    }
    const entity = entityFromMusicEntityHint(hint);
    if (entity) {
      entities.push(entity);
      continue;
    }
    if (hint.kind === 'track' || hint.kind === 'chart_item') {
      problems.push(`web track hint skipped: missing artist for ${hint.name}`);
    } else if (hint.kind === 'relationship') {
      problems.push(`web relationship hint skipped: ${hint.name}`);
    } else {
      problems.push(`web hint skipped: unsupported ${hint.kind} ${hint.name}`);
    }
  }
  return { entities, problems };
}

function entityFromMusicEntityHint(hint: MusicEntityHint): MusicEntityHypothesis | null {
  if (hint.kind === 'track' || hint.kind === 'chart_item') {
    if (!hint.artist) return null;
    return { type: 'track', title: hint.name, artist: hint.artist };
  }
  if (hint.kind === 'artist') {
    return { type: 'artist', name: hint.name };
  }
  if (hint.kind === 'album') {
    return {
      type: 'album',
      title: hint.name,
      ...(hint.artist ? { artist: hint.artist } : {})
    };
  }
  if (hint.kind === 'playlist') {
    return { type: 'playlist', name: hint.name };
  }
  if (hint.kind === 'relationship' && hint.relatedName) {
    return { type: 'artist', name: hint.relatedName };
  }
  return null;
}

function parseEntityHypothesis(input: Record<string, unknown>): MusicEntityHypothesis | null {
  const type = parseEntityType(stringValue(input.type));
  if (!type) return null;
  const title = stringValue(input.title);
  const name = stringValue(input.name);
  const artist = stringValue(input.artist);
  const id = stringValue(input.id);
  const providerId = stringValue(input.providerId);
  const query = stringValue(input.query);
  return {
    type,
    ...(title ? { title } : {}),
    ...(name ? { name } : {}),
    ...(artist ? { artist } : {}),
    ...(id ? { id } : {}),
    ...(providerId ? { providerId } : {}),
    ...(query ? { query } : {})
  };
}

function parseEntityType(value: string): MusicEntityType | null {
  const normalized = value.toLowerCase();
  if (normalized === 'track' || normalized === 'song') return 'track';
  if (normalized === 'artist' || normalized === 'singer') return 'artist';
  if (normalized === 'album') return 'album';
  if (normalized === 'playlist') return 'playlist';
  return null;
}

function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function entityTitle(entity: MusicEntityHypothesis): string {
  return entity.title ?? entity.name ?? '';
}

function entityArtistName(entity: MusicEntityHypothesis): string {
  return entity.name ?? entity.artist ?? entity.title ?? '';
}

function entityId(entity: MusicEntityHypothesis): string {
  return entity.providerId ?? entity.id ?? '';
}

function entityLabel(entity: MusicEntityHypothesis): string {
  const title = entityTitle(entity) || entity.query || entityArtistName(entity) || entity.type;
  return entity.artist ? `${title} - ${entity.artist}` : title;
}

function isVerifiedTrackEntity(entity: MusicEntityHypothesis, track: NcmTrackLike): boolean {
  const title = entityTitle(entity);
  if (!title || !track.name || !tokenMatches(title, track.name)) return false;
  return !entity.artist || trackMatchesArtist(track, entity.artist);
}

function trackMatchesKnownEntityFields(entity: MusicEntityHypothesis, track: NcmTrackLike): boolean {
  const title = entityTitle(entity);
  if (title && (!track.name || !tokenMatches(title, track.name))) return false;
  return !entity.artist || trackMatchesArtist(track, entity.artist);
}

function findVerifiedAlbum(entity: MusicEntityHypothesis, albums: NcmAlbumLike[]): NcmAlbumLike | null {
  return albums.find((album) => albumMatchesEntity(entity, album)) ?? null;
}

function albumMatchesEntity(entity: MusicEntityHypothesis, album: NcmAlbumLike): boolean {
  const title = entityTitle(entity);
  if (!title || !album.name || !tokenMatches(title, album.name)) return false;
  return !entity.artist || tokenMatches(entity.artist, album.artist ?? '');
}

function albumMatchesKnownEntityFields(entity: MusicEntityHypothesis, album: NcmAlbumLike): boolean {
  const title = entityTitle(entity);
  if (title && (!album.name || !tokenMatches(title, album.name))) return false;
  return !entity.artist || tokenMatches(entity.artist, album.artist ?? '');
}

function trackMatchesArtist(track: NcmTrackLike, artist: string): boolean {
  const expected = primaryArtist(artist);
  if (!expected) return false;
  return (track.artists ?? []).some((candidate) => tokenMatches(expected, primaryArtist(candidate)));
}

function tokenMatches(expected: string, actual: string): boolean {
  const left = normalizeMusicTrackToken(expected);
  const right = normalizeMusicTrackToken(actual);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 4 && longer.includes(shorter);
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
    ].map(primaryArtist).filter(Boolean)
  );
  const sanitizedQueries = uniqueStrings(options.queries.map(sanitizeSearchQuery).filter(Boolean));
  const { queries: artistFilteredQueries, skipped: skippedAvoidedQueries } = filterAvoidedQueries(sanitizedQueries, avoidArtists);
  const { queries: exactTrackQueries, skipped: skippedSemanticQueries } = filterExactSongSearchQueries(artistFilteredQueries);
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
  const searched: string[] = [];
  const artistFallbacks: string[] = [];
  let artistFallbackAdded = 0;
  const problems: string[] = [];
  const admissionTotals = emptyUpsertTracksResult();
  const artistCounts = countPrimaryArtists(options.input.candidatePool.list());
  const attemptedArtistFallbacks = new Set<string>();

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
        attemptedArtistFallbacks.size < MAX_ARTIST_FALLBACKS_PER_RECALL
      ) {
        const artist = artistFallbackNameFromQuery(query, tracks);
        const artistKey = artist ? primaryArtist(artist) : '';
        if (artist && artistKey && !attemptedArtistFallbacks.has(artistKey) && !avoidArtists.has(artistKey)) {
          attemptedArtistFallbacks.add(artistKey);
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

function formatNoExecutableQueryReason(input: {
  inputQueryCount: number;
  sanitizedQueryCount: number;
  artistFilteredQueryCount: number;
  skippedAvoidedQueries: number;
  skippedSemanticQueries: number;
}): string {
  const reasons: string[] = [];
  if (input.inputQueryCount === 0) reasons.push('query plan empty');
  if (input.inputQueryCount > 0 && input.sanitizedQueryCount === 0) reasons.push('queries sanitized to empty');
  if (input.skippedAvoidedQueries > 0 && input.artistFilteredQueryCount === 0) {
    reasons.push('all queries skipped for recently repeated artists');
  }
  if (input.skippedSemanticQueries > 0) {
    reasons.push(input.artistFilteredQueryCount === input.skippedSemanticQueries
      ? 'all queries skipped as semantic-only'
      : `${input.skippedSemanticQueries} semantic-only queries skipped`);
  }
  return reasons.length > 0 ? reasons.join('; ') : 'no exact-track search queries available';
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
      ].map(primaryArtist).filter(Boolean)
    );
    const artistCounts = countPrimaryArtists(options.input.candidatePool.list());
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

function recordQueryFunnelSearch(
  state: ToolState,
  input: {
    seed: QueryFunnelEntry | undefined;
    query: string;
    source: CandidateSource;
    tracks: NcmTrackLike[];
    resultCount: number;
    addedCount: number;
    pool: CandidatePool;
  }
): void {
  const normalizedQuery = normalizeSearchQuery(input.query);
  if (!normalizedQuery) return;
  const key = queryFunnelKey(input.source, normalizedQuery);
  const existing = state.queryFunnel.get(key);
  const candidateIds = new Set(
    input.tracks
      .map((track) => track.id === undefined || track.id === null ? '' : String(track.id).trim())
      .filter((id) => id && input.pool.has(id))
  );
  if (existing) {
    const uniqueAddedCount = [...candidateIds].filter((id) => !existing.candidateIds.has(id)).length;
    existing.searchedCount += 1;
    existing.resultCount += input.resultCount;
    existing.addedCount += uniqueAddedCount;
    for (const id of candidateIds) existing.candidateIds.add(id);
    return;
  }

  state.queryFunnel.set(key, {
    ...(input.seed ?? {
      query: input.query,
      normalizedQuery,
      source: input.source,
      searchedCount: 0,
      resultCount: 0,
      addedCount: 0,
      selectedCount: 0,
      scoreMultiplier: 1,
      repeatPenalty: 0,
      selectionRate: null
    }),
    searchedCount: 1,
    resultCount: input.resultCount,
    addedCount: candidateIds.size,
    selectedCount: 0,
    candidateIds,
    order: state.queryFunnel.size
  });
}

function queryFunnelSnapshot(state: ToolState): QueryFunnelEntry[] {
  return [...state.queryFunnel.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ candidateIds: _candidateIds, order: _order, ...entry }) => ({ ...entry }));
}

function recordFinalQueryFunnel(userId: string, state: ToolState, picks: FinalPick[]): void {
  const pickedIds = new Set(picks.map((pick) => pick.id));
  for (const entry of state.queryFunnel.values()) {
    entry.selectedCount = [...entry.candidateIds].filter((id) => pickedIds.has(id)).length;
  }
  recordUserQueryFunnel(userId, queryFunnelSnapshot(state));
}

function queryFunnelKey(source: CandidateSource, normalizedQuery: string): string {
  return `${source}:${normalizedQuery}`;
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
    const artist = primaryArtist(candidate.artist);
    if (artist && options.avoidArtists?.has(artist)) {
      result.skippedAvoidedArtists += 1;
      continue;
    }
    if (artist && (artistCounts.get(artist) ?? 0) >= MAX_QUERY_RECALL_PER_PRIMARY_ARTIST) {
      result.skippedArtistCap += 1;
      continue;
    }
    const upsertResult = pool.upsert(candidate);
    if (upsertResult.status === 'inserted') {
      result.added += 1;
      result.inserted += 1;
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    } else if (upsertResult.status === 'merged_by_id') {
      result.added += 1;
      result.mergedById += 1;
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    } else if (upsertResult.status === 'merged_by_dedupe') {
      result.added += 1;
      result.mergedByDedupe += 1;
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    } else if (upsertResult.status === 'merged_by_id_and_dedupe') {
      result.added += 1;
      result.mergedByIdAndDedupe += 1;
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    } else {
      result.rejectedByPool += 1;
      result.rejectedReasons[upsertResult.reason] = (result.rejectedReasons[upsertResult.reason] ?? 0) + 1;
    }
  }
  return result;
}

function emptyUpsertTracksResult(): UpsertTracksResult {
  return {
    added: 0,
    inserted: 0,
    mergedById: 0,
    mergedByDedupe: 0,
    mergedByIdAndDedupe: 0,
    invalid: 0,
    rejectedByPool: 0,
    rejectedReasons: {},
    skippedAvoidedArtists: 0,
    skippedArtistCap: 0
  };
}

function mergeUpsertTracksResult(target: UpsertTracksResult, source: UpsertTracksResult): void {
  target.added += source.added;
  target.inserted += source.inserted;
  target.mergedById += source.mergedById;
  target.mergedByDedupe += source.mergedByDedupe;
  target.mergedByIdAndDedupe += source.mergedByIdAndDedupe;
  target.invalid += source.invalid;
  target.rejectedByPool += source.rejectedByPool;
  target.skippedAvoidedArtists += source.skippedAvoidedArtists;
  target.skippedArtistCap += source.skippedArtistCap;
  for (const [reason, count] of Object.entries(source.rejectedReasons)) {
    if (!count) continue;
    const key = reason as CandidatePoolRejectReason;
    target.rejectedReasons[key] = (target.rejectedReasons[key] ?? 0) + count;
  }
}

function summarizeCandidateAdmission(result: UpsertTracksResult): string | null {
  const parts = [
    result.inserted > 0 ? `inserted=${result.inserted}` : '',
    result.mergedById > 0 ? `mergedById=${result.mergedById}` : '',
    result.mergedByDedupe > 0 ? `mergedByDedupe=${result.mergedByDedupe}` : '',
    result.mergedByIdAndDedupe > 0 ? `mergedByIdAndDedupe=${result.mergedByIdAndDedupe}` : '',
    result.invalid > 0 ? `invalid=${result.invalid}` : '',
    rejectedByPoolSummary(result),
    result.skippedAvoidedArtists > 0 ? `skippedAvoidedArtists=${result.skippedAvoidedArtists}` : '',
    result.skippedArtistCap > 0 ? `skippedArtistCap=${result.skippedArtistCap}` : ''
  ].filter(Boolean);

  return parts.length > 0 ? `candidate admission: ${parts.join('; ')}` : null;
}

function rejectedByPoolSummary(result: UpsertTracksResult): string {
  if (result.rejectedByPool === 0) return '';
  const reasons = Object.entries(result.rejectedReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return reasons
    ? `rejectedByPool=${result.rejectedByPool} (${reasons})`
    : `rejectedByPool=${result.rejectedByPool}`;
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

function filterExactSongSearchQueries(queries: string[]): { queries: string[]; skipped: number } {
  const kept: string[] = [];
  let skipped = 0;
  for (const query of uniqueStrings(queries)) {
    if (isExactSongSearchQuery(query)) {
      kept.push(query);
    } else {
      skipped += 1;
    }
  }
  return { queries: kept, skipped };
}

function isExactSongSearchQuery(query: string): boolean {
  const value = sanitizeSearchQuery(query);
  if (!value) return false;
  if (SEMANTIC_SONG_SEARCH_PATTERNS.some((pattern) => pattern.test(value))) return false;
  if (/^[\p{L}\p{N}'’().]+(?:\s+[—-]\s+|\s+--\s+)[\p{L}\p{N}'’().]+/u.test(value)) return true;
  if (value.includes(':')) return false;
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length > 8) return false;
  if (parts.some((part) => /[A-Z]/.test(part) || /[\u3400-\u9fffぁ-ゟ゠-ヿ가-힣]/.test(part))) {
    return true;
  }
  return parts.length >= 3;
}

function entityFromStoredRecord(entity: StoredMusicEntityRecord): MusicEntityHypothesis | null {
  if (entity.type === 'chart_item') {
    return null;
  }
  if (entity.type === 'track') {
    return {
      type: 'track',
      ...(entity.title ? { title: entity.title } : {}),
      ...(entity.artist ? { artist: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  if (entity.type === 'artist') {
    return {
      type: 'artist',
      ...(entity.title ? { name: entity.title } : entity.artist ? { name: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  if (entity.type === 'album') {
    return {
      type: 'album',
      ...(entity.title ? { title: entity.title } : {}),
      ...(entity.artist ? { artist: entity.artist } : {}),
      ...(entity.providerId ? { providerId: entity.providerId } : {})
    };
  }
  return {
    type: 'playlist',
    ...(entity.title ? { name: entity.title } : {}),
    ...(entity.providerId ? { providerId: entity.providerId } : {})
  };
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
