import { LlmClient, type LlmConfig } from '../llm/client.js';
import { getConfig } from '../config.js';
import { EmbeddingClient } from '../embedding/client.js';
import { getLogger } from '../logger.js';
import type { NcmClient } from '../ncm/client.js';
import {
  createMusicAgentSelectionAdapter,
  type MusicAgentSelectionAdapter
} from '../dj-memory/music-agent-adapter.js';
import { buildDjMemorySnapshot } from '../dj-memory/snapshot.js';
import { CandidatePool } from './candidates.js';
import { runMusicAgentLoop } from './loop.js';
import { createMusicAgentTools } from './tools.js';
import type { MusicAgentEmbeddingClient } from './semantic-recall.js';
import {
  createDefaultWebMusicDiscoveryProvider,
  type WebMusicDiscoveryProvider
} from './web-discovery.js';
import type { MusicAgentFallbackLogEvent } from './loop.js';
import type {
  AgentBudget,
  MusicAgentRuntimeContext,
  MusicAgentLlmClient,
  MusicAgentRunOutput,
  PromptJsonStatus
} from './schema.js';
import { parseAutoFillBatchSize } from '../../shared/dj.js';
import {
  createFinalShortlistAssessmentPersister,
  createFinalShortlistEnricher,
  type FinalShortlistEnricher,
  type TrackAssessmentPersister
} from './final-shortlist-enrichment.js';
import type { LyricsSelectionMode } from './track-understanding.js';
import { createSelectionDecisionRecorder } from './selection-policy/decision-trace.js';
import { buildSelectionPolicyReplayCases } from './selection-policy/replay-case.js';
import { rankOptionsFromContext } from './rank.js';
import { recordSelectionPolicyReplayCases } from '../store/selection-replay.js';
import type { SelectionDecision } from '../../shared/selection.js';
import { parseSelectionIntent } from './selection-intent.js';

const TRACK_ANALYZER_VERSION = 'lyrics-selection-v1';
const sharedDefaultFinalShortlistEnrichers = new WeakMap<
  NcmClient,
  Map<string, FinalShortlistEnricher>
>();

export type MusicAgentOptions = {
  llmClient?: MusicAgentLlmClient;
  llmConfig?: LlmConfig;
  embeddingClient?: MusicAgentEmbeddingClient | null;
  embeddingModel?: string | null;
  webMusicDiscoveryProvider?: WebMusicDiscoveryProvider | null;
  lyricsSelectionMode?: LyricsSelectionMode;
  finalShortlistEnricher?: FinalShortlistEnricher;
  persistTrackAssessments?: TrackAssessmentPersister;
  trackAnalysisModel?: string;
};

type EmbeddingRuntime = {
  client: MusicAgentEmbeddingClient;
  model: string;
};

export type MusicAgentFallbackStats = {
  totalRuns: number;
  convergenceRuns: number;
  fallbackRuns: number;
  fallbackRate: number;
  fallbackReasons: Partial<Record<MusicAgentFallbackLogEvent['reason'], number>>;
};

export type MusicAgentFallbackStatsTracker = {
  record(event: MusicAgentFallbackLogEvent): MusicAgentFallbackStats;
  snapshot(): MusicAgentFallbackStats;
};

export type PickNextInput = {
  userId: string;
  ncmClient: NcmClient;
  signal?: AbortSignal;
  includeDailyTheme?: boolean;
  excludeTrackIds?: Set<string>;
  excludeTrackDedupeKeys?: Set<string>;
  targetPickCount?: number;
  selectionAdapter?: MusicAgentSelectionAdapter;
  now?: Date;
  onProgress?: (progress: MusicAgentProgress) => void;
  replayRunId?: string;
  onReplayObservation?: (observation: {
    candidateCount: number;
    promptJsonStatus: PromptJsonStatus;
  }) => void;
};

export type MusicAgentProgressStage = 'recall' | 'filtering' | 'balancing' | 'finalizing';

export type MusicAgentProgress = {
  stage: MusicAgentProgressStage;
  selectionDecisions: SelectionDecision[];
  candidates: Array<{ id: string; name: string; artist: string }>;
};

