import { describe, expect, it } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates.js';
import { runMusicAgentLoop } from '../../src/server/music-agent/loop.js';
import type { MusicAgentToolRegistry } from '../../src/server/music-agent/tools.js';
import { musicAgentRunOutputSchema } from '../../src/server/music-agent/schema.js';
import type {
  AgentBudget,
  MusicAgentContextSummary,
  MusicAgentLlmClient,
  MusicCandidate
} from '../../src/server/music-agent/schema.js';
import type { LlmCompleteOptions, LlmMessage, LlmResponse } from '../../src/server/llm/client.js';

class LoopFakeLlmClient implements MusicAgentLlmClient {
  readonly calls: Array<{ messages: LlmMessage[]; opts?: LlmCompleteOptions }> = [];
  private readonly responses: string[];
  private readonly delayMs: number;

  constructor(responses: string[], delayMs = 0) {
    this.responses = [...responses];
    this.delayMs = delayMs;
  }

  async complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmResponse> {
    this.calls.push({ messages, opts });
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return { content: this.responses.shift() ?? '{}', model: 'fake-loop-model' };
  }
}

function budget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return {
    maxMs: 10_000,
    maxSteps: 6,
    maxLlmCalls: 4,
    maxToolCalls: 3,
    maxNcmSearches: 0,
    maxPlaylistFetches: 0,
    maxTrendFetchMs: 0,
    maxCandidates: 20,
    ...overrides
  };
}

function context(overrides: Partial<MusicAgentContextSummary> = {}): MusicAgentContextSummary {
  return {
    request: 'chat-recommend',
    currentUserText: '想听轻快一点的女声',
    currentMoment: {
      localTime: '2026-06-04T14:00:00+08:00',
      daypart: 'afternoon',
      weather: null,
      dailyTheme: '轻快'
    },
    activeDirective: '接下来保持轻快女声',
    currentPlanSegment: null,
    tasteSummary: '偏好华语女声',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: '',
    ...overrides
  };
}

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: '101',
    name: 'Soft Song',
    artist: 'Singer',
    sources: ['liked'],
    evidence: ['liked by user'],
    scores: {
      intentMatch: 0.9,
      tasteMatch: 0.8,
      timeFit: 0.7,
      planFit: 0.4,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.8
    },
    ...overrides
  };
}

