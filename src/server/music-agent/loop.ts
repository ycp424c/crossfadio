import {
  buildFinalPickPromptPayload,
  buildLoopMessages,
  FINAL_PICK_RESPONSE_FORMAT
} from './prompts.js';
import { CandidatePool, validateFinalPicks } from './candidates.js';
import { parseAutoFillBatchSize } from '../../shared/dj.js';
import {
  buildCandidateScoreTableRows,
  candidateTitleMotifKeys,
  diversifyCandidates,
  isHardFilteredCandidate,
  rankCandidates
} from './rank.js';
import {
  finalPickSchema,
  musicAgentFinalPickOutputSchema,
  musicAgentLoopOutputSchema,
  musicAgentToolNameSchema,
  rejectedPickSchema,
  type AgentBudget,
  type AgentTraceStep,
  type FinalPickDiagnostics,
  type FinalPick,
  type MusicAgentContextSummary,
  type MusicAgentFinalPickOutput,
  type MusicAgentFinalOutput,
  type MusicAgentLlmClient,
  type MusicAgentRunOutput,
  type MusicAgentToolName,
  type MusicCandidate,
  type QueryFunnelEntry
} from './schema.js';
import type { MusicAgentToolRegistry, ToolObservation } from './tools.js';
import type {
  FinalShortlistEnricher,
  FinalShortlistEnrichmentResult,
  TrackAssessmentPersister
} from './final-shortlist-enrichment.js';
import {
  evaluateCandidateQuality,
  evaluateTrackCompatibility,
  type CandidateQualityFacts,
  type CandidateQualityDecision,
  type TrackCompatibilityDecision
} from './selection-eligibility.js';
import type {
  LyricsAwareDecisionSummary,
  LyricsAwareDiagnostics,
  LyricsSelectionMode,
  ShortlistPromptPacket,
  TrackAssessment
} from './track-understanding.js';

export type RunMusicAgentLoopInput = {
  llmClient: MusicAgentLlmClient;
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  tools: MusicAgentToolRegistry;
  budget: AgentBudget;
  targetPickCount?: number;
  mode?: MusicAgentFinalOutput['mode'];
  signal?: AbortSignal;
  fallbackLogger?: MusicAgentFallbackLogger;
  finalShortlistEnricher?: FinalShortlistEnricher;
  lyricsSelectionMode?: LyricsSelectionMode;
  persistTrackAssessments?: TrackAssessmentPersister;
  lyricsRequestScope?: string;
};

export type MusicAgentFallbackReason =
  | 'budget_reached'
  | 'llm_response_timeout'
  | 'final_rejected'
  | 'tool_budget_exhausted'
  | 'empty_pool_after_forced_recall'
  | 'insufficient_pool_after_forced_recall'
  | 'extra_final_returned_tool_call'
  | 'extra_final_rejected'
  | 'liked_only_final_rejected'
  | 'extra_final_request_failed'
  | 'extra_final_timeout'
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
  traceLastSteps?: AgentTraceStep[];
  extraFinalProblem?: string;
  finalPickDiagnostics?: FinalPickDiagnostics;
  queryFunnel?: QueryFunnelEntry[];
  candidateScoreTablePreview?: MusicAgentRunOutput['candidateScoreTable'];
  candidateScoreTableCount?: number;
  webDiscoveryDiagnostics?: WebDiscoveryLogDiagnostics;
  lyricsAwareDiagnostics?: LyricsAwareDiagnostics;
};

export type MusicAgentFallbackLogger = (event: MusicAgentFallbackLogEvent) => void;

type WebDiscoveryLogDiagnostics = {
  step: number;
  summary: string;
  candidateCount: number;
  problems?: string[];
};

type ParsedLoopOutput =
  | { type: 'tool_call'; tool: string; input: Record<string, unknown> }
  | MusicAgentFinalPickOutput;

type LoopObservation = ToolObservation & {
  tool?: string;
};

type CompletedFinalPicks = {
  picks: FinalPick[];
  finalPickDiagnostics: FinalPickDiagnostics;
};

type LyricsAwareDecision = {
  assessment: TrackAssessment;
  compatibility: TrackCompatibilityDecision;
  quality: CandidateQualityDecision;
  eligible: boolean;
};

type LyricsAwareRunState = {
  preparation?: Promise<FinalShortlistEnrichmentResult>;
  enrichment?: FinalShortlistEnrichmentResult;
  assessments: Map<string, TrackAssessment>;
  decisions: Map<string, LyricsAwareDecision>;
  coverageValid: boolean;
  validationProblems: string[];
  promptChars: number;
  persistenceAttempted: boolean;
  fallbackSuppressed: boolean;
  semanticDroppedIds: Set<string>;
  qualityDroppedIds: Set<string>;
  unassessedDroppedIds: Set<string>;
};

const lyricsAwareRunStates = new WeakMap<RunMusicAgentLoopInput, LyricsAwareRunState>();

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
const AUTO_FILL_MIN_NON_LIKED_CONVERGENCE_TARGET = 8;
const AUTO_FILL_MIN_TOTAL_CONVERGENCE_TARGET = 10;
const AUTO_FILL_MIX_TOOL_NAMES: MusicAgentToolName[] = [
  'expand_queries',
  'recall_from_ncm_search',
  'recall_from_style_expansion',
  'recall_from_trending'
];
const AUTO_FILL_AGGREGATE_TOOL_NAME: MusicAgentToolName = 'recall_auto_fill_mix';
const EXTRA_FINAL_PICK_MIN_CANDIDATES = 3;
const SKIPPED_TOOL_FINAL_PICK_MIN_CANDIDATES = 2;
const FORCED_RECALL_LIKED_LIMIT = 10;
const EXTRA_FINAL_PICK_REMAINING_RATIO = 0.2;
const EXTRA_FINAL_PICK_MAX_REMAINING_MS = 20_000;
const LOOP_LLM_MAX_TOKENS = 1_400;
const EXTRA_FINAL_PICK_MAX_TOKENS = 1_600;
const HARD_FINAL_ONLY_PICK_MAX_TOKENS = 1_800;
const RECALL_TOOL_NAMES = new Set<MusicAgentToolName>([
  'recall_auto_fill_mix',
  'recall_from_liked',
  'recall_from_entities',
  'recall_from_ncm_search',
  'recall_from_style_expansion',
  'recall_from_trending',
  'recall_from_playlists'
]);
const EXTERNAL_RECALL_TOOL_NAMES = new Set<MusicAgentToolName>([
  'recall_auto_fill_mix',
  'recall_from_entities',
  'recall_from_ncm_search',
  'recall_from_style_expansion',
  'recall_from_trending',
  'recall_from_playlists'
]);
const NO_PROGRESS_FINAL_TOOL_NAMES = new Set<MusicAgentToolName>([
  ...EXTERNAL_RECALL_TOOL_NAMES,
  'expand_queries',
  'get_context_summary',
  'get_music_knowledge',
  'get_trend_context'
]);
const DISCOVERY_ONLY_TOOL_NAMES = new Set<MusicAgentToolName>([
  'web_music_discovery'
]);

type ToolRewrite = {
  toolName: MusicAgentToolName;
  input: Record<string, unknown>;
  requestedTool: string;
  rewriteReason: string;
};

export async function runMusicAgentLoop(input: RunMusicAgentLoopInput): Promise<MusicAgentRunOutput> {
  if (isLyricsAwareEnabled(input)) {
    lyricsAwareRunStates.set(input, {
      assessments: new Map(),
      decisions: new Map(),
      coverageValid: false,
      validationProblems: [],
      promptChars: 0,
      persistenceAttempted: false,
      fallbackSuppressed: false,
      semanticDroppedIds: new Set(),
      qualityDroppedIds: new Set(),
      unassessedDroppedIds: new Set()
    });
  }
  try {
    return await runMusicAgentLoopInternal(input);
  } finally {
    lyricsAwareRunStates.delete(input);
  }
}

