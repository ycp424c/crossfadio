import type { NcmClient } from '../ncm/client.js';
import { getMusicKnowledgeSlice } from './knowledge.js';
import { diversifyCandidates, scoreCandidate } from './rank.js';
import { buildTrendContext, type TrendCapableNcmClient } from './trends.js';
import {
  queryPlanSchema,
  type AgentBudget,
  type CandidateSource,
  type MusicAgentContextSummary,
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

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>>;

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
};

type ToolState = {
  queryPlan: QueryPlan | null;
  trendContext: TrendContext | null;
  ncmSearches: number;
  playlistFetches: number;
};

const SUMMARY_MAX_CHARS = 900;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_LIKED_RECALL_LIMIT = 60;
const MAX_SEARCH_RECALL_LIMIT = 20;
const MAX_TREND_RECALL_LIMIT = 10;
const MAX_STYLE_EXPANSION_RECALL_LIMIT = 10;
const MAX_RANK_DISPLAY_LIMIT = 20;
const MAX_DIVERSIFY_DISPLAY_LIMIT = 5;

export function createMusicAgentTools(input: CreateMusicAgentToolsInput): MusicAgentToolRegistry {
  const state: ToolState = {
    queryPlan: null,
    trendContext: null,
    ncmSearches: 0,
    playlistFetches: 0
  };
  const limits = {
    maxNcmSearches: input.maxNcmSearches ?? input.budget.maxNcmSearches,
    maxPlaylistFetches: input.maxPlaylistFetches ?? input.budget.maxPlaylistFetches,
    maxTrendFetchMs: input.maxTrendFetchMs ?? input.budget.maxTrendFetchMs
  };

  return {
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
      if (limits.maxTrendFetchMs <= 0) {
        return observation(input.candidatePool, 'trend context skipped: trend fetch budget is 0.', [
          'trend fetch budget exhausted'
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
      state.queryPlan = parsed.success ? parsed.data : defaultQueryPlan(input.context, toolInput);
      return observation(input.candidatePool, summarizeQueryPlan(state.queryPlan), parsed.success ? [] : [
        'invalid query plan input; using context-derived defaults'
      ]);
    },

    recall_from_liked: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = boundedPositiveInt(toolInput.limit, 30, MAX_LIKED_RECALL_LIMIT);
      try {
        const ids = (await input.ncmClient.getLikedSongIds()).slice(0, limit).map(String);
        if (signal?.aborted) return abortedObservation(input.candidatePool);
        if (ids.length === 0) {
          return observation(input.candidatePool, 'liked recall found no liked ids.');
        }
        const tracks = await input.ncmClient.getSongDetails(ids);
        const added = upsertTracks(input.candidatePool, tracks, 'liked', {
          evidence: '网易云红心歌曲',
          scores: sourceScores('liked')
        });
        return observation(input.candidatePool, `liked recall added ${added} candidates from ${ids.length} ids.`);
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
            scores: sourceScores('playlist')
          });
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
        scores: sourceScores('plan'),
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
        scores: sourceScores('search'),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_RECALL_LIMIT)
      });
    },

    recall_from_trending: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const trendContext = state.trendContext;
      const trendQueries = trendContext
        ? [
            ...trendContext.chartTrackHints.map((hint) => `${hint.title} ${hint.artist}`),
            ...trendContext.hotStyles,
            ...trendContext.hotArtists
          ]
        : state.queryPlan?.trendQueries ?? [];
      return recallFromQueries({
        queries: uniqueStrings([...stringArrayValue(toolInput.queries), ...trendQueries]).slice(0, 8),
        source: 'trend',
        evidencePrefix: '趋势线索',
        scores: sourceScores('trend'),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, 5, MAX_TREND_RECALL_LIMIT)
      });
    },

    recall_from_style_expansion: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const text = [
        stringValue(toolInput.text),
        input.context.currentUserText,
        input.context.activeDirective,
        input.context.tasteSummary,
        input.context.recentPreferenceSummary
      ].filter(Boolean).join(' ');
      const knowledge = getMusicKnowledgeSlice({
        text,
        daypart: input.context.currentMoment.daypart
      });
      const queries = uniqueStrings([
        ...knowledge.queryTemplates,
        ...knowledge.styleAdjacency,
        ...stringArrayValue(toolInput.queries)
      ]).slice(0, 8);
      return recallFromQueries({
        queries,
        source: 'style_expansion',
        evidencePrefix: '风格扩展',
        scores: sourceScores('style_expansion'),
        input,
        state,
        maxSearches: limits.maxNcmSearches,
        signal,
        limit: boundedPositiveInt(toolInput.limit, 5, MAX_STYLE_EXPANSION_RECALL_LIMIT)
      });
    },

    rank_candidates: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = boundedPositiveInt(toolInput.limit, 8, MAX_RANK_DISPLAY_LIMIT);
      const top = input.candidatePool.topBy(scoreCandidate, limit);
      return observation(input.candidatePool, summarizeCandidates('ranked candidates', top));
    },

    diversify_candidates: async (toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const limit = boundedPositiveInt(toolInput.limit, 2, MAX_DIVERSIFY_DISPLAY_LIMIT);
      const diversified = diversifyCandidates(input.candidatePool.topBy(scoreCandidate, 20), limit);
      return observation(input.candidatePool, summarizeCandidates('diversified candidates', diversified));
    },

    finalize_pick: async (_toolInput, signal) => {
      if (signal?.aborted) return abortedObservation(input.candidatePool);
      const top = input.candidatePool.topBy(scoreCandidate, 5);
      return observation(input.candidatePool, summarizeCandidates('finalize candidates', top));
    }
  };
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
  const queries = uniqueStrings(options.queries).filter(Boolean);
  if (queries.length === 0) {
    return observation(options.input.candidatePool, `${options.evidencePrefix} recall skipped: no queries.`, [
      'no search queries available'
    ]);
  }

  let added = 0;
  const searched: string[] = [];
  const problems: string[] = [];

  for (const query of queries) {
    if (options.signal?.aborted) return abortedObservation(options.input.candidatePool);
    if (!consumeNcmSearch(options.state, options.maxSearches)) {
      problems.push('NCM search budget exhausted');
      break;
    }
    try {
      const tracks = await options.input.ncmClient.searchSongs(query, options.limit ?? DEFAULT_SEARCH_LIMIT);
      searched.push(query);
      added += upsertTracks(options.input.candidatePool, tracks, options.source, {
        evidence: `${options.evidencePrefix}: ${query}`,
        scores: options.scores
      });
    } catch (error) {
      problems.push(`${query}: ${formatError(error)}`);
    }
  }

  return observation(
    options.input.candidatePool,
    `${options.evidencePrefix} recall searched ${searched.length} queries and added ${added} candidates: ${searched.join('、') || 'none'}.`,
    problems
  );
}