describe('runMusicAgentLoop', () => {
  it('calls a whitelisted tool and accepts a final pick from the candidate pool', async () => {
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 5 } }),
      JSON.stringify({
        type: 'final',
        say: '这首来自你的红心歌单。',
        picks: [{ id: '101', reason: '轻快女声且你喜欢过', source: 'liked' }],
        rejected: []
      })
    ]);
    const pool = new CandidatePool();
    const tools: MusicAgentToolRegistry = {
      recall_from_liked: async () => {
        pool.upsert(candidate());
        return { summary: 'recalled liked tracks', candidateCount: pool.count() };
      }
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools,
      budget: budget()
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.picks[0]).toMatchObject({
      id: '101',
      name: 'Soft Song',
      artist: 'Singer',
      source: 'liked'
    });
    expect(result.trace.some((step) => step.tool === 'recall_from_liked')).toBe(true);
    expect(llmClient.calls[0].opts).toMatchObject({ temperature: 0.2, maxTokens: 1000 });
  });

  it('falls back to ranked candidates when final picks are outside the whitelist pool', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '选这首。',
        picks: [{ id: '999', reason: '模型觉得合适', source: 'liked' }],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {},
      budget: budget()
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(1);
    expect(result.picks[0]).toMatchObject({ id: '101', reason: 'ranked fallback', source: 'liked' });
    expect(result.say).toBe('我从候选池里挑了一首更适合现在的歌。');
    expect(result.say).not.toMatch(/^fallback:/i);
  });

  it('does not execute tools when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let toolCalls = 0;
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: new CandidatePool(),
      tools: {
        recall_from_liked: async () => {
          toolCalls += 1;
          return { summary: 'should not run', candidateCount: 1 };
        }
      },
      budget: budget(),
      signal: controller.signal
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('aborted');
    expect(result.status).toBe('aborted');
    expect(toolCalls).toBe(0);
    expect(result.picks).toEqual([]);
    expect(result.say.toLowerCase()).toContain('aborted');
    expect(llmClient.calls).toHaveLength(0);
  });

  it('records unavailable tool observations and falls back instead of throwing', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'write_database', input: { id: '999' } }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {},
      budget: budget({ maxSteps: 2, maxLlmCalls: 2 })
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.picks[0].id).toBe('101');
    expect(result.say).not.toMatch(/^fallback:/i);
    expect(result.trace.some((step) => /unavailable|unknown/i.test(step.observationSummary ?? ''))).toBe(true);
  });

  it('parses fenced and prose-wrapped JSON, and malformed output defaults without crashing', async () => {
    const fencedLlm = new LoopFakeLlmClient([
      '```json\n{"type":"final","say":"ok","picks":[{"id":"101","reason":"fits","source":"liked"}],"rejected":[]}\n```'
    ]);
    const proseLlm = new LoopFakeLlmClient([
      '我会返回 JSON： {"type":"final","say":"ok","picks":[{"id":"101","reason":"fits","source":"liked"}],"rejected":[]} 就这样。'
    ]);
    const malformedLlm = new LoopFakeLlmClient(['not json at all']);

    for (const llmClient of [fencedLlm, proseLlm]) {
      const pool = new CandidatePool();
      pool.upsert(candidate({ id: '101' }));

      const result = await runMusicAgentLoop({
        llmClient,
        context: context(),
        candidatePool: pool,
        tools: {},
        budget: budget()
      });

      expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
      expect(result.status).toBe('ok');
      expect(result.picks[0].id).toBe('101');
    }

    const malformedPool = new CandidatePool();
    malformedPool.upsert(candidate({ id: '101' }));
    const malformedResult = await runMusicAgentLoop({
      llmClient: malformedLlm,
      context: context(),
      candidatePool: malformedPool,
      tools: {},
      budget: budget({ maxSteps: 1, maxLlmCalls: 1 })
    });

    expect(musicAgentRunOutputSchema.parse(malformedResult).status).toBe('ok');
    expect(malformedResult.status).toBe('ok');
    expect(malformedResult.picks[0].id).toBe('101');
    expect(malformedResult.say).not.toMatch(/^fallback:/i);
  });

  it('stops at max tool, llm, and step budgets without looping forever', async () => {
    const endlessToolCalls = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);
    let toolCalls = 0;

    const toolLimited = await runMusicAgentLoop({
      llmClient: endlessToolCalls,
      context: context(),
      candidatePool: new CandidatePool(),
      tools: {
        rank_candidates: async () => {
          toolCalls += 1;
          return { summary: 'ranked', candidateCount: 0 };
        }
      },
      budget: budget({ maxToolCalls: 1, maxLlmCalls: 4, maxSteps: 4 })
    });

    expect(toolCalls).toBe(1);
    expect(musicAgentRunOutputSchema.parse(toolLimited).status).toBe('empty_pool');
    expect(toolLimited.status).toBe('empty_pool');
    expect(toolLimited.picks).toEqual([]);
    expect(toolLimited.say).not.toMatch(/^fallback:/i);

    const llmLimited = await runMusicAgentLoop({
      llmClient: new LoopFakeLlmClient([
        JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
        JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
      ]),
      context: context(),
      candidatePool: new CandidatePool(),
      tools: {
        rank_candidates: async () => ({ summary: 'ranked', candidateCount: 0 })
      },
      budget: budget({ maxLlmCalls: 1, maxToolCalls: 4, maxSteps: 4 })
    });

    expect(llmLimited.trace).toHaveLength(1);
    expect(musicAgentRunOutputSchema.parse(llmLimited).status).toBe('empty_pool');
    expect(llmLimited.status).toBe('empty_pool');
    expect(llmLimited.say).not.toMatch(/^fallback:/i);

    const stepLimited = await runMusicAgentLoop({
      llmClient: new LoopFakeLlmClient([
        JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
        JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
      ]),
      context: context(),
      candidatePool: new CandidatePool(),
      tools: {
        rank_candidates: async () => ({ summary: 'ranked', candidateCount: 0 })
      },
      budget: budget({ maxSteps: 1, maxLlmCalls: 4, maxToolCalls: 4 })
    });

    expect(stepLimited.trace).toHaveLength(1);
    expect(musicAgentRunOutputSchema.parse(stepLimited).status).toBe('empty_pool');
    expect(stepLimited.status).toBe('empty_pool');
    expect(stepLimited.say).not.toMatch(/^fallback:/i);
  });

  it('does not execute tools when the LLM call exceeds maxMs', async () => {
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} })
    ], 20);
    let toolCalls = 0;

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: new CandidatePool(),
      tools: {
        recall_from_liked: async () => {
          toolCalls += 1;
          return { summary: 'should not run', candidateCount: 0 };
        }
      },
      budget: budget({ maxMs: 1 })
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('empty_pool');
    expect(result.status).toBe('empty_pool');
    expect(toolCalls).toBe(0);
    expect(result.say).not.toMatch(/^fallback:/i);
  });
});