async function runMusicAgentLoopInternal(input: RunMusicAgentLoopInput): Promise<MusicAgentRunOutput> {
  const startedAt = Date.now();
  const observations: LoopObservation[] = [];
  const trace: AgentTraceStep[] = [];
  let llmCalls = 0;
  let toolCalls = 0;
  let step = 0;
  let forcedEmptyPoolRecallCompleted = false;

  while (true) {
    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

    if (isBudgetReached(startedAt, input.budget, step, llmCalls)) {
      return rankedFallback('budget_reached', input, trace, startedAt, step, llmCalls, toolCalls);
    }

    await prepareForRanking(input);
    const messages = buildLoopMessages({
      context: input.context,
      observations,
      candidateSummary: summarizeCandidatePool(input.candidatePool, input.context),
      targetPickCount: targetPickCount(input)
    });
    const response = await input.llmClient.complete(messages, {
      signal: input.signal,
      temperature: 0.2,
      maxTokens: LOOP_LLM_MAX_TOKENS,
      thinking: { type: 'disabled' }
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
      if (isLyricsAwareEnabled(input)) {
        return askExtraFinalPick(
          input,
          observations,
          trace,
          startedAt,
          step,
          llmCalls,
          toolCalls,
          input.lyricsSelectionMode === 'shadow' ? output : undefined
        );
      }
      try {
        const picks = validateEligibleFinalPicks(output.picks, input);
        await prepareForRanking(input);
        const completed = completeFinalPicks(picks, input, output.picks.length, output.rejected?.length ?? 0);
        if (completed.picks.length === 0) {
          return rankedFallback('final_rejected', input, trace, startedAt, step, llmCalls, toolCalls, {
            finalPickDiagnostics: completed.finalPickDiagnostics
          });
        }
        const queryFunnel = recordAndReadQueryFunnel(input, completed.picks);
        return {
          status: 'ok',
          mode: resolveMode(input),
          say: output.say,
          picks: completed.picks,
          rejected: output.rejected ?? [],
          finalPickDiagnostics: completed.finalPickDiagnostics,
          ...lyricsAwareOutputFields(input, completed.picks),
          queryFunnel,
          trace,
          candidateScoreTable: createCandidateScoreTable(input)
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
        return rankedFallback('final_rejected', input, trace, startedAt, step, llmCalls, toolCalls, {
          finalPickDiagnostics: rejectedFinalPickDiagnostics(output, input)
        });
      }
    }

    const requestedToolName = parseToolName(output.tool);
    const rewrite = getEmptyPoolToolRewrite({
      output,
      requestedToolName,
      input,
      trace,
      forcedEmptyPoolRecallCompleted
    });
    if (rewrite === 'fallback') {
      return rankedFallback(forcedRecallFallbackReason(input), input, trace, startedAt, step, llmCalls, toolCalls);
    }
    const likedRecallRewrite = getExploreLikedRecallRewrite({
      requestedToolName,
      input,
      trace
    });
    const toolRewrite = rewrite ?? likedRecallRewrite;

    const toolName = toolRewrite?.toolName ?? requestedToolName;
    const toolInput = toolRewrite?.input ?? output.input;

    if (toolCalls >= input.budget.maxToolCalls && !canUseReservedRankTool(toolName, input)) {
      const budgetedToolName = toolName;
      const shouldConvergeAfterSkippedBudget = shouldConvergeAfterSkippedToolBudget(budgetedToolName, input);
      const skippedBudgetThought = skippedToolBudgetThought(
        toolRewrite,
        budgetedToolName,
        input,
        shouldConvergeAfterSkippedBudget
      );
      const observation = observationFromProblem(
        `tool budget exhausted before ${toolName ?? output.tool}`,
        input.candidatePool.count()
      );
      observations.push({ ...observation, tool: toolName ?? output.tool });
      trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
        thoughtSummary: skippedBudgetThought,
        tool: toolName,
        toolInputSummary: summarizeInput(toolInput),
        observationSummary: summarizeObservation(observation),
        requestedTool: toolRewrite?.requestedTool,
        rewriteReason: toolRewrite?.rewriteReason
      }));
      if (shouldConvergeAfterSkippedBudget) {
        if (hasExtraFinalPickBudget(
          input,
          startedAt,
          step,
          llmCalls,
          SKIPPED_TOOL_FINAL_PICK_MIN_CANDIDATES
        )) {
          return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
        }
        return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
      }
      return rankedFallback('tool_budget_exhausted', input, trace, startedAt, step, llmCalls, toolCalls);
    }

    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }

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

    const candidateCountBeforeTool = input.candidatePool.count();
    const observation = await tool(toolInput, input.signal);
    toolCalls += 1;
    observations.push({ ...observation, tool: toolName });
    trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
      thoughtSummary: toolRewrite ? rewrittenToolThought(toolRewrite) : 'tool executed',
      tool: toolName,
      toolInputSummary: summarizeInput(toolInput),
      observationSummary: summarizeObservation(observation),
      ...(observation.data ? { observationData: observation.data } : {}),
      requestedTool: toolRewrite?.requestedTool,
      executedTool: toolRewrite?.toolName,
      rewriteReason: toolRewrite?.rewriteReason
    }));

    if (toolRewrite && toolName === AUTO_FILL_AGGREGATE_TOOL_NAME) {
      toolCalls = await maybeForceLikedRecallAfterEmptyPoolRewrite(
        input,
        observations,
        trace,
        startedAt,
        step,
        toolCalls
      );
    }
    if (rewrite) forcedEmptyPoolRecallCompleted = input.candidatePool.count() < 2;

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
        if (hasExtraFinalPickBudget(input, startedAt, step, llmCalls)) {
          return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
        }
        return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
      }
      if (shouldSupplementSparseRank) {
        continue;
      }
    }

    if (shouldSupplementSparseExpandRecall(toolName, input, trace, candidateCountBeforeTool)) {
      toolCalls = await supplementAutoFillRecallMix(input, observations, trace, startedAt, step, toolCalls);
      if (input.signal?.aborted) {
        return abortedOutput(resolveMode(input), trace);
      }
      if (shouldConvergeAfterAutoFillRecallMix(input)) {
        if (hasExtraFinalPickBudget(input, startedAt, step, llmCalls)) {
          return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
        }
        return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
      }
    }

    if (shouldConvergeAfterExternalRecallTool(toolName, input)) {
      if (hasExtraFinalPickBudget(input, startedAt, step, llmCalls)) {
        return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
      }
      return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
    }

    if (
      shouldAskFinalAfterNoProgressTool(toolName, input, trace, candidateCountBeforeTool) &&
      hasExtraFinalPickBudget(input, startedAt, step, llmCalls, SKIPPED_TOOL_FINAL_PICK_MIN_CANDIDATES)
    ) {
      return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
    }

    if (shouldConvergeAfterTool(toolName, input, llmCalls)) {
      if (shouldAskExtraFinalPick(toolName, input, startedAt, step, llmCalls)) {
        return askExtraFinalPick(input, observations, trace, startedAt, step, llmCalls, toolCalls);
      }
      return rankedConvergence(input, trace, startedAt, step, llmCalls, toolCalls);
    }

  }
}

