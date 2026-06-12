import { z } from 'zod';
import type { LlmCompleteOptions, LlmMessage, LlmResponse } from '../llm/client.js';
import { ncmTrackQualitySignalsSchema } from '../../shared/schema.js';
import { AUTO_FILL_BATCH_SIZE_MAX } from '../../shared/dj.js';

export const candidateSourceSchema = z.enum([
  'liked',
  'playlist',
  'plan',
  'search',
  'style_expansion',
  'trend'
]);

export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const musicAgentToolNameSchema = z.enum([
  'get_context_summary',
  'get_music_knowledge',
  'get_trend_context',
  'expand_queries',
  'recall_from_liked',
  'recall_from_playlists',
  'recall_from_plan_segment',
  'recall_from_ncm_search',
  'recall_from_entities',
  'recall_from_trending',
  'recall_from_style_expansion',
  'recall_auto_fill_mix',
  'rank_candidates',
  'diversify_candidates',
  'finalize_pick'
]);

export type MusicAgentToolName = z.infer<typeof musicAgentToolNameSchema>;

export const musicCandidateScoresSchema = z.object({
  intentMatch: z.number().min(0).max(1),
  tasteMatch: z.number().min(0).max(1),
  timeFit: z.number().min(0).max(1),
  planFit: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  recentPenalty: z.number().min(0),
  skipPenalty: z.number().min(0),
  sourceConfidence: z.number().min(0).max(1)
});

export type MusicCandidateScores = z.infer<typeof musicCandidateScoresSchema>;

export const titlePollutionSignalSchema = z.enum(['none', 'mild', 'strong']);

export const musicCandidateQualitySignalsSchema = ncmTrackQualitySignalsSchema.extend({
  titlePollution: titlePollutionSignalSchema.optional()
});

export type MusicCandidateQualitySignals = z.infer<typeof musicCandidateQualitySignalsSchema>;

export const musicCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artist: z.string().min(1),
  sources: z.array(candidateSourceSchema).min(1),
  evidence: z.array(z.string()).default([]),
  scores: musicCandidateScoresSchema,
  qualitySignals: musicCandidateQualitySignalsSchema.optional()
});

export type MusicCandidate = z.infer<typeof musicCandidateSchema>;

export const queryPlanSchema = z.object({
  exactTrackQueries: z.array(z.string()).default([]),
  intentQueries: z.array(z.string()).default([]),
  tasteAnchorQueries: z.array(z.string()).default([]),
  planQueries: z.array(z.string()).default([]),
  trendQueries: z.array(z.string()).default([]),
  explorationQueries: z.array(z.string()).default([]),
  styleHints: z.array(z.string()).default([]),
  listeningConstraints: z.array(z.string()).default([]),
  avoidArtists: z.array(z.string()).default([]),
  negativeTerms: z.array(z.string()).default([]),
  rationale: z.string().default('')
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const trendSourceSchema = z.enum([
  'ncm_search_hot',
  'ncm_toplist',
  'ncm_top_song',
  'ncm_personalized_newsong',
  'ncm_recommend_songs',
  'ncm_artist_toplist',
  'web_chart',
  'manual_cache'
]);

export type TrendSource = z.infer<typeof trendSourceSchema>;

export const trendTrackHintSchema = z.object({
  title: z.string().min(1),
  artist: z.string().min(1),
  source: trendSourceSchema,
  reason: z.string().default('')
});

export type TrendTrackHint = z.infer<typeof trendTrackHintSchema>;

export const trendContextSchema = z.object({
  fetchedAt: z.string(),
  locale: z.enum(['zh-CN', 'global']).default('zh-CN'),
  sources: z.array(trendSourceSchema).default([]),
  hotArtists: z.array(z.string()).default([]),
  hotStyles: z.array(z.string()).default([]),
  chartTrackHints: z.array(trendTrackHintSchema).default([]),
  confidence: z.number().min(0).max(1).default(0)
});

export type TrendContext = z.infer<typeof trendContextSchema>;

export const musicKnowledgeSliceSchema = z.object({
  styleAdjacency: z.array(z.string()).default([]),
  sceneRules: z.array(z.string()).default([]),
  queryTemplates: z.array(z.string()).default([]),
  sourceStyleSeeds: z.array(z.string()).default([]),
  diversityRules: z.array(z.string()).default([]),
  negativeMappings: z.array(z.string()).default([])
});

export type MusicKnowledgeSlice = z.infer<typeof musicKnowledgeSliceSchema>;

export const musicAgentContextSummarySchema = z.object({
  request: z.enum(['auto-fill', 'chat-recommend']),
  discoveryMode: z.enum(['explore', 'comfort']).default('explore'),
  currentUserText: z.string().default(''),
  actionQueries: z.array(z.string()).optional(),
  currentMoment: z.object({
    localTime: z.string(),
    daypart: z.string(),
    weather: z.string().nullable(),
    dailyTheme: z.string().optional()
  }),
  activeDirective: z.string().default(''),
  currentPlanSegment: z.string().nullable(),
  tasteSummary: z.string().default(''),
  recentPreferenceSummary: z.string().default(''),
  recentPlaySignals: z.string().default(''),
  queueStateSummary: z.string().default(''),
  recentArtistPenalties: z.array(z.object({
    artist: z.string().min(1),
    penalty: z.number().min(0)
  })).optional(),
  recentTrackPenalties: z.array(z.object({
    trackKey: z.string().min(1),
    title: z.string().min(1),
    artist: z.string().default(''),
    penalty: z.number().min(0)
  })).optional(),
  bannedSummary: z.string().default('')
});

export type MusicAgentContextSummary = z.infer<typeof musicAgentContextSummarySchema>;

export const agentTraceStepSchema = z.object({
  step: z.number().int().positive(),
  thoughtSummary: z.string(),
  tool: musicAgentToolNameSchema.optional(),
  toolInputSummary: z.string().optional(),
  observationSummary: z.string().optional(),
  requestedTool: z.string().optional(),
  executedTool: musicAgentToolNameSchema.optional(),
  rewriteReason: z.string().optional(),
  candidateCount: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative()
});

export type AgentTraceStep = z.infer<typeof agentTraceStepSchema>;

export const finalPickSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  artist: z.string().optional(),
  reason: z.string().min(1),
  source: candidateSourceSchema
});