type ChatRecommendAction = {
  pick?: {
    query?: string;
  };
};

export type ChatRecommendInput = {
  userId: string;
  ncmClient: NcmClient;
  userText: string;
  actions?: ChatRecommendAction[];
  signal?: AbortSignal;
  now?: Date;
  selectionAdapter?: MusicAgentSelectionAdapter;
};

export class MusicAgent {
  private readonly llmClient: MusicAgentLlmClient;
  private readonly fallbackLogger: ((event: MusicAgentFallbackLogEvent) => void) | undefined;
  private readonly embeddingRuntime: EmbeddingRuntime | null;
  private readonly webMusicDiscoveryProvider: WebMusicDiscoveryProvider | null;
  private readonly lyricsSelectionMode: LyricsSelectionMode;
  private readonly finalShortlistEnricher: FinalShortlistEnricher | undefined;
  private readonly persistTrackAssessments: TrackAssessmentPersister | undefined;
  private readonly trackAnalysisModel: string;
  private readonly defaultTrackAssessmentPersister: TrackAssessmentPersister | undefined;

  constructor(options: MusicAgentOptions = {}) {
    this.llmClient = resolveLlmClient(options);
    this.embeddingRuntime = resolveEmbeddingRuntime(options);
    this.webMusicDiscoveryProvider = resolveWebMusicDiscoveryProvider(options);
    this.lyricsSelectionMode = resolveLyricsSelectionMode(options);
    this.finalShortlistEnricher = options.finalShortlistEnricher;
    this.persistTrackAssessments = options.persistTrackAssessments;
    this.trackAnalysisModel = resolveTrackAnalysisModel(options);
    this.defaultTrackAssessmentPersister = this.lyricsSelectionMode === 'off'
      ? undefined
      : createFinalShortlistAssessmentPersister({
          analyzerVersion: TRACK_ANALYZER_VERSION,
          analysisModel: this.trackAnalysisModel
        });
    this.fallbackLogger = options.llmConfig
      ? (event) => {
          const logger = getLogger();
          const message = musicAgentRunLogMessage(event);
          const fallbackStats = musicAgentFallbackStats.record(event);
          const logEvent = projectMusicAgentFallbackEventForLog(event, fallbackStats);
          if (event.reason === 'ranked_tool_completed') {
            logger.info(logEvent, message);
          } else {
            logger.warn(logEvent, message);
          }
        }
      : undefined;
  }

