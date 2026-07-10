import { z } from 'zod';
import type { LlmCompleteOptions, LlmMessage, LlmResponse } from '../llm/client.js';
import { ncmTrackQualitySignalsSchema } from '../../shared/schema.js';
import { AUTO_FILL_BATCH_SIZE_MAX } from '../../shared/dj.js';

export const candidateSourceSchema = z.enum([
  'liked',
  'playlist',
  'search',
  'style_expansion',
  'trend'
]);

export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const candidateProvenanceKindSchema = z.enum([
  'liked',
  'playlist',
  'exact_recall',
  'semantic_discovery',
  'web_hint_recall',
  'verified_entity',
  'trend_recall',
  'style_expansion'
]);

export type CandidateProvenanceKind = z.infer<typeof candidateProvenanceKindSchema>;

export const candidateProvenanceSchema = z.object({
  kind: candidateProvenanceKindSchema,
  source: candidateSourceSchema,
  detail: z.string().optional()
});

export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

export const musicAgentToolNameSchema = z.enum([
  'get_context_summary',
  'get_music_knowledge',
  'get_trend_context',
  'expand_queries',
  'recall_from_liked',
  'recall_from_playlists',
  'recall_from_ncm_search',
  'recall_from_entities',
  'recall_from_trending',
  'recall_from_style_expansion',
  'recall_auto_fill_mix',
  'web_music_discovery',
  'rank_candidates',
  'diversify_candidates',
  'finalize_pick'
]);

export type MusicAgentToolName = z.infer<typeof musicAgentToolNameSchema>;

export const musicCandidateScoresSchema = z.object({
  intentMatch: z.number().min(0).max(1),
  tasteMatch: z.number().min(0).max(1),
  timeFit: z.number().min(0).max(1),
  contextFit: z.number().min(0).max(1),
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
  provenance: z.array(candidateProvenanceSchema).optional(),
  evidence: z.array(z.string()).default([]),
  scores: musicCandidateScoresSchema,
  qualitySignals: musicCandidateQualitySignalsSchema.optional()
});

export type MusicCandidate = z.infer<typeof musicCandidateSchema>;