async function askExtraFinalPick(
  input: RunMusicAgentLoopInput,
  observations: LoopObservation[],
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number,
  shadowAuthoritativeOutput?: MusicAgentFinalPickOutput
): Promise<MusicAgentRunOutput> {
  await prepareForRanking(input);
  if (input.signal?.aborted) {
    return abortedOutput(resolveMode(input), trace);
  }

  const finalObservation: LoopObservation = {
    tool: DEFAULT_TOOL_NAME,
    summary: `ranked shortlist is ready; use one extra final-pick LLM call to choose up to ${targetPickCount(input)} whitelisted candidates.`,
    candidateCount: input.candidatePool.count()
  };
  const finalPickObservations = [...observations, finalObservation];
  const enrichment = await prepareLyricsAwareShortlist(input);
  const isShadowAssessmentCall = input.lyricsSelectionMode === 'shadow'
    && shadowAuthoritativeOutput !== undefined;
  const promptPayload = buildFinalPickPromptPayload({
    context: input.context,
    observations: finalPickObservations,
    candidateSummary: summarizeCandidatePool(input.candidatePool, input.context),
    targetPickCount: targetPickCount(input),
    ...(enrichment && (input.lyricsSelectionMode !== 'shadow' || isShadowAssessmentCall)
      ? { promptPackets: enrichment.promptPackets }
      : {})
  });
  const messages = promptPayload.messages;
  const lyricsState = lyricsAwareRunStates.get(input);
  if (lyricsState && isShadowAssessmentCall) lyricsState.promptChars = promptPayload.promptChars;

  const nextLlmCalls = llmCalls + 1;
  const nextStep = step + 1;
  let responseContent = '';
  try {
    const response = await input.llmClient.complete(messages, {
      signal: input.signal,
      temperature: 0.2,
      maxTokens: EXTRA_FINAL_PICK_MAX_TOKENS,
      thinking: { type: 'disabled' },
      responseFormat: FINAL_PICK_RESPONSE_FORMAT
    });
    responseContent = response.content;
  } catch {
    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      'extra final request failed',
      'extra final request failed',
      'extra_final_request_failed',
      'request_failed',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  if (input.signal?.aborted) {
    return abortedOutput(resolveMode(input), trace);
  }

  if (Date.now() - startedAt >= input.budget.maxMs) {
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      'extra final response exceeded loop budget',
      'extra final exceeded loop budget',
      'extra_final_timeout',
      'timeout',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  const output = parseFinalPickOutput(responseContent);
  if (!output) {
    const responseType = parseOutputType(responseContent) ?? 'invalid_json';
    if (hasExtraFinalPickBudget(input, startedAt, nextStep, nextLlmCalls)) {
      const retryThought = responseType === 'tool_call'
        ? 'extra final returned tool_call; retrying final-only output'
        : 'extra final did not return final JSON; retrying final-only output';
      trace.push(traceStep(nextStep, startedAt, input.candidatePool.count(), {
        thoughtSummary: retryThought,
        observationSummary: summarizeObservation(observationFromProblem(
          `${retryThought}: ${responseType}`,
          input.candidatePool.count()
        ))
      }));
      return retryHardFinalOnlyPick(
        input,
        finalPickObservations,
        trace,
        startedAt,
        nextStep,
        nextLlmCalls,
        toolCalls,
        shadowAuthoritativeOutput
      );
    }
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      `extra final returned ${responseType}`,
      'extra final did not return final output',
      'extra_final_returned_tool_call',
      responseType === 'tool_call' ? 'returned_tool_call' : 'invalid_final_output',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  if (input.lyricsSelectionMode === 'shadow' && !shadowAuthoritativeOutput) {
    return askExtraFinalPick(
      input,
      finalPickObservations,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls,
      output
    );
  }
  return acceptExtraFinalPick(
    output,
    input,
    trace,
    startedAt,
    nextStep,
    nextLlmCalls,
    toolCalls,
    shadowAuthoritativeOutput
  );
}

async function retryHardFinalOnlyPick(
  input: RunMusicAgentLoopInput,
  observations: LoopObservation[],
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number,
  shadowAuthoritativeOutput?: MusicAgentFinalPickOutput
): Promise<MusicAgentRunOutput> {
  const retryObservation: LoopObservation = {
    tool: DEFAULT_TOOL_NAME,
    summary: '上一轮最终选歌输出不是 final；这次必须只返回 final JSON。',
    candidateCount: input.candidatePool.count(),
    problems: ['extra final returned non-final output']
  };
  const enrichment = await prepareLyricsAwareShortlist(input);
  const isShadowAssessmentCall = input.lyricsSelectionMode === 'shadow'
    && shadowAuthoritativeOutput !== undefined;
  const promptPayload = buildFinalPickPromptPayload({
    context: input.context,
    observations: [...observations, retryObservation],
    candidateSummary: summarizeCandidatePool(input.candidatePool, input.context),
    targetPickCount: targetPickCount(input),
    hardFinalOnlyRetry: true,
    ...(enrichment && (input.lyricsSelectionMode !== 'shadow' || isShadowAssessmentCall)
      ? { promptPackets: enrichment.promptPackets }
      : {})
  });
  const messages = promptPayload.messages;
  const lyricsState = lyricsAwareRunStates.get(input);
  if (lyricsState && isShadowAssessmentCall) lyricsState.promptChars = promptPayload.promptChars;
  const nextLlmCalls = llmCalls + 1;
  const nextStep = step + 1;
  let responseContent = '';
  try {
    const response = await input.llmClient.complete(messages, {
      signal: input.signal,
      temperature: 0.1,
      maxTokens: HARD_FINAL_ONLY_PICK_MAX_TOKENS,
      thinking: { type: 'disabled' },
      responseFormat: FINAL_PICK_RESPONSE_FORMAT
    });
    responseContent = response.content;
  } catch {
    if (input.signal?.aborted) {
      return abortedOutput(resolveMode(input), trace);
    }
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      'hard final-only retry request failed',
      'hard final-only retry request failed',
      'extra_final_request_failed',
      'request_failed',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  if (input.signal?.aborted) {
    return abortedOutput(resolveMode(input), trace);
  }

  if (Date.now() - startedAt >= input.budget.maxMs) {
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      'hard final-only retry exceeded loop budget',
      'hard final-only retry exceeded loop budget',
      'extra_final_timeout',
      'timeout',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  const output = parseFinalPickOutput(responseContent);
  if (!output) {
    const responseType = parseOutputType(responseContent) ?? 'invalid_json';
    if (shadowAuthoritativeOutput) {
      return acceptExtraFinalPick(
        null, input, trace, startedAt, nextStep, nextLlmCalls, toolCalls, shadowAuthoritativeOutput
      );
    }
    return rankedConvergenceAfterExtraFinalProblem(
      `hard final-only retry returned ${responseType}`,
      'hard final-only retry did not return final output',
      'extra_final_returned_tool_call',
      responseType === 'tool_call' ? 'returned_tool_call' : 'invalid_final_output',
      input,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls
    );
  }

  if (input.lyricsSelectionMode === 'shadow' && !shadowAuthoritativeOutput) {
    return askExtraFinalPick(
      input,
      observations,
      trace,
      startedAt,
      nextStep,
      nextLlmCalls,
      toolCalls,
      output
    );
  }
  return acceptExtraFinalPick(
    output,
    input,
    trace,
    startedAt,
    nextStep,
    nextLlmCalls,
    toolCalls,
    shadowAuthoritativeOutput
  );
}

async function acceptExtraFinalPick(
  assessmentOutput: MusicAgentFinalPickOutput | null,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number,
  authoritativeOutput?: MusicAgentFinalPickOutput
): Promise<MusicAgentRunOutput> {
  const output = authoritativeOutput ?? assessmentOutput;
  if (!output) {
    return rankedFallback('extra_final_rejected', input, trace, startedAt, step, llmCalls, toolCalls);
  }
  try {
    if (assessmentOutput) await applyFusedLyricsAwareAssessments(assessmentOutput, input);
    const picks = validateEligibleFinalPicks(output.picks, input);
    await prepareForRanking(input);
    const completed = completeFinalPicks(picks, input, output.picks.length, output.rejected?.length ?? 0);
    if (completed.picks.length === 0) {
      return rankedFallback('extra_final_rejected', input, trace, startedAt, step, llmCalls, toolCalls, {
        extraFinalProblem: 'empty_final',
        finalPickDiagnostics: completed.finalPickDiagnostics
      });
    }
    if (shouldRejectLikedOnlyFinalPicks(input)) {
      trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
        thoughtSummary: 'extra final rejected because explore auto-fill has only liked candidates',
        observationSummary: summarizeObservation(observationFromProblem(
          'extra final rejected: explore auto-fill requires non-liked candidates before accepting a large batch',
          input.candidatePool.count()
        ))
      }));
      return rankedFallback('liked_only_final_rejected', input, trace, startedAt, step, llmCalls, toolCalls, {
        extraFinalProblem: 'liked_only_final',
        finalPickDiagnostics: completed.finalPickDiagnostics
      });
    }
    const queryFunnel = recordAndReadQueryFunnel(input, completed.picks);
    const result: MusicAgentRunOutput = {
      status: 'ok',
      mode: resolveMode(input),
      say: output.say,
      picks: completed.picks,
      rejected: output.rejected ?? [],
      finalPickDiagnostics: completed.finalPickDiagnostics,
      ...lyricsAwareOutputFields(input, completed.picks),
      queryFunnel,
      trace,
      candidateScoreTable: createCandidateScoreTable(input)
    };
    recordRankedConvergence(input, result, trace, startedAt, step, llmCalls, toolCalls);
    return result;
  } catch (error) {
    const observation = observationFromProblem(
      `extra final rejected: ${error instanceof Error ? error.message : String(error)}`,
      input.candidatePool.count()
    );
    trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
      thoughtSummary: 'extra final rejected by candidate pool whitelist',
      observationSummary: summarizeObservation(observation)
    }));
    return rankedFallback('extra_final_rejected', input, trace, startedAt, step, llmCalls, toolCalls, {
      extraFinalProblem: 'final_rejected',
      finalPickDiagnostics: rejectedFinalPickDiagnostics(output, input)
    });
  }
}

async function rankedConvergenceAfterExtraFinalProblem(
  problem: string,
  thoughtSummary: string,
  fallbackReason: MusicAgentFallbackReason,
  extraFinalProblem: string,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number
): Promise<MusicAgentRunOutput> {
  const observation = observationFromProblem(problem, input.candidatePool.count());
  trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
    thoughtSummary,
    observationSummary: summarizeObservation(observation)
  }));
  return rankedFallback(fallbackReason, input, trace, startedAt, step, llmCalls, toolCalls, {
    extraFinalProblem
  });
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
      observationSummary: summarizeObservation(observation),
      ...(observation.data ? { observationData: observation.data } : {})
    }));
    return supplementLikedTailFallback(input, observations, trace, startedAt, step, nextToolCalls);
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
      observationSummary: summarizeObservation(observation),
      ...(observation.data ? { observationData: observation.data } : {})
    }));
  }
  return supplementLikedTailFallback(input, observations, trace, startedAt, step, nextToolCalls);
}

