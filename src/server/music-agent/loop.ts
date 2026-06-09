import { buildLoopMessages } from './prompts.js';
import { CandidatePool, validateFinalPicks } from './candidates.js';
import { diversifyCandidates, rankCandidates, scoreCandidate } from './rank.js';
import {
  musicAgentLoopOutputSchema,
  musicAgentToolNameSchema,
  type AgentBudget,
  type AgentTraceStep,
  type FinalPick,
  type MusicAgentContextSummary,
  type MusicAgentFinalOutput,
  type MusicAgentLlmClient,
  type MusicAgentRunOutput,
  type MusicAgentToolName
} from './schema.js';
import type { MusicAgentToolRegistry, ToolObservation } from './tools.js';

export type RunMusicAgentLoopInput = {
  llmClient: MusicAgentLlmClient;
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  tools: MusicAgentToolRegistry;
  budget: AgentBudget;
  mode?: MusicAgentFinalOutput['mode'];
  signal?: AbortSignal;
  fallbackLogger?: MusicAgentFallbackLogger;
};

export type MusicAgentFallbackReason =
  | 'budget_reached'
  | 'llm_response_timeout'
  | 'final_rejected'
  | 'tool_budget_exhausted'
  | 'ranked_tool_completed';

export type MusicAgentFallbackLogEvent = {
  reason: MusicAgentFallbackReason;
  mode: MusicAgentFinalOutput['mode'];
  status: MusicAgentRunOutput['status'];
  candidateCount: number;
  pickCount: number;
  step: number;
  llmCalls: number;
  toolCalls: number;
  elapsedMs: number;
  budget: AgentBudget;
  lastTraceStep?: AgentTraceStep;
};

export type MusicAgentFallbackLogger = (event: MusicAgentFallbackLogEvent) => void;

type ParsedLoopOutput =
  | { type: 'tool_call'; tool: string; input: Record<string, unknown> }
  | { type: 'final'; say: string; picks: FinalPick[]; rejected?: Array<{ id: string; reason: string }> };

type LoopObservation = ToolObservation & {
  tool?: string;
};

const DEFAULT_TOOL_NAME = 'rank_candidates';

const DEFAULT_TOOL_CALL: ParsedLoopOutput = {
  type: 'tool_call',
  tool: DEFAULT_TOOL_NAME,
  input: {}
};

const MAX_TRACE_INPUT_CHARS = 180;
const MAX_TRACE_OBSERVATION_CHARS = 240;
const CONVERGENCE_TOOL_NAMES = new Set<MusicAgentToolName>([
  'rank_candidates',
  'diversify_candidates',
  'finalize_pick'
]);
const AUTO_FILL_NON_LIKED_CONVERGENCE_TARGET = 8;
const AUTO_FILL_TOTAL_CONVERGENCE_TARGET = 18;
const AUTO_FILL_MIX_TOOL_NAMES: MusicAgentToolName[] = [
  'expand_queries',
  'recall_from_ncm_search',
  'recall_from_style_expansion',
  'recall_from_trending'
];
const AUTO_FILL_AGGREGATE_TOOL_NAME: MusicAgentToolName = 'recall_auto_fill_mix';