  async pickNext(input: PickNextInput): Promise<MusicAgentRunOutput> {
    const targetPickCount = parseAutoFillBatchSize(input.targetPickCount);
    const budget = pickNextBudget(targetPickCount);
    const selectionAdapter = input.selectionAdapter ?? await buildSelectionAdapter({
      userId: input.userId,
      request: 'auto-fill',
      now: input.now,
      playedTrackIds: input.excludeTrackIds,
      playedTrackKeys: input.excludeTrackDedupeKeys
    });
    const context = selectionAdapter.runtimeContext;
    const selectionPolicyContext = selectionAdapter.policyContext;
    const selectionDecisionRecorder = createSelectionDecisionRecorder();
    const candidatePool = new CandidatePool({
      maxCandidates: budget.maxCandidates,
      selectionPolicyContext,
      selectionDecisionRecorder
    });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      budget,
      embeddingClient: this.embeddingRuntime?.client ?? null,
      embeddingModel: this.embeddingRuntime?.model ?? null,
      webMusicDiscoveryProvider: this.webMusicDiscoveryProvider,
      targetPickCount,
      selectionPressureForCandidate: selectionAdapter.pressureForCandidate,
      selectionPolicyContext,
      selectionDecisionRecorder
    });
    const finalShortlistEnricher = this.resolveFinalShortlistEnricher(input.ncmClient);
    const persistTrackAssessments = this.lyricsSelectionMode === 'off'
      ? undefined
      : this.persistTrackAssessments ?? this.defaultTrackAssessmentPersister;
    let promptJsonStatus: PromptJsonStatus = 'not_observed';

    try {
      const output = await runMusicAgentLoop({
        mode: 'pick_next',
        context,
        candidatePool,
        llmClient: this.llmClient,
        tools,
        budget,
        targetPickCount,
        signal: input.signal,
        lyricsSelectionMode: this.lyricsSelectionMode,
        finalShortlistEnricher,
        persistTrackAssessments,
        lyricsRequestScope: `ncm-user:${input.userId.trim()}`,
        fallbackLogger: this.fallbackLogger,
        selectionPolicyContext,
        selectionPressureForCandidate: selectionAdapter.pressureForCandidate,
        selectionDecisionRecorder,
        onPromptJsonValidation: (valid) => {
          promptJsonStatus = nextPromptJsonStatus(promptJsonStatus, valid);
        },
        onProgress: (stage) => input.onProgress?.({
          stage,
          selectionDecisions: selectionDecisionRecorder.snapshot(),
          candidates: candidatePool.list().slice(0, 8).map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            artist: candidate.artist
          }))
        })
      });
      return {
        ...output,
        promptJsonStatus,
        selectionDecisions: selectionDecisionRecorder.snapshot()
      };
    } finally {
      const replayCandidates = candidatePool.replayCandidates();
      input.onReplayObservation?.({
        candidateCount: replayCandidates.length,
        promptJsonStatus
      });
      if (input.replayRunId) {
        recordSelectionPolicyReplayCases({
          userId: input.userId,
          runId: input.replayRunId,
          mode: selectionPolicyContext.mode,
          cases: buildSelectionPolicyReplayCases({
            candidates: replayCandidates,
            context: selectionPolicyContext,
            batchLimit: targetPickCount,
            pressureForCandidate: selectionAdapter.pressureForCandidate,
            rankingOptions: rankOptionsFromContext(context, {
              pressureForCandidate: selectionAdapter.pressureForCandidate,
              selectionPolicyContext
            })
          }),
          ...(input.now ? { createdAt: input.now.toISOString() } : {})
        });
      }
    }
  }

  async recommendFromChat(input: ChatRecommendInput): Promise<MusicAgentRunOutput> {
    const budget = chatRecommendBudget();
    const selectionAdapter = input.selectionAdapter ?? await buildSelectionAdapter({
      userId: input.userId,
      request: 'chat-recommend',
      userText: input.userText,
      actionQueries: extractActionQueries(input.actions ?? []),
      now: input.now
    });
    const context = selectionAdapter.runtimeContext;
    const selectionPolicyContext = selectionAdapter.policyContext;
    const selectionDecisionRecorder = createSelectionDecisionRecorder();
    const candidatePool = new CandidatePool({
      maxCandidates: budget.maxCandidates,
      selectionPolicyContext,
      selectionDecisionRecorder
    });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      budget,
      embeddingClient: this.embeddingRuntime?.client ?? null,
      embeddingModel: this.embeddingRuntime?.model ?? null,
      webMusicDiscoveryProvider: this.webMusicDiscoveryProvider,
      selectionPressureForCandidate: selectionAdapter.pressureForCandidate,
      selectionPolicyContext,
      selectionDecisionRecorder
    });
    let promptJsonStatus: PromptJsonStatus = 'not_observed';

    const output = await runMusicAgentLoop({
      mode: 'chat_recommend',
      context,
      candidatePool,
      llmClient: this.llmClient,
      tools,
      budget,
      signal: input.signal,
      fallbackLogger: this.fallbackLogger,
      selectionPolicyContext,
      selectionPressureForCandidate: selectionAdapter.pressureForCandidate,
      selectionDecisionRecorder,
      onPromptJsonValidation: (valid) => {
        promptJsonStatus = nextPromptJsonStatus(promptJsonStatus, valid);
      }
    });
    return {
      ...output,
      promptJsonStatus,
      selectionDecisions: selectionDecisionRecorder.snapshot()
    };
  }

  private resolveFinalShortlistEnricher(ncmClient: NcmClient): FinalShortlistEnricher | undefined {
    if (this.lyricsSelectionMode === 'off') return undefined;
    if (this.finalShortlistEnricher) return this.finalShortlistEnricher;
    let byConfiguration = sharedDefaultFinalShortlistEnrichers.get(ncmClient);
    if (!byConfiguration) {
      byConfiguration = new Map();
      sharedDefaultFinalShortlistEnrichers.set(ncmClient, byConfiguration);
    }
    const key = `${this.lyricsSelectionMode}\u0000${TRACK_ANALYZER_VERSION}\u0000${this.trackAnalysisModel}`;
    const existing = byConfiguration.get(key);
    if (existing) return existing;
    const created = createFinalShortlistEnricher({
      ncmClient,
      mode: this.lyricsSelectionMode,
      analyzerVersion: TRACK_ANALYZER_VERSION,
      analysisModel: this.trackAnalysisModel
    });
    byConfiguration.set(key, created);
    return created;
  }
}