export const queryPlanSchema = z.object({
  exactTrackQueries: z.array(z.string()).default([]),
  artistAnchors: z.array(z.string()).default([]),
  albumAnchors: z.array(z.string()).default([]),
  playlistQueries: z.array(z.string()).default([]),
  intentQueries: z.array(z.string()).default([]),
  tasteAnchorQueries: z.array(z.string()).default([]),
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

export const webMusicDiscoveryFocusSchema = z.enum([
  'style_artists',
  'style_tracks',
  'similar_artists',
  'similar_tracks',
  'new_releases',
  'scene_overview'
]);

export type WebMusicDiscoveryFocus = z.infer<typeof webMusicDiscoveryFocusSchema>;

export const webMusicDiscoveryAnchorSchema = z.object({
  type: z.enum(['artist', 'track', 'album', 'style']),
  name: z.string().min(1),
  artist: z.string().min(1).optional()
});

export type WebMusicDiscoveryAnchor = z.infer<typeof webMusicDiscoveryAnchorSchema>;

export const webMusicDiscoveryInputSchema = z.object({
  intent: z.string().min(1),
  focus: webMusicDiscoveryFocusSchema,
  anchors: z.array(webMusicDiscoveryAnchorSchema).default([]),
  locale: z.enum(['zh-CN', 'global']).default('zh-CN'),
  freshness: z.enum(['durable', 'recent']).default('durable'),
  maxHints: z.number().int().positive().max(12).default(6)
});

export type WebMusicDiscoveryInput = z.infer<typeof webMusicDiscoveryInputSchema>;

export const musicEntityHintKindSchema = z.enum([
  'artist',
  'track',
  'album',
  'playlist',
  'chart_item',
  'relationship'
]);

export type MusicEntityHintKind = z.infer<typeof musicEntityHintKindSchema>;

export const musicEntityHintSchema = z.object({
  kind: musicEntityHintKindSchema,
  name: z.string().min(1),
  artist: z.string().min(1).optional(),
  relatedName: z.string().min(1).optional(),
  relationshipType: z.enum([
    'similar_to',
    'represents_style',
    'featured_in_scene',
    'recent_release'
  ]).optional(),
  styles: z.array(z.string().min(1)).default([]),
  sourceUrl: z.string().url(),
  sourceTitle: z.string().min(1).optional(),
  snippet: z.string().min(1),
  confidence: z.number().min(0).max(1),
  freshness: z.enum(['durable', 'fresh']),
  observedAt: z.string().min(1)
});

export type MusicEntityHint = z.infer<typeof musicEntityHintSchema>;

export const musicKnowledgeSliceSchema = z.object({
  styleAdjacency: z.array(z.string()).default([]),
  sceneRules: z.array(z.string()).default([]),
  queryTemplates: z.array(z.string()).default([]),
  sourceStyleSeeds: z.array(z.string()).default([]),
  diversityRules: z.array(z.string()).default([]),
  negativeMappings: z.array(z.string()).default([])
});

export type MusicKnowledgeSlice = z.infer<typeof musicKnowledgeSliceSchema>;

export const musicAgentPersonalDjContextSchema = z.object({
  summary: z.string().max(1200),
  currentState: z.object({
    activity: z.string().max(120).optional(),
    energy: z.enum(['low', 'medium', 'high']).optional(),
    attention: z.enum(['low_distraction', 'normal', 'high_stimulation']).optional(),
    mood: z.string().max(160).optional()
  }).strict().optional(),
  musicGuidance: z.object({
    energyCurve: z.enum(['downshift', 'steady', 'uplift', 'mixed']).optional(),
    preferredTextures: z.array(z.string().max(80)).max(12).default([]),
    avoidTextures: z.array(z.string().max(80)).max(12).default([]),
    vocalPreference: z.enum(['vocal', 'instrumental', 'mixed', 'unknown']).optional(),
    novelty: z.enum(['comfort', 'balanced', 'explore']).optional()
  }).strict(),
  musicHints: z.array(z.object({
    kind: z.enum(['artist', 'track', 'style', 'scene']),
    label: z.string().max(160),
    strength: z.enum(['weak', 'medium', 'strong']),
    reason: z.string().max(300)
  }).strict()).max(12).default([]),
  segueGuidance: z.object({
    tone: z.string().max(240).optional(),
    privacyRule: z.string().max(500)
  }).strict(),
  trend: z.array(z.object({
    uploadedAt: z.string(),
    summary: z.string().max(500),
    musicGuidance: z.object({
      energyCurve: z.enum(['downshift', 'steady', 'uplift', 'mixed']).optional(),
      preferredTextures: z.array(z.string().max(80)).max(12).default([]),
      avoidTextures: z.array(z.string().max(80)).max(12).default([]),
      vocalPreference: z.enum(['vocal', 'instrumental', 'mixed', 'unknown']).optional(),
      novelty: z.enum(['comfort', 'balanced', 'explore']).optional()
    }).strict(),
    musicHints: z.array(z.object({
      kind: z.enum(['artist', 'track', 'style', 'scene']),
      label: z.string().max(160),
      strength: z.enum(['weak', 'medium', 'strong']),
      reason: z.string().max(300)
    }).strict()).max(12).default([])
  }).strict()).max(20).default([])
}).strict();

export type MusicAgentPersonalDjContext = z.infer<typeof musicAgentPersonalDjContextSchema>;

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
  personalDjContext: musicAgentPersonalDjContextSchema.optional(),
  bannedSummary: z.string().default('')
});

export type MusicAgentContextSummary = z.infer<typeof musicAgentContextSummarySchema>;

export const agentTraceStepSchema = z.object({
  step: z.number().int().positive(),
  thoughtSummary: z.string(),
  tool: musicAgentToolNameSchema.optional(),
  toolInputSummary: z.string().optional(),
  observationSummary: z.string().optional(),
  observationData: z.record(z.unknown()).optional(),
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
  rejectedPickCount: z.number().int().nonnegative(),
  semanticConflictDroppedCount: z.number().int().nonnegative().default(0),
  qualityDroppedCount: z.number().int().nonnegative().default(0),
  unassessedDroppedCount: z.number().int().nonnegative().default(0),
  assessmentValidationFailureCount: z.number().int().nonnegative().default(0)
});

export type FinalPickDiagnostics = z.infer<typeof finalPickDiagnosticsSchema>;

