import { LlmClient, type LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import { CandidatePool } from './candidates.js';
import { buildMusicAgentContext } from './context.js';
import { runMusicAgentLoop } from './loop.js';
import { createMusicAgentTools } from './tools.js';
import type { AgentBudget, MusicAgentLlmClient, MusicAgentRunOutput } from './schema.js';

export type MusicAgentOptions = {
  llmClient?: MusicAgentLlmClient;
  llmConfig?: LlmConfig;
};

export type PickNextInput = {
  userId: string;
  ncmClient: NcmClient;
  signal?: AbortSignal;
  includeDailyTheme?: boolean;
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

  constructor(options: MusicAgentOptions = {}) {
    this.llmClient = resolveLlmClient(options);
  }

  async pickNext(input: PickNextInput): Promise<MusicAgentRunOutput> {
    const budget = pickNextBudget();
    const context = await buildMusicAgentContext({
      userId: input.userId,
      ncmClient: input.ncmClient,
      request: 'auto-fill',
      includeDailyTheme: input.includeDailyTheme,
      now: input.now
    });
    const candidatePool = new CandidatePool({ maxCandidates: budget.maxCandidates });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      budget
    });

    return runMusicAgentLoop({
      mode: 'pick_next',
      context,
      candidatePool,
      llmClient: this.llmClient,
      tools,
      budget,
      signal: input.signal
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
    const candidatePool = new CandidatePool({ maxCandidates: budget.maxCandidates });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      budget
    });

    return runMusicAgentLoop({
      mode: 'chat_recommend',
      context,
      candidatePool,
      llmClient: this.llmClient,
      tools,
      budget,
      signal: input.signal
    });
  }
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

function pickNextBudget(): AgentBudget {
  return {
    maxMs: 60_000,
    maxSteps: 8,
    maxLlmCalls: 5,
    maxToolCalls: 8,
    maxNcmSearches: 8,
    maxPlaylistFetches: 3,
    maxTrendFetchMs: 2_000,
    maxCandidates: 120
  };
}

function chatRecommendBudget(): AgentBudget {
  return {
    maxMs: 35_000,
    maxSteps: 5,
    maxLlmCalls: 3,
    maxToolCalls: 5,
    maxNcmSearches: 5,
    maxPlaylistFetches: 2,
    maxTrendFetchMs: 0,
    maxCandidates: 80
  };
}