async function supplementLikedTailFallback(
  input: RunMusicAgentLoopInput,
  observations: LoopObservation[],
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  toolCalls: number
): Promise<number> {
  if (!shouldSupplementLikedTailFallback(input)) return toolCalls;
  if (toolCalls >= input.budget.maxToolCalls) return toolCalls;
  const likedTool = input.tools.recall_from_liked;
  if (!likedTool) return toolCalls;

  const toolInput = { limit: targetPickCount(input) };
  const observation = await likedTool(toolInput, input.signal);
  const nextToolCalls = toolCalls + 1;
  observations.push({ ...observation, tool: 'recall_from_liked' });
  trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
    thoughtSummary: 'liked tail fallback after sparse external recall',
    tool: 'recall_from_liked',
    toolInputSummary: summarizeInput(toolInput),
    observationSummary: summarizeObservation(observation),
    ...(observation.data ? { observationData: observation.data } : {}),
    requestedTool: 'recall_from_liked',
    executedTool: 'recall_from_liked',
    rewriteReason: 'sparse_external_recall_liked_tail'
  }));
  return nextToolCalls;
}

async function maybeForceLikedRecallAfterEmptyPoolRewrite(
  input: RunMusicAgentLoopInput,
  observations: LoopObservation[],
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  toolCalls: number
): Promise<number> {
  if (input.candidatePool.count() >= 2) return toolCalls;
  if (toolCalls >= input.budget.maxToolCalls) return toolCalls;
  const likedTool = input.tools.recall_from_liked;
  if (!likedTool) return toolCalls;

  const toolInput = { limit: FORCED_RECALL_LIKED_LIMIT };
  const observation = await likedTool(toolInput, input.signal);
  const nextToolCalls = toolCalls + 1;
  observations.push({ ...observation, tool: 'recall_from_liked' });
  trace.push(traceStep(step, startedAt, input.candidatePool.count(), {
    thoughtSummary: 'forced liked recall after sparse auto-fill',
    tool: 'recall_from_liked',
    toolInputSummary: summarizeInput(toolInput),
    observationSummary: summarizeObservation(observation),
    ...(observation.data ? { observationData: observation.data } : {}),
    requestedTool: 'recall_from_liked',
    executedTool: 'recall_from_liked',
    rewriteReason: 'empty_pool_forced_liked_recall'
  }));
  return nextToolCalls;
}

function getEmptyPoolToolRewrite(options: {
  output: Extract<ParsedLoopOutput, { type: 'tool_call' }>;
  requestedToolName: MusicAgentToolName | undefined;
  input: RunMusicAgentLoopInput;
  trace: AgentTraceStep[];
  forcedEmptyPoolRecallCompleted: boolean;
}): ToolRewrite | 'fallback' | undefined {
  const { output, requestedToolName, input, trace, forcedEmptyPoolRecallCompleted } = options;
  if (modeFromContext(input.context) !== 'pick_next') return undefined;
  if (input.candidatePool.count() >= 2) return undefined;
  if (requestedToolName && RECALL_TOOL_NAMES.has(requestedToolName)) return undefined;
  if (requestedToolName && DISCOVERY_ONLY_TOOL_NAMES.has(requestedToolName)) return undefined;
  if (requestedToolName === 'expand_queries' && !hasExecutedTool(trace, 'expand_queries')) return undefined;
  if (forcedEmptyPoolRecallCompleted) return 'fallback';

  const toolName = selectForcedRecallTool(input.tools);
  if (!toolName) return 'fallback';
  return {
    toolName,
    input: toolName === 'recall_from_liked' ? { limit: FORCED_RECALL_LIKED_LIMIT } : {},
    requestedTool: output.tool,
    rewriteReason: 'empty_pool_non_recall_tool'
  };
}

function getExploreLikedRecallRewrite(options: {
  requestedToolName: MusicAgentToolName | undefined;
  input: RunMusicAgentLoopInput;
  trace: AgentTraceStep[];
}): ToolRewrite | undefined {
  const { requestedToolName, input, trace } = options;
  if (!isExploreAutoFill(input)) return undefined;
  if (requestedToolName !== 'recall_from_liked') return undefined;
  if (hasExecutedExternalRecall(trace)) return undefined;
  if (!input.tools[AUTO_FILL_AGGREGATE_TOOL_NAME]) return undefined;

  return {
    toolName: AUTO_FILL_AGGREGATE_TOOL_NAME,
    input: {},
    requestedTool: 'recall_from_liked',
    rewriteReason: 'explore_external_recall_before_liked'
  };
}

function rewrittenToolThought(rewrite: ToolRewrite): string {
  if (rewrite.rewriteReason === 'explore_external_recall_before_liked') {
    return 'liked recall rewritten to external recall first';
  }
  return 'empty-pool tool call rewritten to recall';
}

function selectForcedRecallTool(tools: MusicAgentToolRegistry): MusicAgentToolName | undefined {
  if (tools[AUTO_FILL_AGGREGATE_TOOL_NAME]) return AUTO_FILL_AGGREGATE_TOOL_NAME;
  if (tools.recall_from_liked) return 'recall_from_liked';
  return undefined;
}

function hasExecutedExternalRecall(trace: AgentTraceStep[]): boolean {
  return trace.some((step) => step.tool !== undefined && EXTERNAL_RECALL_TOOL_NAMES.has(step.tool));
}

function hasExecutedTool(trace: AgentTraceStep[], toolName: MusicAgentToolName): boolean {
  return trace.some((step) => step.tool === toolName);
}

function forcedRecallFallbackReason(input: RunMusicAgentLoopInput): MusicAgentFallbackReason {
  return input.candidatePool.count() === 0
    ? 'empty_pool_after_forced_recall'
    : 'insufficient_pool_after_forced_recall';
}

function canUseReservedRankTool(tool: MusicAgentToolName | undefined, input: RunMusicAgentLoopInput): boolean {
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

function parseFinalPickOutput(raw: string): MusicAgentFinalPickOutput | undefined {
  const parsed = parseJsonish(raw);
  const result = musicAgentFinalPickOutputSchema.safeParse(parsed);
  if (result.success) return result.data;
  if (!isRecord(parsed) || parsed.type !== 'final' || typeof parsed.say !== 'string') {
    return undefined;
  }

  const picks = Array.isArray(parsed.picks)
    ? parsed.picks.flatMap((pick) => {
        const pickResult = finalPickSchema.safeParse(pick);
        return pickResult.success ? [pickResult.data] : [];
      })
    : [];
  if (picks.length === 0) return undefined;

  const rejected = Array.isArray(parsed.rejected)
    ? parsed.rejected.flatMap((item) => {
        const rejectedResult = rejectedPickSchema.safeParse(item);
        return rejectedResult.success ? [rejectedResult.data] : [];
      })
    : [];

  return {
    type: 'final',
    say: parsed.say,
    picks,
    rejected,
    assessments: []
  };
}

function parseOutputType(raw: string): string | undefined {
  const parsed = parseJsonish(raw);
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.type === 'string' ? parsed.type : undefined;
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

async function rankedFallback(
  reason: MusicAgentFallbackReason,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number,
  extra: Pick<MusicAgentFallbackLogEvent, 'extraFinalProblem' | 'finalPickDiagnostics'> = {}
): Promise<MusicAgentRunOutput> {
  const mode = resolveMode(input);
  await prepareForRanking(input);
  await prepareLyricsAwareShortlist(input);
  const options = rankOptions(input.context);
  const ranked = rankCandidates(input.candidatePool.list(), input.candidatePool.count(), options);
  const selectable = rankedFallbackSelectableCandidates(ranked, input);
  const picks = selectRankedPickCandidates(selectable, targetPickCount(input), input).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked fallback',
    source: candidate.sources[0]
  }));
  const finalPickDiagnostics = extra.finalPickDiagnostics
    ?? lyricsAwareRankedDiagnostics(input, picks);
  const queryFunnel = recordSearchHistoryAndReadQueryFunnel(input);

  const output: MusicAgentRunOutput = {
    status: picks.length > 0 ? 'ok' : 'empty_pool',
    mode,
    say: picks.length > 0
      ? rankedFallbackSay(picks.length)
      : '暂时没有可用候选，先不追加新歌。',
    picks,
    rejected: [],
    ...(finalPickDiagnostics ? { finalPickDiagnostics } : {}),
    ...lyricsAwareOutputFields(input, picks),
    queryFunnel,
    trace,
    candidateScoreTable: buildCandidateScoreTableRows(ranked, options)
  };
  const webDiscoveryDiagnostics = firstWebDiscoveryDiagnostics(trace);
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
    lastTraceStep: trace.at(-1),
    traceLastSteps: trace.slice(-3),
    finalPickDiagnostics,
    lyricsAwareDiagnostics: output.lyricsAwareDiagnostics,
    queryFunnel,
    candidateScoreTablePreview: output.candidateScoreTable.slice(0, 20),
    candidateScoreTableCount: output.candidateScoreTable.length,
    ...(webDiscoveryDiagnostics ? { webDiscoveryDiagnostics } : {}),
    ...extra
  });
  return output;
}