const lyricsAwareDiagnosticsSchema = z.object({
  mode: z.enum(['off', 'shadow', 'enforce_fit', 'enforce_all']),
  enrichment: z.object({
    shortlistCount: z.number().int().nonnegative(), cacheHits: z.number().int().nonnegative(),
    cacheMisses: z.number().int().nonnegative(), lyricAttempted: z.number().int().nonnegative(),
    lyricSuccess: z.number().int().nonnegative(), lyricMissing: z.number().int().nonnegative(),
    lyricFail: z.number().int().nonnegative(), lyricTimeout: z.number().int().nonnegative(),
    lyricCancelled: z.number().int().nonnegative(), wikiAttempted: z.number().int().nonnegative(),
    wikiSuccess: z.number().int().nonnegative(), wikiFail: z.number().int().nonnegative(),
    wikiTimeout: z.number().int().nonnegative(), wikiCancelled: z.number().int().nonnegative(),
    cacheWriteFailed: z.number().int().nonnegative(), sampledChars: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(), deadlineReached: z.boolean()
  }).strict(),
  promptChars: z.number().int().nonnegative(),
  assessmentCoverageValid: z.boolean(),
  assessmentValidationProblems: z.array(z.string().max(160)).max(24),
  decisions: z.array(z.object({
    id: z.string().min(1),
    compatibility: z.enum(['compatible', 'uncertain', 'conflict']),
    compatibilityConfidence: z.enum(['low', 'medium', 'high']),
    quality: z.enum(['trusted', 'acceptable', 'suspicious']),
    eligible: z.boolean()
  }).strict()).max(12),
  allReturnedPicksAssessed: z.boolean(),
  enforcementApplied: z.boolean(),
  fallbackSuppressed: z.boolean()
}).strict();

export const queryFunnelEntrySchema = z.object({
  query: z.string().min(1),
  normalizedQuery: z.string().min(1),
  source: candidateSourceSchema,
  searchedCount: z.number().int().nonnegative(),
  resultCount: z.number().int().nonnegative(),
  uniqueResultCount: z.number().int().nonnegative().optional(),
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
  provenance: z.string().optional(),
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

// Kept local to avoid a runtime cycle: track-understanding imports candidate schemas
// from this module. This boundary deliberately mirrors its strict assessment schema.
const finalPickTrackAssessmentSchema = z.object({
  id: z.string().min(1),
  profile: z.object({
    genres: z.array(z.string().max(48)).max(8),
    moods: z.array(z.string().max(48)).max(8),
    energy: z.enum(['low', 'medium', 'high', 'unknown']),
    aggression: z.enum(['low', 'medium', 'high', 'unknown']),
    vocalIntensity: z.enum(['low', 'medium', 'high', 'unknown']),
    lyricThemes: z.array(z.string().max(80)).max(8),
    language: z.string().max(24)
  }).strict(),
  confidence: z.object({
    genres: z.number().min(0).max(1),
    moods: z.number().min(0).max(1),
    energy: z.number().min(0).max(1),
    aggression: z.number().min(0).max(1),
    vocalIntensity: z.number().min(0).max(1),
    lyricThemes: z.number().min(0).max(1),
    language: z.number().min(0).max(1)
  }).strict(),
  evidence: z.array(z.object({
    claim: z.string().max(160),
    source: z.enum([
      'wiki_tag',
      'lyric_analysis',
      'lyric_and_genre_analysis',
      'platform_metadata'
    ])
  }).strict()).max(12)
}).strict();

export const musicAgentFinalPickOutputSchema = z.object({
  type: z.literal('final'),
  say: z.string().min(1),
  picks: z.array(finalPickSchema).max(AUTO_FILL_BATCH_SIZE_MAX),
  rejected: z.array(rejectedPickSchema).default([]),
  assessments: z.array(finalPickTrackAssessmentSchema).default([])
});

export type MusicAgentFinalPickOutput = z.infer<typeof musicAgentFinalPickOutputSchema>;

export const musicAgentLoopOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_call'),
    tool: musicAgentToolNameSchema,
    input: z.record(z.unknown()).default({})
  }),
  musicAgentFinalPickOutputSchema
]);

export type MusicAgentLoopOutput = z.infer<typeof musicAgentLoopOutputSchema>;

export const musicAgentFinalOutputSchema = z.object({
  mode: z.enum(['pick_next', 'chat_recommend']),
  say: z.string().min(1),
  picks: z.array(finalPickSchema).min(1).max(AUTO_FILL_BATCH_SIZE_MAX),
  rejected: z.array(rejectedPickSchema).default([]),
  finalPickDiagnostics: finalPickDiagnosticsSchema.optional(),
  lyricsAwareDiagnostics: lyricsAwareDiagnosticsSchema.optional(),
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
    lyricsAwareDiagnostics: lyricsAwareDiagnosticsSchema.optional(),
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