export async function runMusicAgentLoop(input: RunMusicAgentLoopInput): Promise<MusicAgentRunOutput> {
  const startedAt = Date.now();
  const observations: LoopObservation[] = [];
  const trace: AgentTraceStep[] = [];
  let llmCalls = 0;
  let toolCalls = 0;
  let step = 0;

  while (true) {
    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

    if (isBudgetReached(startedAt, input.budget, step, llmCalls)) {
      return rankedFallback('budget_reached', input, trace, startedAt, step, llmCalls, toolCalls);
    }

    const messages = buildLoopMessages({
      context: input.context,
      observations,
      candidateSummary: summarizeCandidatePool(input.candidatePool, input.context)
    });
    const response = await input.llmClient.complete(messages, {
      signal: input.signal,
      temperature: 0.2,
      maxTokens: 1000
    });
    llmCalls += 1;

    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

    if (Date.now() - startedAt >= input.budget.maxMs) {
      return rankedFallback('llm_response_timeout', input, trace, startedAt, step, llmCalls, toolCalls);
    }

    const output = parseLoopOutput(response.content);
    step += 1;

    if (output.type === 'final') {
      try {
        const picks = validateFinalPicks(output.picks, input.candidatePool);
        return {
          status: 'ok',
          mode: resolveMode(input),
          say: output.say,
          picks,
          rejected: output.rejected ?? [],
          trace
        };
      } catch (error) {
        const observation = observationFromProblem(
          `final rejected: ${error instanceof Error ? error.message : String(error)}`,
          input.candidatePool.count()
        );
        observations.push(observation);
        trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
          thoughtSummary: 'final rejected by candidate pool whitelist',
          observationSummary: summarizeObservation(observation)
        }));
        return rankedFallback('final_rejected', input, trace, startedAt, step, llmCalls, toolCalls);
      }
    }

    if (toolCalls >= input.budget.maxToolCalls && !canUseReservedRankTool(output.tool, input)) {
      const observation = observationFromProblem(
        `tool budget exhausted before ${output.tool}`,
        input.candidatePool.count()
      );
      observations.push({ ...observation, tool: output.tool });
      trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
        thoughtSummary: 'tool call skipped by budget',
        tool: asTraceTool(output.tool),
        toolInputSummary: summarizeInput(output.input),
        observationSummary: summarizeObservation(observation)
      }));
      return rankedFallback('tool_budget_exhausted', input, trace, startedAt, step, llmCalls, toolCalls);
    }

    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

    const toolName = parseToolName(output.tool);
    const tool = toolName ? input.tools[toolName] : undefined;

    if (!toolName || !tool) {
      const observation = observationFromProblem(
        `unknown or unavailable tool: ${output.tool}`,
        input.candidatePool.count()
      );
      observations.push({ ...observation, tool: output.tool });
      trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
        thoughtSummary: 'tool unavailable',
        tool: asTraceTool(output.tool),
        toolInputSummary: summarizeInput(output.input),
        observationSummary: summarizeObservation(observation)
      }));
      continue;
    }

    const observation = await tool(output.input, input.signal);
    toolCalls += 1;
    observations.push({ ...observation, tool: toolName });
    trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
      thoughtSummary: 'tool executed',
      tool: toolName,
      toolInputSummary: summarizeInput(output.input),
      observationSummary: summarizeObservation(observation)
    }));

    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

    const shouldSupplementSparseRank = shouldSupplementSparseAutoFillRank(toolName, input);

    if (shouldSupplementAutoFillRecall(toolName, input) || shouldSupplementSparseRank) {
      toolCalls = await supplementAutoFillRecallMix(input, observations, trace, startedAt, step, toolCalls);
      if (input.signal?.aborted) {
        return abortedOutput(resolveMode(input), trace);
      }
      if (shouldConvergeAfterAutoFillRecallMix(input)) {
        return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
      }
      if (shouldSupplementSparseRank) {
        continue;
      }
    }

    if (shouldConvergeAfterTool(toolName, input, llmCalls)) {
      return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
    }

  }
}

async function supplementAutoFillRecallMix(
  input: RunMusicAgentLoopInput,
  observations: LoopObservation[],
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  toolCalls: number
): Promise<number> {
  const aggregateTool = input.tools[AUTO_FILL_AGGREGATE_TOOL_NAME];
  if (aggregateTool && toolCalls < input.budget.maxToolCalls) {
    const observation = await aggregateTool({}, input.signal);
    const nextToolCalls = toolCalls + 1;
    observations.push({ ...observation, tool: AUTO_FILL_AGGREGATE_TOOL_NAME });
    trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
      thoughtSummary: 'auto-fill recall mix tool executed',
      tool: AUTO_FILL_AGGREGATE_TOOL_NAME,
      toolInputSummary: summarizeInput({}),
      observationSummary: summarizeObservation(observation)
    }));
    return nextToolCalls;
  }

  let nextToolCalls = toolCalls;
  for (const toolName of AUTO_FILL_MIX_TOOL_NAMES) {
    if (input.signal?.aborted) return nextToolCalls;
    if (nextToolCalls >= input.budget.maxToolCalls) return nextToolCalls;
    const tool = input.tools[toolName];
    if (!tool) continue;

    const observation = await tool({}, input.signal);
    nextToolCalls += 1;
    observations.push({ ...observation, tool: toolName });
    trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
      thoughtSummary: 'auto-fill recall mix tool executed',
      tool: toolName,
      toolInputSummary: summarizeInput({}),
      observationSummary: summarizeObservation(observation)
    }));
  }
  return nextToolCalls;
}

