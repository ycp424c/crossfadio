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
  type MusicAgentToolName,
  type MusicCandidate,
  type MusicCandidateScores,
  type QueryFunnelEntry,
  type QueryPlan,
  type TrendContext
} from './schema.js';
import type { CandidatePool } from './candidates.js';
import type { CandidatePoolBanRejectReason } from './candidates.js';
import {
  countCandidateArtistKeys,
  sourceScores,
  upsertTracks,
  usesExternalQuality,
  type UpsertTracksResult
} from './candidate-admission.js';
import {
  recordUserQueryFunnel,
  sanitizeSearchQuery
} from './query-stats.js';
import {
  filterExactSongSearchQueries
} from './recall-query-filtering.js';
import { objectArrayValue } from './web-discovery-hints.js';
import { autoFillWebDiscoveryInput } from './web-discovery-planning.js';
import { runWebMusicDiscovery } from './web-discovery-run.js';
import {
  recallFromWebDiscoveryHints as runRecallFromWebDiscoveryHints
} from './web-hint-recall.js';
import {
  autoFillPlaylistQueries,
  autoFillSearchQueries,
  styleExpansionQueries,
  styleSeedQueryModifiers
} from './query-planning.js';
import { getLikedRecallTracks } from './liked-recall.js';
import {
  queryFunnelSnapshot,
  recordFinalQueryFunnel,
  recordQueryFunnelSnapshot,
  type QueryFunnelAccumulator
} from './query-funnel.js';
import type { FinalPick } from './schema.js';
import {
  entityArtistName,
  entityTitle,
  parseEntityRecallInput,
  type MusicEntityHypothesis
} from './entity-hypotheses.js';
import type { WebMusicDiscoveryProvider } from './web-discovery.js';
import {
  recallFromEntity,
  type EntityRecallNcmClient
} from './entity-recall.js';
import type { MusicAgentEmbeddingClient } from './semantic-recall.js';
import { runRecallFromQueries } from './query-recall.js';
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
  getQueryPlan?: () => QueryPlan | null;
  getQueryFunnel?: () => QueryFunnelEntry[];
  recordQueryFunnel?: () => void;
  recordFinalPicks?: (picks: FinalPick[]) => void;
};

type MusicAgentNcmClient = Pick<
  NcmClient,
  'getLikedSongIds' | 'getSongDetails' | 'searchSongs' | 'getPlaylistDetail'