async function rankedConvergence(
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number
): Promise<MusicAgentRunOutput> {
  const mode = resolveMode(input);
  await prepareForRanking(input);
  await prepareLyricsAwareShortlist(input);
  const options = rankOptions(input.context);
  const ranked = rankCandidates(input.candidatePool.list(), input.candidatePool.count(), options);
  const picks = selectRankedPickCandidates(ranked, targetPickCount(input), input).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked convergence',
    source: candidate.sources[0]
  }));
  const finalPickDiagnostics = lyricsAwareRankedDiagnostics(input, picks);

  const output: MusicAgentRunOutput = {
    status: picks.length > 0 ? 'ok' : 'empty_pool',
    mode,
    say: picks.length > 0
      ? `我从已经排序的候选池里收束出${formatPickCount(picks.length)}更适合现在的歌。`
      : '候选与当前场景存在明确冲突，先不追加新歌。',
    picks,
    rejected: [],
    ...(finalPickDiagnostics ? { finalPickDiagnostics } : {}),
    ...lyricsAwareOutputFields(input, picks),
    queryFunnel: recordAndReadQueryFunnel(input, picks),
    trace,
    candidateScoreTable: buildCandidateScoreTableRows(ranked, options)
  };
  recordRankedConvergence(input, output, trace, startedAt, step, llmCalls, toolCalls);
  return output;
}

function recordRankedConvergence(
  input: RunMusicAgentLoopInput,
  output: MusicAgentRunOutput,
  trace: AgentTraceStep[],
  startedAt: number,
  step: number,
  llmCalls: number,
  toolCalls: number
): void {
  const webDiscoveryDiagnostics = firstWebDiscoveryDiagnostics(trace);
  input.fallbackLogger?.({
    reason: 'ranked_tool_completed',
    mode: output.mode,
    status: output.status,
    candidateCount: input.candidatePool.count(),
    pickCount: output.picks.length,
    step,
    llmCalls,
    toolCalls,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    budget: input.budget,
    lastTraceStep: trace.at(-1),
    traceLastSteps: trace.slice(-3),
    finalPickDiagnostics: output.finalPickDiagnostics,
    lyricsAwareDiagnostics: output.lyricsAwareDiagnostics,
    queryFunnel: output.queryFunnel,
    candidateScoreTablePreview: output.candidateScoreTable.slice(0, 20),
    candidateScoreTableCount: output.candidateScoreTable.length,
    ...(webDiscoveryDiagnostics ? { webDiscoveryDiagnostics } : {})
  });
}

function rankedFallbackSay(pickCount: number): string {
  return pickCount > 1
    ? `我从候选池里挑了${formatPickCount(pickCount)}更适合现在的歌。`
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
    queryFunnel: [],
    trace,
    candidateScoreTable: []
  };
}

function recordAndReadQueryFunnel(input: RunMusicAgentLoopInput, picks: FinalPick[]): QueryFunnelEntry[] {
  input.tools.recordFinalPicks?.(picks);
  return readQueryFunnel(input);
}

function recordSearchHistoryAndReadQueryFunnel(input: RunMusicAgentLoopInput): QueryFunnelEntry[] {
  input.tools.recordQueryFunnel?.();
  return readQueryFunnel(input);
}

function readQueryFunnel(input: RunMusicAgentLoopInput): QueryFunnelEntry[] {
  return input.tools.getQueryFunnel?.() ?? [];
}

function createCandidateScoreTable(input: RunMusicAgentLoopInput) {
  const options = rankOptions(input.context);
  const ranked = rankCandidates(input.candidatePool.list(), input.candidatePool.count(), options);
  return buildCandidateScoreTableRows(ranked, options);
}

function selectRankedPickCandidates(
  candidates: MusicCandidate[],
  target: number,
  input: RunMusicAgentLoopInput
): MusicCandidate[] {
  const eligible = candidates.filter((candidate) => isCandidateEligible(candidate, input));
  const diverse = diversifyCandidates(eligible.slice(0, 10), target);
  if (diverse.length >= target) {
    recordRankedSelectionRejections(candidates, diverse, target, input);
    return diverse;
  }

  const selectedIds = new Set(diverse.map((candidate) => candidate.id));
  const backfill = eligible
    .filter((candidate) => !selectedIds.has(candidate.id) && !isHardFilteredCandidate(candidate))
    .slice(0, target - diverse.length);

  const selected = [...diverse, ...backfill];
  recordRankedSelectionRejections(candidates, selected, target, input);
  return selected;
}

function validateEligibleFinalPicks(picks: FinalPick[], input: RunMusicAgentLoopInput): FinalPick[] {
  const eligiblePicks = picks.filter((pick) => {
    const candidate = input.candidatePool.get(pick.id);
    const accepted = !candidate || isCandidateEligible(candidate, input);
    if (candidate && !accepted) recordLyricsAwareRejection(candidate, input);
    return accepted;
  });
  return validateFinalPicks(eligiblePicks, input.candidatePool, {
    isCandidateEligible: (candidate) => isCandidateEligible(candidate, input)
  }).slice(0, targetPickCount(input));
}

function completeFinalPicks(
  picks: FinalPick[],
  input: RunMusicAgentLoopInput,
  rawPickCount = picks.length,
  rejectedPickCount = 0
): CompletedFinalPicks {
  const completed = modeFromContext(input.context) === 'pick_next'
    ? rankedBackfillFinalPicks(picks, input, rawPickCount, rejectedPickCount)
    : {
        picks,
        finalPickDiagnostics: buildFinalPickDiagnostics({
          targetPickCount: targetPickCount(input),
          rawPickCount,
          eligiblePickCount: picks.length,
          acceptedPickCount: picks.length,
          titleMotifDroppedCount: 0,
          rankedBackfillCount: 0,
          rejectedPickCount
        })
      };
  return withLyricsAwareFinalPickDiagnostics(completed, input);
}

function withLyricsAwareFinalPickDiagnostics(
  completed: CompletedFinalPicks,
  input: RunMusicAgentLoopInput
): CompletedFinalPicks {
  const state = lyricsAwareRunStates.get(input);
  if (!state) return completed;
  return {
    ...completed,
    finalPickDiagnostics: {
      ...completed.finalPickDiagnostics,
      semanticConflictDroppedCount: state.semanticDroppedIds.size,
      qualityDroppedCount: state.qualityDroppedIds.size,
      unassessedDroppedCount: state.unassessedDroppedIds.size,
      assessmentValidationFailureCount: state.validationProblems.length > 0 ? 1 : 0
    }
  };
}

function lyricsAwareRankedDiagnostics(
  input: RunMusicAgentLoopInput,
  picks: FinalPick[]
): FinalPickDiagnostics | undefined {
  if (!lyricsAwareRunStates.has(input)) return undefined;
  return withLyricsAwareFinalPickDiagnostics({
    picks,
    finalPickDiagnostics: buildFinalPickDiagnostics({
      targetPickCount: targetPickCount(input),
      rawPickCount: picks.length,
      eligiblePickCount: picks.length,
      acceptedPickCount: picks.length,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 0,
      rejectedPickCount: 0
    })
  }, input).finalPickDiagnostics;
}

function rankedBackfillFinalPicks(
  picks: FinalPick[],
  input: RunMusicAgentLoopInput,
  rawPickCount: number,
  rejectedPickCount: number
): CompletedFinalPicks {
  const target = targetPickCount(input);
  const diversePicks = diversifyFinalPicksByTitleMotif(picks, input);
  const titleMotifDroppedCount = Math.max(0, picks.length - diversePicks.length);
  if (diversePicks.length >= target) {
    const completedPicks = diversePicks.slice(0, target);
    return {
      picks: completedPicks,
      finalPickDiagnostics: buildFinalPickDiagnostics({
        targetPickCount: target,
        rawPickCount,
        eligiblePickCount: picks.length,
        acceptedPickCount: completedPicks.length,
        titleMotifDroppedCount,
        rankedBackfillCount: 0,
        rejectedPickCount
      })
    };
  }
  if (diversePicks.length >= minFinalPicksBeforeBackfill(target)) {
    return {
      picks: diversePicks,
      finalPickDiagnostics: buildFinalPickDiagnostics({
        targetPickCount: target,
        rawPickCount,
        eligiblePickCount: picks.length,
        acceptedPickCount: diversePicks.length,
        titleMotifDroppedCount,
        rankedBackfillCount: 0,
        rejectedPickCount
      })
    };
  }

  const pickedIds = new Set(picks.map((pick) => pick.id));
  const blockedTitleMotifs = titleMotifsFromFinalPicks(diversePicks, input);
  const options = rankOptions(input.context);
  const rankedCandidates = rankCandidates(input.candidatePool.list(), input.candidatePool.count(), options)
    .filter((candidate) => !pickedIds.has(candidate.id));
  const ranked = rankedCandidates.filter((candidate) => isCandidateEligible(candidate, input));
  const backfill = diversifyCandidates(ranked, target - diversePicks.length, { blockedTitleMotifs }).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked backfill',
    source: candidate.sources[0]
  }));
  recordRankedSelectionRejections(
    rankedCandidates,
    backfill.flatMap((pick) => {
      const candidate = input.candidatePool.get(pick.id);
      return candidate ? [candidate] : [];
    }),
    target - diversePicks.length,
    input
  );

  return {
    picks: [...diversePicks, ...backfill],
    finalPickDiagnostics: buildFinalPickDiagnostics({
      targetPickCount: target,
      rawPickCount,
      eligiblePickCount: picks.length,
      acceptedPickCount: diversePicks.length,
      titleMotifDroppedCount,
      rankedBackfillCount: backfill.length,
      rejectedPickCount
    })
  };
}