function canUseReservedRankTool(tool: string, input: RunMusicAgentLoopInput): boolean {
  return (
    tool === DEFAULT_TOOL_NAME &&
    input.candidatePool.count() > 0 &&
    Boolean(input.tools[DEFAULT_TOOL_NAME])
  );
}

function parseLoopOutput(raw: string): ParsedLoopOutput {
  const parsed = parseJsonish(raw);
  if (!isRecord(parsed)) {
    return DEFAULT_TOOL_CALL;
  }

  if (parsed.type === 'tool_call') {
    return {
      type: 'tool_call',
      tool: typeof parsed.tool === 'string' ? parsed.tool : DEFAULT_TOOL_NAME,
      input: isRecord(parsed.input) ? parsed.input : {}
    };
  }

  if (parsed.type === 'final') {
    const result = musicAgentLoopOutputSchema.safeParse(parsed);
    if (result.success && result.data.type === 'final') {
      return result.data;
    }
  }

  return DEFAULT_TOOL_CALL;
}

function parseJsonish(raw: string): unknown {
  const trimmed = raw.trim();

  for (const candidate of jsonCandidates(trimmed)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }

  return undefined;
}

function jsonCandidates(raw: string): string[] {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const embedded = extractFirstJsonObject(raw);
  if (embedded) candidates.push(embedded);
  return [...new Set(candidates.filter(Boolean))];
}

function extractFirstJsonObject(raw: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function rankedFallback(
  reason: MusicAgentFallbackReason,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number
): MusicAgentRunOutput {
  const mode = resolveMode(input);
  const ranked = rankCandidates(input.candidatePool.list(), 10, rankOptions(input.context));
  const picks = diversifyCandidates(ranked, 2).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked fallback',
    source: candidate.sources[0]
  }));

  const output: MusicAgentRunOutput = {
    status: picks.length > 0 ? 'ok' : 'empty_pool',
    mode,
    say: picks.length > 0
      ? rankedFallbackSay(picks.length)
      : '暂时没有可用候选，先不追加新歌。',
    picks,
    rejected: [],
    trace
  };
  input.fallbackLogger?.({
    reason,
    mode,
    status: output.status,
    candidateCount: input.candidatePool.count(),
    pickCount: picks.length,
    step,
    llmCalls,
    toolCalls,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    budget: input.budget,
    lastTraceStep: trace.at(-1)
  });
  return output;
}

function rankedConvergence(
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number
): MusicAgentRunOutput {
  const mode = resolveMode(input);
  const ranked = rankCandidates(input.candidatePool.list(), 10, rankOptions(input.context));
  const picks = diversifyCandidates(ranked, 2).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked convergence',
    source: candidate.sources[0]
  }));

  const output: MusicAgentRunOutput = {
    status: 'ok',
    mode,
    say: picks.length > 1
      ? '我从已经排序的候选池里收束出两首更适合现在的歌。'
      : '我从已经排序的候选池里收束出一首更适合现在的歌。',
    picks,
    rejected: [],
    trace
  };
  input.fallbackLogger?.({
    reason: 'ranked_tool_completed',
    mode,
    status: output.status,
    candidateCount: input.candidatePool.count(),
    pickCount: picks.length,
    step,
    llmCalls,
    toolCalls,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    budget: input.budget,
    lastTraceStep: trace.at(-1)
  });
  return output;
}

function rankedFallbackSay(pickCount: number): string {
  return pickCount > 1
    ? '我从候选池里挑了两首更适合现在的歌。'
    : '我从候选池里挑了一首更适合现在的歌。';
}