> & Partial<TrendCapableNcmClient> & Partial<EntityRecallNcmClient>;

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
  stage: 'search' | 'entity_recall' | 'style_expansion' | 'trend' | 'web_discovery' | 'web_hint_recall';
  summary: string;
  candidateCount: number;
  problems: string[];
  data?: Record<string, unknown>;
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
const MAX_ENTITY_RECALL_LIMIT = 10;
const MAX_ENTITY_RECALL_COUNT = 8;
const MAX_ENTITY_RECALL_SCAN_COUNT = 16;
const AUTO_FILL_MAX_ARTIST_ENTITY_RECALLS = 3;
const AUTO_FILL_MAX_ALBUM_ENTITY_RECALLS = 2;
const AUTO_FILL_MAX_PLAYLIST_ENTITY_RECALLS = 3;
const AUTO_FILL_ARTIST_ENTITY_TRACK_LIMIT = 3;
const AUTO_FILL_ALBUM_ENTITY_TRACK_LIMIT = 4;
const AUTO_FILL_PLAYLIST_ENTITY_TRACK_LIMIT = 4;
const TREND_MAX_ARTIST_ENTITY_RECALLS = 4;
const TREND_ARTIST_ENTITY_TRACK_LIMIT = 3;
const MAX_RANK_DISPLAY_LIMIT = 20;
const MAX_DIVERSIFY_DISPLAY_LIMIT = 5;
const AVOID_ARTIST_PENALTY_THRESHOLD = 0.18;
const QUALITY_DETAIL_BATCH_LIMIT = 80;
const AUTO_FILL_MIN_RECALL_NON_LIKED_TARGET = 8;
const WEB_DISCOVERY_ENTITY_RECALL_LIMIT = 1;
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
    getQueryPlan: () => state.queryPlan,

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
        const artistCounts = countCandidateArtistKeys(input.candidatePool.list());
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
        const playlistQueries = uniqueStrings([
          ...stringArrayValue(toolInput.playlistQueries),
          ...stringArrayValue(toolInput.queries),
          ...stringArrayValue(toolInput.names),
          stringValue(toolInput.query),
          stringValue(toolInput.name)
        ]);
        if (playlistQueries.length === 0) {
          return observation(input.candidatePool, 'playlist recall skipped: no playlist ids.', [
            'no playlist ids provided'
          ]);
        }
        const limit = boundedPositiveInt(toolInput.limit, DEFAULT_ENTITY_RECALL_LIMIT, MAX_ENTITY_RECALL_LIMIT);
        const searchLimit = Math.min(limit, DEFAULT_ENTITY_SEARCH_LIMIT);
        const avoidArtists = contextAvoidArtistSet(input.context, state.queryPlan);
        const artistCounts = countCandidateArtistKeys(input.candidatePool.list());
        let added = 0;
        const problems: string[] = [];
        const queries = playlistQueries.slice(0, MAX_ENTITY_RECALL_COUNT);
        let attemptedQueryCount = 0;
        let stoppedReason: string | undefined;
        for (const query of queries) {
          if (signal?.aborted) return abortedObservation(input.candidatePool);
          const result = await recallFromEntity({
            entity: { type: 'playlist', name: query },
            ncmClient: input.ncmClient,
            candidatePool: input.candidatePool,
            context: input.context,
            limit,
            searchLimit,
            consumeNcmSearch: () => consumeNcmSearch(state, limits.maxNcmSearches),
            consumePlaylistFetch: () => consumePlaylistFetch(state, limits.maxPlaylistFetches),
            avoidArtists,
            artistCounts,
            provenanceKind: 'verified_entity',
            signal
          });
          attemptedQueryCount += 1;
          added += result.added;
          problems.push(...result.problems);
          if (isNcmSearchBudgetExhausted(result)) {
            stoppedReason = 'ncm_search_budget_exhausted';
            break;
          }
          if (isPlaylistFetchBudgetExhausted(result)) {
            stoppedReason = 'playlist_fetch_budget_exhausted';
            break;
          }
        }
        return observation(
          input.candidatePool,
          `playlist recall searched ${attemptedQueryCount} queries and added ${added} candidates.`,
          problems,
          {
            attemptedQueryCount,
            ...(stoppedReason ? { stoppedReason } : {})
          }
        );
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
      const avoidArtists = contextAvoidArtistSet(input.context, state.queryPlan);
      const selectedInput = selectEntityRecallInputs(parsedInput.entities, avoidArtists, input.candidatePool);
      const entities = selectedInput.entities;
      if (entities.length === 0) {
        const hadEntitiesBeforeFiltering = parsedInput.entities.length > 0;
        return observation(
          input.candidatePool,
          hadEntitiesBeforeFiltering
            ? 'entity recall skipped: all entities were filtered before recall.'
            : 'entity recall skipped: no entities.',
          [
            ...(hadEntitiesBeforeFiltering ? [] : ['no music entities provided']),
            ...parsedInput.problems,
            ...selectedInput.problems
          ],
          { prefilteredEntityCount: parsedInput.entities.length - entities.length }
        );
      }

      const limit = boundedPositiveInt(toolInput.limit, DEFAULT_ENTITY_RECALL_LIMIT, MAX_ENTITY_RECALL_LIMIT);
      const searchLimit = Math.min(limit, DEFAULT_ENTITY_SEARCH_LIMIT);
      const artistCounts = countCandidateArtistKeys(input.candidatePool.list());
      const problems: string[] = [...parsedInput.problems, ...selectedInput.problems];
      let added = 0;
      let attemptedEntityCount = 0;
      let productiveEntityCount = 0;
      let scannedEntityCount = 0;
      let stoppedReason: string | undefined;

      for (const entity of entities) {
        if (signal?.aborted) return abortedObservation(input.candidatePool);
        if (productiveEntityCount >= MAX_ENTITY_RECALL_COUNT) break;
        if (scannedEntityCount >= MAX_ENTITY_RECALL_SCAN_COUNT) {
          problems.push(`entity recall stopped after scanning ${MAX_ENTITY_RECALL_SCAN_COUNT} entities`);
          stoppedReason = 'scan_limit';
          break;
        }
        scannedEntityCount += 1;
        const result = await recallFromEntity({
          entity,
          ncmClient: input.ncmClient,
          candidatePool: input.candidatePool,
          context: input.context,
          limit,
          searchLimit,
          consumeNcmSearch: () => consumeNcmSearch(state, limits.maxNcmSearches),
          consumePlaylistFetch: () => consumePlaylistFetch(state, limits.maxPlaylistFetches),
          avoidArtists,
          artistCounts,
          provenanceKind: 'verified_entity',
          signal
        });
        attemptedEntityCount += 1;
        added += result.added;
        problems.push(...result.problems);
        if (result.added > 0) {
          productiveEntityCount += 1;
        }
        if (isNcmSearchBudgetExhausted(result)) {
          stoppedReason = 'ncm_search_budget_exhausted';
          break;
        }
      }

      return observation(
        input.candidatePool,
        `entity recall attempted ${attemptedEntityCount} entities, produced ${productiveEntityCount} productive entities, and added ${added} candidates.`,
        problems,
        {
          attemptedEntityCount,
          productiveEntityCount,
          scannedEntityCount,
          prefilteredEntityCount: parsedInput.entities.length - entities.length,
          ...(stoppedReason ? { stoppedReason } : {})
        }
      );
    },

    recall_from_trending: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      return recallFromTrend({
        toolInput,
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

      const entities = await recallAutoFillEntities({
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        maxPlaylistFetches: limits.maxPlaylistFetches,
        signal
      });
      addStage('entity_recall', entities);
      if (hasEnoughAutoFillNonLikedCandidates(input.candidatePool, input.targetPickCount)) {
        return finish();
      }

      const trend = await recallFromTrend({
        toolInput: {},
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
  const result = await runWebMusicDiscovery({
    toolInput: options.toolInput,
    userId: options.input.userId,
    context: options.input.context,
    candidates: options.input.candidatePool.list(),
    queryFunnel: queryFunnelSnapshot(options.state),
    webDiscoveryProvider: options.input.webMusicDiscoveryProvider,
    webDiscoveryCalled: options.state.webDiscoveryCalled,
    ncmSearches: options.state.ncmSearches,
    targetExternalCandidateCount: webDiscoveryTargetExternalCandidateCount(options.input),
    maxWebDiscoveryMs: options.input.maxWebDiscoveryMs,
    maxWebDiscoveryHints: options.input.maxWebDiscoveryHints,
    signal: options.signal
  });
  if (result.called) options.state.webDiscoveryCalled = true;
  if (result.aborted) return abortedObservation(options.input.candidatePool);
  return observation(options.input.candidatePool, result.summary, result.problems, result.data);
}

function webDiscoveryTargetExternalCandidateCount(input: CreateMusicAgentToolsInput): number {
  if (input.context.request === 'auto-fill') return autoFillRecallNonLikedTarget(input.targetPickCount);
  return Math.max(1, input.targetPickCount ?? 2);
}

async function recallAutoFillEntities(options: {
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  maxPlaylistFetches: number;
  signal?: AbortSignal;
}): Promise<ToolObservation> {
  const queryPlan = options.state.queryPlan;
  if (!queryPlan) {
    return observation(options.input.candidatePool, 'entity recall skipped: no query plan.');
  }
  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(options.input.context),
      ...queryPlan.avoidArtists
    ].flatMap(artistKeys)
  );
  const artistCounts = countCandidateArtistKeys(options.input.candidatePool.list());
  const entities = autoFillEntityHypotheses(options.input.context, queryPlan, avoidArtists);
  if (entities.length === 0) {
    return observation(options.input.candidatePool, 'entity recall skipped: no artist, album, or playlist anchors.');
  }

  let added = 0;
  const problems: string[] = [];
  const expanded: string[] = [];
  for (const item of entities) {
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    const result = await recallFromEntity({
      entity: item.entity,
      ncmClient: options.input.ncmClient,
      candidatePool: options.input.candidatePool,
      context: options.input.context,
      limit: item.limit,
      searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
      consumeNcmSearch: () => consumeNcmSearch(options.state, options.maxSearches),
      consumePlaylistFetch: () => consumePlaylistFetch(options.state, options.maxPlaylistFetches),
      avoidArtists,
      artistCounts,
      provenanceKind: 'verified_entity',
      signal: options.signal
    });
    added += result.added;
    expanded.push(`${item.entity.type}:${entityDisplayName(item.entity)}=${result.added}`);
    problems.push(...result.problems);
  }

  return observation(
    options.input.candidatePool,
    `entity recall expanded ${entities.length} anchors and added ${added} candidates: ${expanded.join('、')}.`,
    problems
  );
}

function autoFillEntityHypotheses(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan,
  avoidArtists: ReadonlySet<string>
): Array<{ entity: MusicEntityHypothesis; limit: number }> {
  const artistAnchors = uniqueStrings(queryPlan.artistAnchors)
    .filter((artist) => !artistKeys(artist).some((key) => avoidArtists.has(key)))
    .slice(0, AUTO_FILL_MAX_ARTIST_ENTITY_RECALLS)
    .map((name) => ({
      entity: { type: 'artist' as const, name },
      limit: AUTO_FILL_ARTIST_ENTITY_TRACK_LIMIT
    }));
  const albumAnchors = uniqueStrings(queryPlan.albumAnchors)
    .slice(0, AUTO_FILL_MAX_ALBUM_ENTITY_RECALLS)
    .map((title) => ({
      entity: { type: 'album' as const, title },
      limit: AUTO_FILL_ALBUM_ENTITY_TRACK_LIMIT
    }));
  const playlistAnchors = autoFillPlaylistQueries(context, queryPlan)
    .slice(0, AUTO_FILL_MAX_PLAYLIST_ENTITY_RECALLS)
    .map((name) => ({
      entity: { type: 'playlist' as const, name },
      limit: AUTO_FILL_PLAYLIST_ENTITY_TRACK_LIMIT
    }));
  return [...artistAnchors, ...playlistAnchors, ...albumAnchors];
}

function entityDisplayName(entity: MusicEntityHypothesis): string {
  return entity.name ?? entity.title ?? entity.query ?? entity.type;
}

async function recallFromTrend(options: {
  toolInput: Record<string, unknown>;
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  signal?: AbortSignal;
  limit: number;
}): Promise<ToolObservation> {
  const observations: ToolObservation[] = [];
  const queries = trendRecallQueries(options.state, options.toolInput);
  if (queries.length > 0) {
    observations.push(await recallFromQueries({
      queries,
      source: 'trend',
      evidencePrefix: '趋势线索',
      scores: sourceScores('trend', options.input.context),
      input: options.input,
      state: options.state,
      maxSearches: options.maxSearches,
      signal: options.signal,
      limit: options.limit
    }));
  }

  if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
  const artistObservation = await recallTrendArtistEntities(options);
  if (artistObservation) observations.push(artistObservation);

  if (observations.length === 0) {
    return observation(
      options.input.candidatePool,
      'trend recall skipped: no trend track or artist inputs.',
      ['no trend recall inputs available']
    );
  }
  if (observations.length === 1) return observations[0];

  return observation(
    options.input.candidatePool,
    observations.map((item) => item.summary).join(' | '),
    observations.flatMap((item) => item.problems ?? [])
  );
}

async function recallTrendArtistEntities(options: {
  input: CreateMusicAgentToolsInput;
  state: ToolState;
  maxSearches: number;
  signal?: AbortSignal;
  limit: number;
}): Promise<ToolObservation | null> {
  const hotArtists = uniqueStrings(options.state.trendContext?.hotArtists ?? []);
  if (hotArtists.length === 0) return null;

  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(options.input.context),
      ...(options.state.queryPlan?.avoidArtists ?? [])
    ].flatMap(artistKeys)
  );
  const artistCounts = countCandidateArtistKeys(options.input.candidatePool.list());
  const entities = hotArtists
    .filter((artist) => !artistKeys(artist).some((key) => avoidArtists.has(key)))
    .slice(0, TREND_MAX_ARTIST_ENTITY_RECALLS)
    .map((name) => ({ type: 'artist' as const, name }));
  if (entities.length === 0) {
    return observation(options.input.candidatePool, 'trend artist entity recall skipped: all hot artists are avoided.');
  }

  let added = 0;
  const problems: string[] = [];
  const expanded: string[] = [];
  const limit = Math.min(options.limit, TREND_ARTIST_ENTITY_TRACK_LIMIT);
  for (const entity of entities) {
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    const result = await recallFromEntity({
      entity,
      ncmClient: options.input.ncmClient,
      candidatePool: options.input.candidatePool,
      context: options.input.context,
      limit,
      searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
      consumeNcmSearch: () => consumeNcmSearch(options.state, options.maxSearches),
      consumePlaylistFetch: () => consumePlaylistFetch(options.state, options.input.budget.maxPlaylistFetches),
      avoidArtists,
      artistCounts,
      source: 'trend',
      provenanceKind: 'trend_recall',
      signal: options.signal
    });
    added += result.added;
    expanded.push(`${entity.name}=${result.added}`);
    problems.push(...result.problems);
  }

  return observation(
    options.input.candidatePool,
    `trend artist entity recall expanded ${entities.length} artists and added ${added} candidates: ${expanded.join('、')}.`,
    problems
  );
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
  const avoidArtists = new Set(
    [
      ...avoidArtistsFromContext(options.input.context),
      ...(options.state.queryPlan?.avoidArtists ?? [])
    ].flatMap(artistKeys)
  );
  return runRecallFromWebDiscoveryHints({
    hints: options.hints,
    ncmClient: options.input.ncmClient,
    candidatePool: options.input.candidatePool,
    context: options.input.context,
    queryPlan: options.state.queryPlan,
    avoidArtists,
    consumeNcmSearch: () => consumeNcmSearch(options.state, options.maxSearches),
    consumePlaylistFetch: () => consumePlaylistFetch(options.state, options.maxPlaylistFetches),
    signal: options.signal,
    limit: options.limit
  });
}