function minFinalPicksBeforeBackfill(target: number): number {
  return Math.ceil(target * 0.5);
}

type DefaultedFinalPickDiagnosticKey =
  | 'semanticConflictDroppedCount'
  | 'qualityDroppedCount'
  | 'unassessedDroppedCount'
  | 'assessmentValidationFailureCount';

type FinalPickDiagnosticsInput =
  Omit<FinalPickDiagnostics, 'droppedPickCount' | DefaultedFinalPickDiagnosticKey>
  & Partial<Pick<FinalPickDiagnostics, DefaultedFinalPickDiagnosticKey>>;

function buildFinalPickDiagnostics(input: FinalPickDiagnosticsInput): FinalPickDiagnostics {
  return {
    ...input,
    droppedPickCount: Math.max(0, input.rawPickCount - input.acceptedPickCount),
    semanticConflictDroppedCount: input.semanticConflictDroppedCount ?? 0,
    qualityDroppedCount: input.qualityDroppedCount ?? 0,
    unassessedDroppedCount: input.unassessedDroppedCount ?? 0,
    assessmentValidationFailureCount: input.assessmentValidationFailureCount ?? 0
  };
}

function rejectedFinalPickDiagnostics(
  output: Extract<ParsedLoopOutput, { type: 'final' }>,
  input: RunMusicAgentLoopInput
): FinalPickDiagnostics {
  return buildFinalPickDiagnostics({
    targetPickCount: targetPickCount(input),
    rawPickCount: output.picks.length,
    eligiblePickCount: 0,
    acceptedPickCount: 0,
    titleMotifDroppedCount: 0,
    rankedBackfillCount: 0,
    rejectedPickCount: output.rejected?.length ?? 0
  });
}

function diversifyFinalPicksByTitleMotif(picks: FinalPick[], input: RunMusicAgentLoopInput): FinalPick[] {
  const selected: FinalPick[] = [];
  const usedTitleMotifs = new Set<string>();

  for (const pick of picks) {
    const motifs = titleMotifsFromCandidateId(pick.id, input);
    if (motifs.some((motif) => usedTitleMotifs.has(motif))) {
      continue;
    }

    selected.push(pick);
    for (const motif of motifs) {
      usedTitleMotifs.add(motif);
    }
  }

  return selected;
}

function titleMotifsFromFinalPicks(picks: FinalPick[], input: RunMusicAgentLoopInput): Set<string> {
  const motifs = new Set<string>();
  for (const pick of picks) {
    for (const motif of titleMotifsFromCandidateId(pick.id, input)) {
      motifs.add(motif);
    }
  }
  return motifs;
}

function titleMotifsFromCandidateId(id: string, input: RunMusicAgentLoopInput): string[] {
  const candidate = input.candidatePool.get(id);
  return candidate ? candidateTitleMotifKeys(candidate) : [];
}

function targetPickCount(input: RunMusicAgentLoopInput): number {
  return parseAutoFillBatchSize(input.targetPickCount);
}

function formatPickCount(pickCount: number): string {
  return pickCount === 1 ? '一首' : `${pickCount} 首`;
}

async function prepareForRanking(input: RunMusicAgentLoopInput): Promise<void> {
  await input.tools.prepare_for_ranking?.({}, input.signal);
}

function isLyricsAwareEnabled(input: RunMusicAgentLoopInput): boolean {
  return (input.lyricsSelectionMode ?? 'off') !== 'off' && input.finalShortlistEnricher !== undefined;
}

function isEnforcementMode(input: RunMusicAgentLoopInput): boolean {
  return input.lyricsSelectionMode === 'enforce_fit' || input.lyricsSelectionMode === 'enforce_all';
}

async function prepareLyricsAwareShortlist(
  input: RunMusicAgentLoopInput
): Promise<FinalShortlistEnrichmentResult | null> {
  const state = lyricsAwareRunStates.get(input);
  if (!state || !input.finalShortlistEnricher) return null;
  if (!state.preparation) {
    const ranked = rankCandidates(
      input.candidatePool.list(),
      input.candidatePool.count(),
      rankOptions(input.context)
    );
    state.preparation = input.finalShortlistEnricher(ranked, {
      signal: input.signal,
      requestScope: input.lyricsRequestScope
    })
      .catch(() => {
        state.validationProblems = ['enrichment_failed'];
        const shortlist = ranked.slice(0, 12);
        return {
          shortlist,
          expectedLyricVersions: [],
          promptPackets: shortlist.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            artist: candidate.artist,
            sources: candidate.sources,
            ...(candidate.qualitySignals ? { qualitySignals: candidate.qualitySignals } : {}),
            kind: 'base' as const
          })),
          diagnostics: emptyLyricsAwareEnrichmentDiagnostics(shortlist.length)
        };
      })
      .then((enrichment) => {
        state.enrichment = enrichment;
        for (const packet of enrichment.promptPackets) {
          if (packet.kind === 'profile') state.assessments.set(packet.id, packet.assessment);
        }
        state.coverageValid = enrichment.shortlist.length > 0
          && enrichment.shortlist.every((candidate) => state.assessments.has(candidate.id));
        rebuildLyricsAwareDecisions(input);
        return enrichment;
      });
  }
  return state.preparation;
}

function emptyLyricsAwareEnrichmentDiagnostics(shortlistCount: number) {
  return {
    shortlistCount,
    cacheHits: 0, cacheMisses: shortlistCount,
    lyricAttempted: 0, lyricSuccess: 0, lyricMissing: 0, lyricFail: 0,
    lyricTimeout: 0, lyricCancelled: 0, wikiAttempted: 0, wikiSuccess: 0,
    wikiFail: 0, wikiTimeout: 0, wikiCancelled: 0, cacheWriteFailed: 0,
    sampledChars: 0, elapsedMs: 0, deadlineReached: false
  };
}

async function applyFusedLyricsAwareAssessments(
  output: Extract<ParsedLoopOutput, { type: 'final' }>,
  input: RunMusicAgentLoopInput
): Promise<void> {
  const state = lyricsAwareRunStates.get(input);
  if (!state) return;
  const enrichment = await prepareLyricsAwareShortlist(input);
  if (!enrichment) return;

  const expectedIds = enrichment.shortlist.map((candidate) => candidate.id);
  const expected = new Set(expectedIds);
  const returnedIds = output.assessments.map((assessment) => assessment.id);
  const returned = new Set(returnedIds);
  const duplicateIds = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  const missingIds = expectedIds.filter((id) => !returned.has(id));
  const unknownIds = [...returned].filter((id) => !expected.has(id));
  const problems = [
    ...(duplicateIds.length > 0 ? [`duplicate_assessment_ids:${[...new Set(duplicateIds)].join(',')}`] : []),
    ...(missingIds.length > 0 ? [`missing_assessment_ids:${missingIds.join(',')}`] : []),
    ...(unknownIds.length > 0 ? [`unknown_assessment_ids:${unknownIds.join(',')}`] : []),
    ...(returnedIds.length !== expectedIds.length
      ? [`assessment_count_mismatch:${returnedIds.length}/${expectedIds.length}`]
      : [])
  ];

  state.validationProblems = problems.slice(0, 24);
  if (problems.length > 0) {
    state.coverageValid = enrichment.shortlist.length > 0
      && enrichment.shortlist.every((candidate) => state.assessments.has(candidate.id));
    return;
  }

  const returnedById = new Map(output.assessments.map((assessment) => [assessment.id, assessment]));
  state.assessments = new Map(enrichment.promptPackets.map((packet) => [
    packet.id,
    packet.kind === 'profile' ? packet.assessment : returnedById.get(packet.id)!
  ]));
  state.coverageValid = enrichment.shortlist.length > 0
    && enrichment.shortlist.every((candidate) => state.assessments.has(candidate.id));
  rebuildLyricsAwareDecisions(input);
  if (!state.persistenceAttempted && input.persistTrackAssessments) {
    state.persistenceAttempted = true;
    try {
      await input.persistTrackAssessments({
        assessments: output.assessments,
        enrichment,
        context: input.context
      });
    } catch {
      enrichment.diagnostics.cacheWriteFailed += 1;
    }
  }
}