export type FinalPick = z.infer<typeof finalPickSchema>;

export const finalPickDiagnosticsSchema = z.object({
  targetPickCount: z.number().int().nonnegative(),
  rawPickCount: z.number().int().nonnegative(),
  eligiblePickCount: z.number().int().nonnegative(),
  acceptedPickCount: z.number().int().nonnegative(),
  droppedPickCount: z.number().int().nonnegative(),
  titleMotifDroppedCount: z.number().int().nonnegative(),
  rankedBackfillCount: z.number().int().nonnegative(),
  rejectedPickCount: z.number().int().nonnegative()
});

export type FinalPickDiagnostics = z.infer<typeof finalPickDiagnosticsSchema>;

export const queryFunnelEntrySchema = z.object({
  query: z.string().min(1),
  normalizedQuery: z.string().min(1),
  source: candidateSourceSchema,
  searchedCount: z.number().int().nonnegative(),
  resultCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  scoreMultiplier: z.number().min(0),
  repeatPenalty: z.number().min(0),
  selectionRate: z.number().min(0).max(1).nullable()
});

export type QueryFunnelEntry = z.infer<typeof queryFunnelEntrySchema>;

export const candidateScoreTableRowSchema = z.object({
  rank: z.number().int().positive(),
  id: z.string().min(1),
  song: z.string(),
  artist: z.string(),
  sources: z.string(),
  baseScore: z.number(),
  artistPenalty: z.number(),
  trackPenalty: z.number(),
  repeatPenalty: z.number(),
  qualityPenalty: z.number(),
  titlePollutionPenalty: z.number(),
  adjustedScore: z.number()
});

export type CandidateScoreTableRow = z.infer<typeof candidateScoreTableRowSchema>;

export const rejectedPickSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1)
});

export type RejectedPick = z.infer<typeof rejectedPickSchema>;

export const musicAgentLoopOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_call'),
    tool: musicAgentToolNameSchema,
    input: z.record(z.unknown()).default({})
  }),
  z.object({
    type: z.literal('final'),
    say: z.string().min(1),
    picks: z.array(finalPickSchema).max(AUTO_FILL_BATCH_SIZE_MAX),
    rejected: z.array(rejectedPickSchema).default([])
  })
]);

export type MusicAgentLoopOutput = z.infer<typeof musicAgentLoopOutputSchema>;

export const musicAgentFinalOutputSchema = z.object({
  mode: z.enum(['pick_next', 'chat_recommend']),
  say: z.string().min(1),
  picks: z.array(finalPickSchema).min(1).max(AUTO_FILL_BATCH_SIZE_MAX),
  rejected: z.array(rejectedPickSchema).default([]),
  finalPickDiagnostics: finalPickDiagnosticsSchema.optional(),
  queryFunnel: z.array(queryFunnelEntrySchema).default([]),
  trace: z.array(agentTraceStepSchema).default([]),
  candidateScoreTable: z.array(candidateScoreTableRowSchema).default([])
});

export type MusicAgentFinalOutput = z.infer<typeof musicAgentFinalOutputSchema>;

export const musicAgentRunOutputSchema = z.discriminatedUnion('status', [
  musicAgentFinalOutputSchema.extend({
    status: z.literal('ok')
  }),
  z.object({
    status: z.enum(['aborted', 'empty_pool']),
    mode: z.enum(['pick_next', 'chat_recommend']),
    say: z.string().min(1),
    picks: z.array(finalPickSchema).length(0),
    rejected: z.array(rejectedPickSchema).default([]),
    finalPickDiagnostics: finalPickDiagnosticsSchema.optional(),
    queryFunnel: z.array(queryFunnelEntrySchema).default([]),
    trace: z.array(agentTraceStepSchema).default([]),
    candidateScoreTable: z.array(candidateScoreTableRowSchema).default([])
  })
]);

export type MusicAgentRunOutput = z.infer<typeof musicAgentRunOutputSchema>;

export type AgentBudget = {
  maxMs: number;
  maxSteps: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxNcmSearches: number;
  maxPlaylistFetches: number;
  maxTrendFetchMs: number;
  maxCandidates: number;
};

export type MusicAgentLlmClient = {
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmResponse>;
};