function trendRecallQueries(state: ToolState, toolInput: Record<string, unknown>): string[] {
  const trendContext = state.trendContext;
  const trendQueries = trendContext
    ? [
        ...trendContext.chartTrackHints.map((hint) => `${hint.title} ${hint.artist}`)
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
    artistAnchors: uniqueStrings(plan.artistAnchors.map(sanitizeSearchQuery)),
    albumAnchors: uniqueStrings(plan.albumAnchors.map(sanitizeSearchQuery)),
    playlistQueries: uniqueStrings(plan.playlistQueries.map(sanitizeSearchQuery)),
    intentQueries: uniqueStrings(plan.intentQueries.map(sanitizeSearchQuery)),
    tasteAnchorQueries: uniqueStrings(plan.tasteAnchorQueries.map(sanitizeSearchQuery)),
    trendQueries: uniqueStrings(plan.trendQueries.map(sanitizeSearchQuery)),
    explorationQueries: uniqueStrings(plan.explorationQueries.map(sanitizeSearchQuery)),
    styleHints: uniqueStrings(plan.styleHints.map(sanitizeSearchQuery)),
    listeningConstraints: uniqueStrings(plan.listeningConstraints.map(sanitizeSearchQuery))
  });
}

function hasQueryPlanRecallQueries(plan: QueryPlan): boolean {
  return [
    ...plan.exactTrackQueries,
    ...plan.artistAnchors,
    ...plan.albumAnchors,
    ...plan.playlistQueries,
    ...plan.intentQueries,
    ...plan.tasteAnchorQueries,
    ...plan.trendQueries,
    ...plan.explorationQueries
  ].some((query) => sanitizeSearchQuery(query).length > 0);
}