function rebuildLyricsAwareDecisions(input: RunMusicAgentLoopInput): void {
  const state = lyricsAwareRunStates.get(input);
  if (!state?.enrichment) return;
  const packetById = new Map(state.enrichment.promptPackets.map((packet) => [packet.id, packet]));
  const preliminary = state.enrichment.shortlist.flatMap((candidate) => {
    const assessment = state.assessments.get(candidate.id);
    if (!assessment) return [];
    const queryPlan = input.tools.getQueryPlan?.() ?? null;
    const compatibility = evaluateTrackCompatibility({
      context: input.context,
      assessment,
      ...(queryPlan ? { listeningConstraints: queryPlan.listeningConstraints } : {})
    });
    const quality = evaluateCandidateQuality(candidate, qualityFacts(packetById.get(candidate.id)));
    return [{ candidate, assessment, compatibility, quality }];
  });
  const hasAcceptableAlternative = preliminary.some(({ compatibility, quality }) =>
    compatibility.status !== 'conflict' && quality.tier !== 'suspicious'
  );
  state.decisions = new Map(preliminary.map(({ candidate, assessment, compatibility, quality }) => {
    const externalSuspicious = quality.tier === 'suspicious' && !candidate.sources.includes('liked');
    const eligible = !isEnforcementMode(input)
      || (compatibility.status !== 'conflict'
        && (input.lyricsSelectionMode !== 'enforce_all'
          || !externalSuspicious
          || !hasAcceptableAlternative));
    return [candidate.id, { assessment, compatibility, quality, eligible }];
  }));
}

function qualityFacts(packet: ShortlistPromptPacket | undefined): CandidateQualityFacts {
  if (packet?.kind === 'evidence') {
    return {
      lyricStatus: packet.lyricEvidence.lyricStatus,
      creditRoleCount: Object.values(packet.lyricEvidence.credits)
        .filter((names) => names.length > 0).length,
      wikiTags: packet.wikiTags
    };
  }
  return { lyricStatus: 'unknown', creditRoleCount: 0, wikiTags: [] };
}

function isCandidateEligible(candidate: MusicCandidate, input: RunMusicAgentLoopInput): boolean {
  if (isHardFilteredCandidate(candidate)) return false;
  if (!isEnforcementMode(input)) return true;
  return lyricsAwareRunStates.get(input)?.decisions.get(candidate.id)?.eligible === true;
}

function recordLyricsAwareRejection(candidate: MusicCandidate, input: RunMusicAgentLoopInput): void {
  if (!isEnforcementMode(input) || isHardFilteredCandidate(candidate)) return;
  const state = lyricsAwareRunStates.get(input);
  if (!state) return;
  const decision = state.decisions.get(candidate.id);
  if (!decision) {
    state.unassessedDroppedIds.add(candidate.id);
    return;
  }
  if (decision.compatibility.status === 'conflict') {
    state.semanticDroppedIds.add(candidate.id);
    return;
  }
  if (decision.quality.tier === 'suspicious' && !decision.eligible) {
    state.qualityDroppedIds.add(candidate.id);
  }
}

function recordRankedSelectionRejections(
  candidates: MusicCandidate[],
  selected: MusicCandidate[],
  target: number,
  input: RunMusicAgentLoopInput
): void {
  if (!isEnforcementMode(input) || candidates.length === 0) return;
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const lastSelectedIndex = candidates.reduce(
    (last, candidate, index) => selectedIds.has(candidate.id) ? index : last,
    -1
  );
  const cutoff = selected.length >= target && lastSelectedIndex >= 0
    ? lastSelectedIndex
    : candidates.length - 1;
  for (const candidate of candidates.slice(0, cutoff + 1)) {
    if (!selectedIds.has(candidate.id) && !isCandidateEligible(candidate, input)) {
      recordLyricsAwareRejection(candidate, input);
    }
  }
}

function lyricsAwareOutputFields(
  input: RunMusicAgentLoopInput,
  picks: FinalPick[]
): { lyricsAwareDiagnostics?: LyricsAwareDiagnostics } {
  const state = lyricsAwareRunStates.get(input);
  if (!state?.enrichment) return {};
  if (isEnforcementMode(input) && picks.length === 0 && input.candidatePool.count() > 0) {
    state.fallbackSuppressed = true;
  }
  const decisions: LyricsAwareDecisionSummary[] = state.enrichment.shortlist.flatMap((candidate) => {
    const decision = state.decisions.get(candidate.id);
    return decision ? [{
      id: candidate.id,
      compatibility: decision.compatibility.status,
      compatibilityConfidence: decision.compatibility.confidence,
      compatibilityReasons: decision.compatibility.reasons.slice(0, 6),
      quality: decision.quality.tier,
      qualityNegativeSignals: [
        ...decision.quality.strongNegativeSignals,
        ...decision.quality.supportingNegativeSignals
      ].slice(0, 8),
      qualityPositiveSignals: decision.quality.positiveSignals.slice(0, 8),
      eligible: decision.eligible
    }] : [];
  });
  return {
    lyricsAwareDiagnostics: {
      mode: input.lyricsSelectionMode ?? 'off',
      enrichment: state.enrichment.diagnostics,
      promptChars: state.promptChars,
      assessmentCoverageValid: state.coverageValid,
      assessmentValidationProblems: state.validationProblems,
      decisions,
      allReturnedPicksAssessed: picks.every((pick) => state.assessments.has(pick.id)),
      enforcementApplied: isEnforcementMode(input),
      fallbackSuppressed: state.fallbackSuppressed
    }
  };
}

function summarizeCandidatePool(pool: CandidatePool, context: MusicAgentContextSummary): string {
  const options = rankOptions(context);
  const ranked = rankCandidates(pool.list(), 20, options);
  const scoreRows = buildCandidateScoreTableRows(ranked, options);
  return JSON.stringify(ranked.map((candidate, index) => {
    const row = scoreRows[index];
    return {
      id: candidate.id,
      name: candidate.name,
      artist: candidate.artist,
      sources: candidate.sources,
      baseScore: row?.baseScore,
      artistPenalty: row?.artistPenalty,
      trackPenalty: row?.trackPenalty,
      repeatPenalty: row?.repeatPenalty,
      qualityPenalty: row?.qualityPenalty,
      titlePollutionPenalty: row?.titlePollutionPenalty,
      adjustedScore: row?.adjustedScore,
      evidence: candidate.evidence.slice(0, 3)
    };
  }));
}