function upsertTracks(
  pool: CandidatePool,
  tracks: NcmTrackLike[],
  source: CandidateSource,
  options: { evidence: string; scores: MusicCandidateScores }
): number {
  let added = 0;
  for (const track of tracks) {
    const candidate = candidateFromTrack(track, source, options);
    if (!candidate) continue;
    const before = pool.count();
    pool.upsert(candidate);
    if (pool.count() > before || pool.has(candidate.id)) {
      added += 1;
    }
  }
  return added;
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
    scores: { ...options.scores }
  };
}

function sourceScores(source: CandidateSource): MusicCandidateScores {
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
    return { ...base, intentMatch: 0.68, tasteMatch: 0.92, sourceConfidence: 0.86, novelty: 0.35 };
  }
  if (source === 'playlist') {
    return { ...base, tasteMatch: 0.78, sourceConfidence: 0.76 };
  }
  if (source === 'plan') {
    return { ...base, intentMatch: 0.76, planFit: 0.86, sourceConfidence: 0.7 };
  }
  if (source === 'trend') {
    return { ...base, intentMatch: 0.58, tasteMatch: 0.45, novelty: 0.72, sourceConfidence: 0.64 };
  }
  if (source === 'style_expansion') {
    return { ...base, intentMatch: 0.74, novelty: 0.68, sourceConfidence: 0.62 };
  }
  return base;
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
    plan.negativeTerms.length ? `negative=${plan.negativeTerms.join('、')}` : '',
    plan.rationale ? `rationale=${plan.rationale}` : ''
  ].filter(Boolean).join('; ') || 'query plan is empty.', SUMMARY_MAX_CHARS);
}

function summarizeCandidates(label: string, candidates: MusicCandidate[]): string {
  if (candidates.length === 0) return `${label}: candidate pool is empty.`;
  return truncate(
    `${label}: ${candidates.map((candidate) => `${candidate.id}:${candidate.name}-${candidate.artist}`).join(' | ')}`,
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
      ...knowledge.queryTemplates.slice(0, 4)
    ]),
    tasteAnchorQueries: uniqueStrings(knowledge.styleAdjacency.slice(0, 4)),
    planQueries: extractPlanQueries(context.currentPlanSegment),
    trendQueries: [],
    explorationQueries: uniqueStrings(knowledge.styleAdjacency.slice(0, 3)),
    negativeTerms: knowledge.negativeMappings,
    rationale: 'context-derived fallback query plan'
  });
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