export function projectMusicAgentFallbackEventForLog(
  event: MusicAgentFallbackLogEvent,
  fallbackStats: MusicAgentFallbackStats
): Record<string, unknown> {
  return {
    reason: event.reason,
    mode: event.mode,
    status: event.status,
    candidateCount: event.candidateCount,
    pickCount: event.pickCount,
    step: event.step,
    llmCalls: event.llmCalls,
    toolCalls: event.toolCalls,
    elapsedMs: event.elapsedMs,
    budget: event.budget,
    finalPickDiagnostics: event.finalPickDiagnostics,
    queryCount: event.queryFunnel?.length ?? 0,
    candidateScoreTableCount: event.candidateScoreTableCount ?? 0,
    ...(event.webDiscoveryDiagnostics
      ? {
          webDiscoveryDiagnostics: {
            step: event.webDiscoveryDiagnostics.step,
            candidateCount: event.webDiscoveryDiagnostics.candidateCount,
            problemCount: event.webDiscoveryDiagnostics.problems?.length ?? 0
          }
        }
      : {}),
    ...(event.lyricsAwareDiagnostics
      ? {
          lyricsAwareDiagnostics: {
            mode: event.lyricsAwareDiagnostics.mode,
            assessmentCoverageValid: event.lyricsAwareDiagnostics.assessmentCoverageValid,
            assessmentValidationProblemCount:
              event.lyricsAwareDiagnostics.assessmentValidationProblems.length,
            decisionCount: event.lyricsAwareDiagnostics.decisions.length,
            promptChars: event.lyricsAwareDiagnostics.promptChars,
            enrichment: event.lyricsAwareDiagnostics.enrichment
          }
        }
      : {}),
    fallbackStats
  };
}

function nextPromptJsonStatus(
  current: PromptJsonStatus,
  valid: boolean
): PromptJsonStatus {
  if (!valid || current === 'invalid') return 'invalid';
  return 'valid';
}

async function buildSelectionAdapter(input: {
  userId: string;
  request: MusicAgentRuntimeContext['request'];
  userText?: string;
  actionQueries?: string[];
  now?: Date;
  playedTrackIds?: ReadonlySet<string>;
  playedTrackKeys?: ReadonlySet<string>;
}): Promise<MusicAgentSelectionAdapter> {
  const snapshot = await buildDjMemorySnapshot({ userId: input.userId, now: input.now });
  return createMusicAgentSelectionAdapter({
    snapshot,
    request: input.request,
    ...(input.userText !== undefined ? { userText: input.userText } : {}),
    ...(input.actionQueries !== undefined ? { actionQueries: input.actionQueries } : {}),
    ...(input.request === 'chat-recommend' && input.userText
      ? { selectionIntent: parseSelectionIntent(input.userText) }
      : {}),
    ...(input.playedTrackIds ? { playedTrackIds: input.playedTrackIds } : {}),
    ...(input.playedTrackKeys ? { playedTrackKeys: input.playedTrackKeys } : {})
  });
}

export function musicAgentRunLogMessage(event: MusicAgentFallbackLogEvent): string {
  return event.reason === 'ranked_tool_completed'
    ? 'MusicAgent ranked convergence'
    : 'MusicAgent ranked fallback';
}

