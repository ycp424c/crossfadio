import { LlmClient, type LlmConfig } from '../llm/client.js';
import { getConfig } from '../config.js';
import { EmbeddingClient } from '../embedding/client.js';
import { getLogger } from '../logger.js';
import type { NcmClient } from '../ncm/client.js';
import { CandidatePool } from './candidates.js';
import { buildMusicAgentContext } from './context.js';
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
  MusicAgentContextSummary,
  MusicAgentLlmClient,
  MusicAgentRunOutput
} from './schema.js';
import { parseAutoFillBatchSize } from '../../shared/dj.js';
import { getActiveTemporaryQueueBanDedupeState } from '../store/temporary-bans.js';

export type MusicAgentOptions = {
  llmClient?: MusicAgentLlmClient;
  llmConfig?: LlmConfig;
  embeddingClient?: MusicAgentEmbeddingClient | null;
  embeddingModel?: string | null;
  webMusicDiscoveryProvider?: WebMusicDiscoveryProvider | null;
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
  context?: MusicAgentContextSummary;
  now?: Date;
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
};

export class MusicAgent {
  private readonly llmClient: MusicAgentLlmClient;
  private readonly fallbackLogger: ((event: MusicAgentFallbackLogEvent & { userId: string }) => void) | undefined;
  private readonly embeddingRuntime: EmbeddingRuntime | null;
  private readonly webMusicDiscoveryProvider: WebMusicDiscoveryProvider | null;

  constructor(options: MusicAgentOptions = {}) {
    this.llmClient = resolveLlmClient(options);
    this.embeddingRuntime = resolveEmbeddingRuntime(options);
    this.webMusicDiscoveryProvider = resolveWebMusicDiscoveryProvider(options);
    this.fallbackLogger = options.llmConfig
      ? (event) => {
          const logger = getLogger();
          const message = musicAgentRunLogMessage(event);
          const fallbackStats = musicAgentFallbackStats.record(event);
          const logEvent = { ...event, fallbackStats };
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
    const context = input.context ?? await buildMusicAgentContext({
      userId: input.userId,
      ncmClient: input.ncmClient,
      request: 'auto-fill',
      includeDailyTheme: input.includeDailyTheme,
      now: input.now
    });
    const temporaryBans = getActiveTemporaryQueueBanDedupeState(input.userId, input.now);
    const candidatePool = new CandidatePool({
      maxCandidates: budget.maxCandidates,
      bannedIds: mergeSets(input.excludeTrackIds, temporaryBans.ids),
      bannedTrackKeys: mergeSets(input.excludeTrackDedupeKeys, temporaryBans.dedupeKeys)
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
      targetPickCount
    });

    return runMusicAgentLoop({
      mode: 'pick_next',
      context,
      candidatePool,
      llmClient: this.llmClient,
      tools,
      budget,
      targetPickCount,
      signal: input.signal,
      fallbackLogger: this.withUserIdFallbackLogger(input.userId)
    });
  }

  async recommendFromChat(input: ChatRecommendInput): Promise<MusicAgentRunOutput> {
    const budget = chatRecommendBudget();
    const context = await buildMusicAgentContext({
      userId: input.userId,
      ncmClient: input.ncmClient,
      request: 'chat-recommend',
      userText: input.userText,
      actionQueries: extractActionQueries(input.actions ?? []),
      now: input.now
    });
    const candidatePool = new CandidatePool({
      maxCandidates: budget.maxCandidates
    });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      budget,
      embeddingClient: this.embeddingRuntime?.client ?? null,
      embeddingModel: this.embeddingRuntime?.model ?? null,
      webMusicDiscoveryProvider: this.webMusicDiscoveryProvider
    });

    return runMusicAgentLoop({
      mode: 'chat_recommend',
      context,
      candidatePool,
      llmClient: this.llmClient,
      tools,
      budget,
      signal: input.signal,
      fallbackLogger: this.withUserIdFallbackLogger(input.userId)
    });
  }

  private withUserIdFallbackLogger(userId: string) {
    if (!this.fallbackLogger) return undefined;
    return (event: MusicAgentFallbackLogEvent) => {
      this.fallbackLogger?.({ ...event, userId });
    };
  }
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

function mergeSets<T>(left: Set<T> | undefined, right: Set<T>): Set<T> {
  return new Set([...(left ?? []), ...right]);
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