function mergeQueryPlans(base: QueryPlan, overlay: QueryPlan): QueryPlan {
  return queryPlanSchema.parse({
    exactTrackQueries: overlay.exactTrackQueries.length > 0 ? overlay.exactTrackQueries : base.exactTrackQueries,
    artistAnchors: overlay.artistAnchors.length > 0 ? overlay.artistAnchors : base.artistAnchors,
    albumAnchors: overlay.albumAnchors.length > 0 ? overlay.albumAnchors : base.albumAnchors,
    playlistQueries: overlay.playlistQueries.length > 0 ? overlay.playlistQueries : base.playlistQueries,
    intentQueries: overlay.intentQueries.length > 0 ? overlay.intentQueries : base.intentQueries,
    tasteAnchorQueries: overlay.tasteAnchorQueries.length > 0 ? overlay.tasteAnchorQueries : base.tasteAnchorQueries,
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

function contextAvoidArtistSet(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null
): Set<string> {
  return new Set(
    [
      ...avoidArtistsFromContext(context),
      ...(queryPlan?.avoidArtists ?? [])
    ].flatMap(artistKeys)
  );
}

function selectEntityRecallInputs(
  entities: MusicEntityHypothesis[],
  avoidArtists: ReadonlySet<string>,
  candidatePool: CandidatePool
): { entities: MusicEntityHypothesis[]; problems: string[] } {
  let skippedAvoided = 0;
  const skippedBanned = new Map<CandidatePoolBanRejectReason, number>();
  const selected: MusicEntityHypothesis[] = [];
  for (const entity of entities) {
    if (isAvoidedEntityRecallInput(entity, avoidArtists)) {
      skippedAvoided += 1;
      continue;
    }
    const banReason = entityBanRejectReason(entity, candidatePool);
    if (banReason) {
      skippedBanned.set(banReason, (skippedBanned.get(banReason) ?? 0) + 1);
      continue;
    }
    selected.push(entity);
  }
  const skippedBannedTotal = [...skippedBanned.values()].reduce((sum, count) => sum + count, 0);
  return {
    entities: selected,
    problems: [
      ...(skippedAvoided > 0 ? [`skipped ${skippedAvoided} entity queries for recently repeated artists`] : []),
      ...(skippedBannedTotal > 0
        ? [`skipped ${skippedBannedTotal} entity queries already blocked by candidate bans (${formatReasonCounts(skippedBanned)})`]
        : [])
    ]
  };
}

function isAvoidedEntityRecallInput(
  entity: MusicEntityHypothesis,
  avoidArtists: ReadonlySet<string>
): boolean {
  const artist = entity.type === 'artist'
    ? entityArtistName(entity)
    : entity.type === 'track' || entity.type === 'album'
      ? entity.artist ?? ''
      : '';
  return artist.length > 0 && artistKeys(artist).some((key) => avoidArtists.has(key));
}

function entityBanRejectReason(
  entity: MusicEntityHypothesis,
  candidatePool: CandidatePool
): CandidatePoolBanRejectReason | null {
  if (entity.type !== 'track') return null;
  const id = entity.providerId ?? entity.id ?? '';
  const title = entityTitle(entity);
  const artist = entity.artist ?? '';
  if (!id && (!title || !artist)) return null;
  return candidatePool.rejectReasonForTrack({ id, name: title, artist });
}

function formatReasonCounts(reasons: ReadonlyMap<string, number>): string {
  return [...reasons.entries()]
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
}

function isNcmSearchBudgetExhausted(result: { problems: string[] }): boolean {
  return result.problems.includes('NCM search budget exhausted');
}

function isPlaylistFetchBudgetExhausted(result: { problems: string[] }): boolean {
  return result.problems.includes('playlist fetch budget exhausted');
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
  const avoidArtists = contextAvoidArtistSet(options.input.context, options.state.queryPlan);
  const result = await runRecallFromQueries({
    queries: options.queries,
    source: options.source,
    evidencePrefix: options.evidencePrefix,
    scores: options.scores,
    userId: options.input.userId,
    ncmClient: options.input.ncmClient,
    candidatePool: options.input.candidatePool,
    context: options.input.context,
    queryPlan: options.state.queryPlan,
    queryState: options.state,
    embeddingClient: options.input.embeddingClient,
    embeddingModel: options.input.embeddingModel,
    avoidArtists,
    consumeNcmSearch: () => consumeNcmSearch(options.state, options.maxSearches),
    consumePlaylistFetch: () => consumePlaylistFetch(options.state, options.input.budget.maxPlaylistFetches),
    signal: options.signal,
    limit: options.limit
  });
  if (result.aborted) return abortedObservation(options.input.candidatePool);
  return observation(options.input.candidatePool, result.summary, result.problems);
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
    plan.artistAnchors.length ? `artists=${plan.artistAnchors.join('、')}` : '',
    plan.albumAnchors.length ? `albums=${plan.albumAnchors.join('、')}` : '',
    plan.playlistQueries.length ? `playlists=${plan.playlistQueries.join('、')}` : '',
    plan.intentQueries.length ? `intent=${plan.intentQueries.join('、')}` : '',
    plan.tasteAnchorQueries.length ? `taste=${plan.tasteAnchorQueries.join('、')}` : '',
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
  const exactTrackQueries = filterExactSongSearchQueries([
    ...explicitQueries
  ]).queries;

  return queryPlanSchema.parse({
    exactTrackQueries,
    artistAnchors: [],
    albumAnchors: [],
    playlistQueries: [],
    intentQueries: explicitQueries,
    tasteAnchorQueries: [],
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