export function createMusicAgentFallbackStatsTracker(): MusicAgentFallbackStatsTracker {
  const stats: MusicAgentFallbackStats = {
    totalRuns: 0,
    convergenceRuns: 0,
    fallbackRuns: 0,
    fallbackRate: 0,
    fallbackReasons: {}
  };

  return {
    record(event) {
      stats.totalRuns += 1;
      if (event.reason === 'ranked_tool_completed') {
        stats.convergenceRuns += 1;
      } else {
        stats.fallbackRuns += 1;
        stats.fallbackReasons[event.reason] = (stats.fallbackReasons[event.reason] ?? 0) + 1;
      }
      stats.fallbackRate = roundRate(stats.fallbackRuns / stats.totalRuns);
      return cloneFallbackStats(stats);
    },
    snapshot() {
      return cloneFallbackStats(stats);
    }
  };
}

const musicAgentFallbackStats = createMusicAgentFallbackStatsTracker();

function cloneFallbackStats(stats: MusicAgentFallbackStats): MusicAgentFallbackStats {
  return {
    ...stats,
    fallbackReasons: { ...stats.fallbackReasons }
  };
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractActionQueries(actions: ChatRecommendAction[]): string[] {
  return Array.from(
    new Set(
      actions
        .map((action) => action.pick?.query?.trim() ?? '')
        .filter((query) => query.length > 0)
    )
  );
}

function resolveLlmClient(options: MusicAgentOptions): MusicAgentLlmClient {
  if (options.llmClient) return options.llmClient;
  if (options.llmConfig) return new LlmClient(options.llmConfig);
  throw new Error('MusicAgent requires either llmClient or llmConfig.');
}

function resolveEmbeddingRuntime(options: MusicAgentOptions): EmbeddingRuntime | null {
  if ('embeddingClient' in options) {
    return options.embeddingClient && options.embeddingModel
      ? { client: options.embeddingClient, model: options.embeddingModel }
      : null;
  }

  try {
    const config = getConfig().embedding;
    return config
      ? { client: new EmbeddingClient(config), model: config.model }
      : null;
  } catch {
    return null;
  }
}

function resolveWebMusicDiscoveryProvider(options: MusicAgentOptions): WebMusicDiscoveryProvider | null {
  if ('webMusicDiscoveryProvider' in options) return options.webMusicDiscoveryProvider ?? null;
  return options.llmConfig ? createDefaultWebMusicDiscoveryProvider() : null;
}

function resolveLyricsSelectionMode(options: MusicAgentOptions): LyricsSelectionMode {
  if (options.lyricsSelectionMode) return options.lyricsSelectionMode;
  try {
    return getConfig().lyricsSelectionMode;
  } catch {
    return 'off';
  }
}

function resolveTrackAnalysisModel(options: MusicAgentOptions): string {
  if (options.trackAnalysisModel?.trim()) return options.trackAnalysisModel.trim();
  if (options.llmConfig?.model.trim()) return options.llmConfig.model.trim();
  try {
    return getConfig().llm.model;
  } catch {
    return 'music-agent-runtime-model';
  }
}

function pickNextBudget(targetPickCount = 2): AgentBudget {
  const largeBatch = targetPickCount >= 4;
  return {
    maxMs: largeBatch ? 150_000 : 120_000,
    maxSteps: 10,
    maxLlmCalls: largeBatch ? 12 : 10,
    maxToolCalls: largeBatch ? 12 : 10,
    maxNcmSearches: largeBatch ? 18 : 10,
    maxPlaylistFetches: 3,
    maxTrendFetchMs: 2_000,
    maxCandidates: largeBatch ? 160 : 120
  };
}

function chatRecommendBudget(): AgentBudget {
  return {
    maxMs: 50_000,
    maxSteps: 7,
    maxLlmCalls: 5,
    maxToolCalls: 7,
    maxNcmSearches: 7,
    maxPlaylistFetches: 2,
    maxTrendFetchMs: 0,
    maxCandidates: 80
  };
}
