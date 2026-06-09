import { describe, expect, it, vi } from 'vitest';
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

  it('returns browser-console candidate score table rows with successful picks', async () => {
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

    expect(result.candidateScoreTable).toEqual([
      expect.objectContaining({
        rank: 1,
        id: '101',
        song: 'Soft Song',
        artist: 'Singer',
        adjustedScore: expect.any(Number)
      })
    ]);
  });

  it('falls back to ranked candidates when final picks are outside the whitelist pool', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));
    const fallbackLogger = vi.fn();
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
      budget: budget(),
      fallbackLogger
    });

    expect(musicAgentRunOutputSchema.parse(result).status).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(1);
    expect(result.picks[0]).toMatchObject({ id: '101', reason: 'ranked fallback', source: 'liked' });
    expect(result.say).toBe('我从候选池里挑了一首更适合现在的歌。');
    expect(result.say).not.toMatch(/^fallback:/i);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'final_rejected',
      mode: 'chat_recommend',
      status: 'ok',
      candidateCount: 1,
      pickCount: 1,
      lastTraceStep: expect.objectContaining({
        thoughtSummary: 'final rejected by candidate pool whitelist'
      })
    }));
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

  it('asks the LLM to finalize after ranking fewer than two candidates', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '这首更贴近当前语境。',
        picks: [{ id: '101', reason: '更贴近当前语境', source: 'liked' }],
        rejected: []
      })
    ]);
    let toolCalls = 0;

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => {
          toolCalls += 1;
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        }
      },
      budget: budget(),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(1);
    expect(result.picks.map((pick) => pick.id)).toEqual(['101']);
    expect(result.say).toBe('这首更贴近当前语境。');
    expect(toolCalls).toBe(1);
    expect(llmClient.calls).toHaveLength(2);
    expect(fallbackLogger).not.toHaveBeenCalled();
  });

  it('converges deterministically after ranking enough candidates', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    pool.upsert(candidate({
      id: '102',
      name: 'Bright Song',
      artist: 'Another Singer',
      scores: { ...candidate().scores, intentMatch: 0.8 }
    }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} })
    ]);
    let toolCalls = 0;

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => {
          toolCalls += 1;
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          throw new Error('should not keep recalling after ranked convergence');
        }
      },
      budget: budget({ maxLlmCalls: 10, maxSteps: 10 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['101', '102']);
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(toolCalls).toBe(1);
    expect(llmClient.calls).toHaveLength(1);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 2,
      pickCount: 2
    }));
  });

  it('uses one extra LLM call to choose from ranked candidates when budget remains', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    pool.upsert(candidate({
      id: '102',
      name: 'Bright Song',
      artist: 'Another Singer',
      scores: { ...candidate().scores, intentMatch: 0.8 }
    }));
    pool.upsert(candidate({
      id: '103',
      name: 'Third Song',
      artist: 'Third Singer',
      scores: { ...candidate().scores, intentMatch: 0.7 }
    }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我从排序后的候选里选这两首。',
        picks: [
          { id: '103', reason: '更有新鲜感', source: 'liked' },
          { id: '101', reason: '保留用户偏好锚点', source: 'liked' }
        ],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => ({ summary: 'ranked candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我从排序后的候选里选这两首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['103', '101']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
    expect(llmClient.calls).toHaveLength(2);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      step: 2,
      llmCalls: 2
    }));
  });

  it('does not spend an extra final-pick call after the LLM budget is exhausted', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    pool.upsert(candidate({
      id: '102',
      name: 'Bright Song',
      artist: 'Another Singer',
      scores: { ...candidate().scores, intentMatch: 0.8 }
    }));
    pool.upsert(candidate({
      id: '103',
      name: 'Third Song',
      artist: 'Third Singer',
      scores: { ...candidate().scores, intentMatch: 0.7 }
    }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: 'should not be called',
        picks: [{ id: '103', reason: 'should not be used', source: 'liked' }],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => ({ summary: 'ranked candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 1, maxSteps: 2 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(llmClient.calls).toHaveLength(1);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      llmCalls: 1
    }));
  });

  it('does not spend an extra final-pick call after the step budget is exhausted', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    pool.upsert(candidate({
      id: '102',
      name: 'Bright Song',
      artist: 'Another Singer',
      scores: { ...candidate().scores, intentMatch: 0.8 }
    }));
    pool.upsert(candidate({
      id: '103',
      name: 'Third Song',
      artist: 'Third Singer',
      scores: { ...candidate().scores, intentMatch: 0.7 }
    }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: 'should not be called',
        picks: [{ id: '103', reason: 'should not be used', source: 'liked' }],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => ({ summary: 'ranked candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 1 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(llmClient.calls).toHaveLength(1);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      step: 1,
      llmCalls: 1
    }));
  });

  it('returns aborted when the extra final-pick call is aborted', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));
    pool.upsert(candidate({ id: '102', name: 'Bright Song', artist: 'Another Singer' }));
    pool.upsert(candidate({ id: '103', name: 'Third Song', artist: 'Third Singer' }));
    const controller = new AbortController();
    const fallbackLogger = vi.fn();
    let calls = 0;
    const llmClient: MusicAgentLlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
            model: 'fake-loop-model'
          };
        }
        controller.abort(new Error('timeout'));
        throw new Error('aborted');
      }
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => ({ summary: 'ranked candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2 }),
      signal: controller.signal,
      fallbackLogger
    });

    expect(result.status).toBe('aborted');
    expect(result.picks).toEqual([]);
    expect(calls).toBe(2);
    expect(fallbackLogger).not.toHaveBeenCalled();
  });

  it('converges deterministically when only one LLM call remains and candidates are enough', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));
    pool.upsert(candidate({ id: '102', name: 'Bright Song', artist: 'Another Singer' }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'more' } })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        recall_from_liked: async () => ({ summary: 'liked recall added 0 candidates', candidateCount: pool.count() }),
        recall_from_ncm_search: async () => {
          throw new Error('should not spend the final LLM call on more tools');
        }
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 10 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(2);
    expect(llmClient.calls).toHaveLength(1);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 2,
      pickCount: 2
    }));
  });

  it('auto-fill supplements liked recall with search, style, and trend before converging', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 30 } }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 30 } })
    ]);
    const calls: string[] = [];

    function addCandidates(source: 'liked' | 'search' | 'style_expansion' | 'trend', count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        pool.upsert(candidate({
          id: `${source}-${index + 1}`,
          name: `${source} ${index + 1}`,
          artist: `${source} Artist ${index + 1 + start}`,
          sources: [source]
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        expand_queries: async () => {
          calls.push('expand_queries');
          return { summary: 'expanded queries', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          addCandidates('liked', 10);
          return { summary: 'liked recall added 10 candidates', candidateCount: pool.count() };
        },
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          addCandidates('search', 3);
          return { summary: 'search recall added 3 candidates', candidateCount: pool.count() };
        },
        recall_from_style_expansion: async () => {
          calls.push('recall_from_style_expansion');
          addCandidates('style_expansion', 3);
          return { summary: 'style recall added 3 candidates', candidateCount: pool.count() };
        },
        recall_from_trending: async () => {
          calls.push('recall_from_trending');
          addCandidates('trend', 2);
          return { summary: 'trend recall added 2 candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 10, maxSteps: 10, maxToolCalls: 10 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(calls).toEqual([
      'recall_from_liked',
      'expand_queries',
      'recall_from_ncm_search',
      'recall_from_style_expansion',
      'recall_from_trending'
    ]);
    expect(llmClient.calls).toHaveLength(1);
    expect(pool.list().filter((item) => !item.sources.includes('liked'))).toHaveLength(8);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 18
    }));
  });

  it('prefers one aggregate auto-fill recall tool so rank still has budget', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);
    const calls: string[] = [];

    function addCandidates(source: 'liked' | 'search', count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        pool.upsert(candidate({
          id: `${source}-${start + index + 1}`,
          name: `${source} ${start + index + 1}`,
          artist: `${source} Artist ${start + index + 1}`,
          sources: [source]
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          addCandidates('liked', 10);
          return { summary: 'liked recall added 10 candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          addCandidates('search', 8);
          return { summary: 'auto-fill mix added 8 candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          calls.push('rank_candidates');
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        },
        recall_from_ncm_search: async () => {
          throw new Error('aggregate tool should replace separate search recall');
        },
        recall_from_style_expansion: async () => {
          throw new Error('aggregate tool should replace separate style recall');
        },
        recall_from_trending: async () => {
          throw new Error('aggregate tool should replace separate trend recall');
        }
      },
      budget: budget({ maxLlmCalls: 10, maxSteps: 10, maxToolCalls: 3 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(calls).toEqual(['recall_from_liked', 'recall_auto_fill_mix']);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      toolCalls: 2,
      candidateCount: 18
    }));
  });

  it('auto-fill supplements sparse ranked candidates before converging', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'summer' } }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} })
    ]);
    const calls: string[] = [];

    function addCandidates(source: 'search' | 'style_expansion' | 'trend', count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        pool.upsert(candidate({
          id: `${source}-${start + index + 1}`,
          name: `${source} ${start + index + 1}`,
          artist: `${source} Artist ${start + index + 1}`,
          sources: [source]
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        expand_queries: async () => {
          calls.push('expand_queries');
          return { summary: 'expanded queries', candidateCount: pool.count() };
        },
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          addCandidates('search', calls.filter((call) => call === 'recall_from_ncm_search').length === 1 ? 4 : 2);
          return { summary: 'search recall added candidates', candidateCount: pool.count() };
        },
        recall_from_style_expansion: async () => {
          calls.push('recall_from_style_expansion');
          addCandidates('style_expansion', 2);
          return { summary: 'style recall added candidates', candidateCount: pool.count() };
        },
        recall_from_trending: async () => {
          calls.push('recall_from_trending');
          addCandidates('trend', 2);
          return { summary: 'trend recall added candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          calls.push('rank_candidates');
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          throw new Error('should converge after supplementing sparse ranked candidates');
        }
      },
      budget: budget({ maxLlmCalls: 10, maxSteps: 10, maxToolCalls: 10 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked convergence')).toBe(true);
    expect(calls).toEqual([
      'recall_from_ncm_search',
      'rank_candidates',
      'expand_queries',
      'recall_from_ncm_search',
      'recall_from_style_expansion',
      'recall_from_trending'
    ]);
    expect(pool.count()).toBe(10);
    expect(pool.list().filter((item) => !item.sources.includes('liked'))).toHaveLength(10);
    expect(llmClient.calls).toHaveLength(2);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 10
    }));
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