function rankOptions(context: MusicAgentContextSummary) {
  return {
    artistPenalties: new Map((context.recentArtistPenalties ?? []).map((item) => [item.artist, item.penalty])),
    trackPenalties: new Map((context.recentTrackPenalties ?? []).map((item) => [item.trackKey, item.penalty]))
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

function firstWebDiscoveryDiagnostics(trace: AgentTraceStep[]): WebDiscoveryLogDiagnostics | undefined {
  for (const step of trace) {
    if (step.tool === 'web_music_discovery') {
      return webDiscoveryDiagnosticsFromTraceStep(step);
    }

    const stages = step.observationData?.stages;
    if (!Array.isArray(stages)) continue;
    for (const stage of stages) {
      if (!isRecord(stage) || stage.stage !== 'web_discovery') continue;
      const summary = typeof stage.summary === 'string' ? stage.summary : '';
      if (!summary) continue;
      const candidateCount = typeof stage.candidateCount === 'number' ? stage.candidateCount : step.candidateCount;
      const problems = Array.isArray(stage.problems)
        ? stage.problems.filter((problem): problem is string => typeof problem === 'string')
        : [];
      return {
        step: step.step,
        summary,
        candidateCount,
        ...(problems.length > 0 ? { problems } : {})
      };
    }
  }
  return undefined;
}

function webDiscoveryDiagnosticsFromTraceStep(step: AgentTraceStep): WebDiscoveryLogDiagnostics {
  const parsed = parseObservationSummary(step.observationSummary ?? '');
  return {
    step: step.step,
    summary: parsed.summary || 'web discovery observation unavailable',
    candidateCount: step.candidateCount,
    ...(parsed.problems.length > 0 ? { problems: parsed.problems } : {})
  };
}

function parseObservationSummary(value: string): { summary: string; problems: string[] } {
  const candidateCountIndex = value.indexOf('; candidateCount=');
  const summary = (candidateCountIndex >= 0 ? value.slice(0, candidateCountIndex) : value).trim();
  const problems = value
    .split('; ')
    .filter((part) => part.startsWith('problem='))
    .map((part) => part.slice('problem='.length).trim())
    .filter(Boolean);
  return { summary, problems };
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

function shouldConvergeAfterSkippedTerminalTool(
  toolName: MusicAgentToolName | undefined,
  input: RunMusicAgentLoopInput
): boolean {
  return Boolean(toolName && input.candidatePool.count() >= 2 && CONVERGENCE_TOOL_NAMES.has(toolName));
}

function shouldConvergeAfterSkippedToolBudget(
  toolName: MusicAgentToolName | undefined,
  input: RunMusicAgentLoopInput
): boolean {
  if (!toolName || input.candidatePool.count() < 2) return false;
  if (input.context.request === 'auto-fill' && !CONVERGENCE_TOOL_NAMES.has(toolName)) {
    return hasEnoughAutoFillSkippedRecallCandidates(input);
  }
  return true;
}

function shouldAskFinalAfterNoProgressTool(
  toolName: MusicAgentToolName,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  candidateCountBeforeTool: number
): boolean {
  return (
    modeFromContext(input.context) === 'pick_next' &&
    targetPickCount(input) >= 4 &&
    input.candidatePool.count() >= SKIPPED_TOOL_FINAL_PICK_MIN_CANDIDATES &&
    (input.candidatePool.count() < targetPickCount(input) || isLikedOnlyFallbackPool(input, trace)) &&
    input.candidatePool.count() <= candidateCountBeforeTool &&
    NO_PROGRESS_FINAL_TOOL_NAMES.has(toolName) &&
    hasExecutedExternalRecall(trace)
  );
}

function shouldSupplementSparseExpandRecall(
  toolName: MusicAgentToolName,
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[],
  candidateCountBeforeTool: number
): boolean {
  return (
    toolName === 'expand_queries' &&
    modeFromContext(input.context) === 'pick_next' &&
    targetPickCount(input) >= 4 &&
    input.candidatePool.count() >= SKIPPED_TOOL_FINAL_PICK_MIN_CANDIDATES &&
    hasSparseAutoFillCandidatesAfterNoProgress(input, trace) &&
    input.candidatePool.count() <= candidateCountBeforeTool &&
    hasExecutedExternalRecall(trace)
  );
}

function hasSparseAutoFillCandidatesAfterNoProgress(
  input: RunMusicAgentLoopInput,
  trace: AgentTraceStep[]
): boolean {
  if (isExploreAutoFill(input)) {
    return !hasEnoughAutoFillRankedCandidates(input);
  }
  return input.candidatePool.count() < targetPickCount(input) || isLikedOnlyFallbackPool(input, trace);
}

function isLikedOnlyFallbackPool(input: RunMusicAgentLoopInput, trace: AgentTraceStep[]): boolean {
  return (
    isExploreAutoFill(input) &&
    countNonLikedCandidates(input) === 0 &&
    countLikedCandidates(input) > 0 &&
    hasExecutedExternalRecall(trace)
  );
}

function hasEnoughAutoFillSkippedRecallCandidates(input: RunMusicAgentLoopInput): boolean {
  return (
    countNonLikedCandidates(input) >= targetPickCount(input) ||
    (countNonLikedCandidates(input) > 0 && shouldConvergeAfterAutoFillRecallMix(input))
  );
}

function skippedToolBudgetThought(
  rewrite: ToolRewrite | undefined,
  toolName: MusicAgentToolName | undefined,
  input: RunMusicAgentLoopInput,
  shouldConvergeAfterSkippedBudget: boolean
): string {
  if (rewrite) return 'forced recall skipped by budget';
  if (shouldConvergeAfterSkippedTerminalTool(toolName, input)) return 'terminal tool skipped by budget';
  if (shouldConvergeAfterSkippedBudget) return 'tool budget exhausted with sufficient candidates';
  return 'tool call skipped by budget';
}

function shouldAskExtraFinalPick(
  toolName: MusicAgentToolName,
  input: RunMusicAgentLoopInput,
  startedAt: number,
  step: number,
  llmCalls: number
): boolean {
  return (
    CONVERGENCE_TOOL_NAMES.has(toolName) &&
    hasExtraFinalPickBudget(input, startedAt, step, llmCalls)
  );
}

function hasExtraFinalPickBudget(
  input: RunMusicAgentLoopInput,
  startedAt: number,
  step: number,
  llmCalls: number,
  minCandidates = EXTRA_FINAL_PICK_MIN_CANDIDATES
): boolean {
  const remainingMs = input.budget.maxMs - (Date.now() - startedAt);
  return (
    input.candidatePool.count() >= minCandidates &&
    step < input.budget.maxSteps &&
    llmCalls < input.budget.maxLlmCalls &&
    remainingMs >= extraFinalPickRemainingMs(input.budget.maxMs)
  );
}

function extraFinalPickRemainingMs(maxMs: number): number {
  return Math.min(EXTRA_FINAL_PICK_MAX_REMAINING_MS, Math.ceil(maxMs * EXTRA_FINAL_PICK_REMAINING_RATIO));
}

function shouldSupplementAutoFillRecall(toolName: MusicAgentToolName, input: RunMusicAgentLoopInput): boolean {
  return modeFromContext(input.context) === 'pick_next' && toolName === 'recall_from_liked';
}

function shouldConvergeAfterExternalRecallTool(toolName: MusicAgentToolName, input: RunMusicAgentLoopInput): boolean {
  return (
    modeFromContext(input.context) === 'pick_next' &&
    EXTERNAL_RECALL_TOOL_NAMES.has(toolName) &&
    shouldConvergeAfterAutoFillRecallMix(input)
  );
}

function shouldSupplementSparseAutoFillRank(toolName: MusicAgentToolName, input: RunMusicAgentLoopInput): boolean {
  return (
    modeFromContext(input.context) === 'pick_next' &&
    toolName === 'rank_candidates' &&
    !hasEnoughAutoFillRankedCandidates(input)
  );
}

function hasEnoughAutoFillRankedCandidates(input: RunMusicAgentLoopInput): boolean {
  const explicitTargetPickCount = input.targetPickCount === undefined ? null : targetPickCount(input);
  const nonLikedTarget = isExploreAutoFill(input) && explicitTargetPickCount !== null
    ? autoFillNonLikedConvergenceTarget(input)
    : explicitTargetPickCount;
  return (
    (nonLikedTarget !== null && countNonLikedCandidates(input) >= nonLikedTarget) ||
    shouldConvergeAfterAutoFillRecallMix(input)
  );
}

function shouldConvergeAfterAutoFillRecallMix(input: RunMusicAgentLoopInput): boolean {
  const nonLikedCount = countNonLikedCandidates(input);
  const explicitTargetPickCount = input.targetPickCount === undefined ? null : targetPickCount(input);
  if (nonLikedCount >= autoFillNonLikedConvergenceTarget(input)) {
    return true;
  }
  if (isExploreAutoFill(input)) {
    return explicitTargetPickCount !== null &&
      nonLikedCount >= minExternalCandidatesBeforeLikedTail(explicitTargetPickCount) &&
      countLikedCandidates(input) > 0 &&
      input.candidatePool.count() >= explicitTargetPickCount;
  }
  return (
    input.candidatePool.count() >= autoFillTotalConvergenceTarget(input)
  );
}

function shouldSupplementLikedTailFallback(input: RunMusicAgentLoopInput): boolean {
  if (!isExploreAutoFill(input)) return false;
  const explicitTargetPickCount = input.targetPickCount === undefined ? null : targetPickCount(input);
  if (explicitTargetPickCount === null) return false;
  const nonLikedCount = countNonLikedCandidates(input);
  return (
    nonLikedCount >= minExternalCandidatesBeforeLikedTail(explicitTargetPickCount) &&
    input.candidatePool.count() < explicitTargetPickCount
  );
}

function rankedFallbackSelectableCandidates(
  candidates: MusicCandidate[],
  input: RunMusicAgentLoopInput
): MusicCandidate[] {
  if (!shouldBlockLikedOnlyRankedFallback(input) || countNonLikedCandidates(input) > 0) {
    return candidates;
  }
  return [];
}

function shouldBlockLikedOnlyRankedFallback(input: RunMusicAgentLoopInput): boolean {
  const explicitTargetPickCount = input.targetPickCount === undefined ? null : targetPickCount(input);
  return isExploreAutoFill(input) && explicitTargetPickCount !== null && explicitTargetPickCount >= 4;
}

function shouldRejectLikedOnlyFinalPicks(input: RunMusicAgentLoopInput): boolean {
  return (
    shouldBlockLikedOnlyRankedFallback(input) &&
    countNonLikedCandidates(input) === 0 &&
    countLikedCandidates(input) > 0
  );
}

function isExploreAutoFill(input: RunMusicAgentLoopInput): boolean {
  return modeFromContext(input.context) === 'pick_next' && input.context.discoveryMode !== 'comfort';
}

function countLikedCandidates(input: RunMusicAgentLoopInput): number {
  return input.candidatePool.list().filter((candidate) => candidate.sources.includes('liked')).length;
}

function minExternalCandidatesBeforeLikedTail(target: number): number {
  return Math.ceil(Math.max(1, target) * 0.5);
}

function autoFillNonLikedConvergenceTarget(input: RunMusicAgentLoopInput): number {
  return Math.max(AUTO_FILL_MIN_NON_LIKED_CONVERGENCE_TARGET, targetPickCount(input) * 2);
}

function autoFillTotalConvergenceTarget(input: RunMusicAgentLoopInput): number {
  return Math.max(AUTO_FILL_MIN_TOTAL_CONVERGENCE_TARGET, targetPickCount(input) * 2);
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