function abortedOutput(
  mode: MusicAgentFinalOutput['mode'],
  trace: AgentTraceStep[]
): MusicAgentRunOutput {
  return {
    status: 'aborted',
    mode,
    say: 'aborted: music agent loop was cancelled.',
    picks: [],
    rejected: [],
    trace
  };
}

function summarizeCandidatePool(pool: CandidatePool, context: MusicAgentContextSummary): string {
  return JSON.stringify(rankCandidates(pool.list(), 20, rankOptions(context)).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    sources: candidate.sources,
    score: Number(scoreCandidate(candidate).toFixed(4)),
    evidence: candidate.evidence.slice(0, 3)
  })));
}

function rankOptions(context: MusicAgentContextSummary) {
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty]))
  };
}

function traceStep(
  step: number,
  startedAt: number,
  candidateCount: number,
  extra: Omit<AgentTraceStep, 'step' | 'candidateCount' | 'elapsedMs'>
): AgentTraceStep {
  return {
    step,
    candidateCount,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...extra
  };
}

function observationFromProblem(summary: string, candidateCount: number): ToolObservation {
  return { summary, candidateCount, problems: [summary] };
}

function summarizeObservation(observation: ToolObservation): string {
  return truncate(
    [
      observation.summary,
      `candidateCount=${observation.candidateCount}`,
      ...(observation.problems?.map((problem) => `problem=${problem}`) ?? [])
    ].join('; '),
    MAX_TRACE_OBSERVATION_CHARS
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  return truncate(JSON.stringify(input), MAX_TRACE_INPUT_CHARS);
}

function parseToolName(tool: string): MusicAgentToolName | undefined {
  const result = musicAgentToolNameSchema.safeParse(tool);
  return result.success ? result.data : undefined;
}

function asTraceTool(tool: string): MusicAgentToolName | undefined {
  return parseToolName(tool);
}

function isBudgetReached(
  startedAt: number,
  budget: AgentBudget,
  step: number,
  llmCalls: number
): boolean {
  return (
    Date.now() - startedAt >= budget.maxMs ||
    step >= budget.maxSteps ||
    llmCalls >= budget.maxLlmCalls
  );
}

function shouldConvergeAfterTool(
  toolName: MusicAgentToolName,
  input: RunMusicAgentLoopInput,
  llmCalls: number
): boolean {
  if (input.candidatePool.count() < 2) return false;
  if (CONVERGENCE_TOOL_NAMES.has(toolName)) return true;
  return input.budget.maxLlmCalls - llmCalls <= 1;
}

function shouldSupplementAutoFillRecall(toolName: MusicAgentToolName, input: RunMusicAgentLoopInput): boolean {
  return modeFromContext(input.context) === 'pick_next' && toolName === 'recall_from_liked';
}

function shouldSupplementSparseAutoFillRank(toolName: MusicAgentToolName, input: RunMusicAgentLoopInput): boolean {
  return (
    modeFromContext(input.context) === 'pick_next' &&
    toolName === 'rank_candidates' &&
    !shouldConvergeAfterAutoFillRecallMix(input)
  );
}

function shouldConvergeAfterAutoFillRecallMix(input: RunMusicAgentLoopInput): boolean {
  return (
    countNonLikedCandidates(input) >= AUTO_FILL_NON_LIKED_CONVERGENCE_TARGET ||
    input.candidatePool.count() >= AUTO_FILL_TOTAL_CONVERGENCE_TARGET
  );
}

function countNonLikedCandidates(input: RunMusicAgentLoopInput): number {
  return input.candidatePool.list().filter((candidate) => candidate.sources.some((source) => source !== 'liked')).length;
}

function resolveMode(input: RunMusicAgentLoopInput): MusicAgentFinalOutput['mode'] {
  return input.mode ?? modeFromContext(input.context);
}

function modeFromContext(context: MusicAgentContextSummary): MusicAgentFinalOutput['mode'] {
  return context.request === 'chat-recommend' ? 'chat_recommend' : 'pick_next';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...<truncated>`;
}
