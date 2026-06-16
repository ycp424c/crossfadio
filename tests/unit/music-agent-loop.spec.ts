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

function expectProviderSafeFinalPickResponseFormat(responseFormat: LlmCompleteOptions['responseFormat'] | undefined): void {
  expect(responseFormat).toEqual({ type: 'json_object' });
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
    expect(llmClient.calls[0].opts).toMatchObject({
      temperature: 0.2,
      maxTokens: 1400,
      thinking: { type: 'disabled' }
    });
  });

  it('keeps structured tool observation diagnostics in trace steps', async () => {
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_auto_fill_mix', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '这首歌适合现在。',
        picks: [{ id: '101', reason: '候选诊断完整且可播放', source: 'search' }],
        rejected: []
      })
    ]);
    const pool = new CandidatePool();
    const tools: MusicAgentToolRegistry = {
      recall_auto_fill_mix: async () => {
        pool.upsert(candidate({
          sources: ['search'],
          evidence: ['web verified'],
          artist: 'Web Artist'
        }));
        return {
          summary: 'auto-fill mix completed with full diagnostics',
          candidateCount: pool.count(),
          data: {
            stages: [
              { stage: 'web_discovery', summary: 'web discovery skipped: cooldown active.', problems: ['cooldown active'] },
              { stage: 'web_hint_recall', summary: 'web hint entity recall added 0 candidates from 0 entities.', problems: [] }
            ]
          }
        };
      }
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools,
      budget: budget(),
      mode: 'pick_next',
      targetPickCount: 1
    });

    expect(result.status).toBe('ok');
    expect(result.trace[0]).toMatchObject({
      tool: 'recall_auto_fill_mix',
      observationData: {
        stages: [
          expect.objectContaining({ stage: 'web_discovery', summary: expect.stringContaining('cooldown active') }),
          expect.objectContaining({ stage: 'web_hint_recall' })
        ]
      }
    });
  });

  it('accepts final picks up to the target pick count', async () => {
    const pool = new CandidatePool();
    for (let index = 1; index <= 5; index += 1) {
      pool.upsert(candidate({
        id: `pick-${index}`,
        name: `Batch Pick ${index}`,
        artist: `Artist ${index}`
      }));
    }
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '我一次排好了五首。',
        picks: [1, 2, 3, 4, 5].map((index) => ({
          id: `pick-${index}`,
          reason: `第 ${index} 首适合当前队列`,
          source: 'liked'
        })),
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {},
      budget: budget(),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['pick-1', 'pick-2', 'pick-3', 'pick-4', 'pick-5']);
  });

  it('keeps a partial auto-fill batch when final picks cover at least half the target', async () => {
    const pool = new CandidatePool();
    for (let index = 1; index <= 5; index += 1) {
      pool.upsert(candidate({
        id: `pick-${index}`,
        name: `Partial Pick ${index}`,
        artist: `Artist ${index}`
      }));
    }
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '三首已经够贴合。',
        picks: [
          { id: 'pick-1', reason: '开头最贴合', source: 'liked' },
          { id: 'pick-3', reason: '保持变化', source: 'liked' },
          { id: 'pick-5', reason: '收尾自然', source: 'liked' }
        ],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {},
      budget: budget(),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['pick-1', 'pick-3', 'pick-5']);
    expect(result.picks.some((pick) => pick.reason === 'ranked backfill')).toBe(false);
    expect(result.finalPickDiagnostics).toEqual({
      targetPickCount: 5,
      rawPickCount: 3,
      eligiblePickCount: 3,
      acceptedPickCount: 3,
      droppedPickCount: 0,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 0,
      rejectedPickCount: 0
    });
  });

  it('ranked backfills from the same candidate pool when final picks are below half the target', async () => {
    const pool = new CandidatePool();
    for (let index = 1; index <= 5; index += 1) {
      pool.upsert(candidate({
        id: `pick-${index}`,
        name: `Backfill Pick ${index}`,
        artist: `Artist ${index}`
      }));
    }
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '先选两首最稳的。',
        picks: [
          { id: 'pick-1', reason: '开头最贴合', source: 'liked' },
          { id: 'pick-3', reason: '保持变化', source: 'liked' }
        ],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {},
      budget: budget(),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['pick-1', 'pick-3', 'pick-2', 'pick-4', 'pick-5']);
    expect(result.picks.slice(2).every((pick) => pick.reason === 'ranked backfill')).toBe(true);
    expect(result.finalPickDiagnostics).toEqual({
      targetPickCount: 5,
      rawPickCount: 2,
      eligiblePickCount: 2,
      acceptedPickCount: 2,
      droppedPickCount: 0,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 3,
      rejectedPickCount: 0
    });
  });

  it('ranked backfills when final picks are empty', async () => {
    const pool = new CandidatePool();
    for (let index = 1; index <= 3; index += 1) {
      pool.upsert(candidate({
        id: `pick-${index}`,
        name: `Empty Final Backfill ${index}`,
        artist: `Artist ${index}`
      }));
    }
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '没有足够明确的模型选择。',
        picks: [],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {},
      budget: budget(),
      targetPickCount: 3
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['pick-1', 'pick-2', 'pick-3']);
    expect(result.picks.every((pick) => pick.reason === 'ranked backfill')).toBe(true);
    expect(result.finalPickDiagnostics).toEqual({
      targetPickCount: 3,
      rawPickCount: 0,
      eligiblePickCount: 0,
      acceptedPickCount: 0,
      droppedPickCount: 0,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 3,
      rejectedPickCount: 0
    });
  });

  it('dedupes repeated title motifs before returning partial auto-fill batches', async () => {
    const pool = new CandidatePool();
    const baseScores = candidate().scores;
    const tracks: Array<Partial<MusicCandidate>> = [
      {
        id: 'olive-afternoon',
        name: 'オリーブの午后',
        artist: 'Artist A',
        scores: { ...baseScores, intentMatch: 1 }
      },
      {
        id: 'museum-afternoon',
        name: '美術館の午後 (Bijutsukan no Gogo) - Museum Afternoon',
        artist: 'Artist B',
        scores: { ...baseScores, intentMatch: 0.99 }
      },
      {
        id: 'home',
        name: '温暖, 安静, 回不去的家',
        artist: 'Artist C',
        scores: { ...baseScores, intentMatch: 0.9 }
      },
      {
        id: 'evening-walk',
        name: 'Evening Walk',
        artist: 'Artist D',
        scores: { ...baseScores, intentMatch: 0.86 }
      },
      {
        id: 'rain-lights',
        name: 'Rain Lights',
        artist: 'Artist E',
        scores: { ...baseScores, intentMatch: 0.82 }
      },
      {
        id: 'cloudy-afternoon',
        name: '中原めいこ - Cloudyな午後',
        artist: 'Artist F',
        scores: { ...baseScores, intentMatch: 0.98 }
      },
      {
        id: 'train-window',
        name: 'Train Window',
        artist: 'Artist G',
        scores: { ...baseScores, intentMatch: 0.7 }
      }
    ];
    for (const track of tracks) {
      pool.upsert(candidate(track));
    }
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '一次排好五首。',
        picks: [
          { id: 'olive-afternoon', reason: '温暖轻快', source: 'liked' },
          { id: 'museum-afternoon', reason: '同样适合下午', source: 'liked' },
          { id: 'home', reason: '放松过渡', source: 'liked' },
          { id: 'evening-walk', reason: '继续舒缓', source: 'liked' },
          { id: 'rain-lights', reason: '保持柔和', source: 'liked' }
        ],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {},
      budget: budget(),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual([
      'olive-afternoon',
      'home',
      'evening-walk',
      'rain-lights'
    ]);
    expect(result.picks.some((pick) => pick.reason === 'ranked backfill')).toBe(false);
    expect(result.finalPickDiagnostics).toEqual({
      targetPickCount: 5,
      rawPickCount: 5,
      eligiblePickCount: 5,
      acceptedPickCount: 4,
      droppedPickCount: 1,
      titleMotifDroppedCount: 1,
      rankedBackfillCount: 0,
      rejectedPickCount: 0
    });
  });

  it('does not ranked-backfill chat recommendations beyond the final picks', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({
      id: 'chat-pick-1',
      name: 'Requested Song',
      artist: 'Requested Artist'
    }));
    pool.upsert(candidate({
      id: 'chat-pick-2',
      name: 'Adjacent Song',
      artist: 'Adjacent Artist'
    }));
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '这首最符合你的请求。',
        picks: [
          { id: 'chat-pick-1', reason: '用户明确想听这一类', source: 'liked' }
        ],
        rejected: []
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'chat-recommend' }),
      candidatePool: pool,
      tools: {},
      budget: budget()
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['chat-pick-1']);
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

  it('includes track penalty and adjusted score in the LLM candidate summary', async () => {
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'final',
        say: '选择未被长周期重复惩罚压低的候选。',
        picks: [{ id: 'stay-with-me', reason: '重复惩罚更低且仍贴合当前请求', source: 'liked' }],
        rejected: []
      })
    ]);
    const pool = new CandidatePool();
    pool.upsert(candidate({
      id: 'plastic-love',
      name: 'プラスティック・ラヴ',
      artist: '竹内まりや',
      scores: { ...candidate().scores, intentMatch: 1 }
    }));
    pool.upsert(candidate({
      id: 'stay-with-me',
      name: '真夜中のドア〜stay with me',
      artist: '松原みき',
      scores: { ...candidate().scores, intentMatch: 0.92 }
    }));

    await runMusicAgentLoop({
      llmClient,
      context: context({
        recentTrackPenalties: [
          { trackKey: 'プラスティックラヴ::竹内まりや', title: 'プラスティック・ラヴ', artist: '竹内まりや', penalty: 0.22 },
          { trackKey: '真夜中のドアstaywithme::松原みき', title: '真夜中のドア〜stay with me', artist: '松原みき', penalty: 0.04 }
        ]
      }),
      candidatePool: pool,
      tools: {},
      budget: budget()
    });

    const prompt = llmClient.calls[0].messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('"trackPenalty":0.04');
    expect(prompt).toContain('"artistPenalty":0');
    expect(prompt).toContain('"repeatPenalty":0');
    expect(prompt).toContain('"adjustedScore"');
    expect(prompt).not.toContain('"id":"plastic-love","name":"プラスティック・ラヴ","artist":"竹内まりや","sources":["liked"],"score"');
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
      }),
      traceLastSteps: expect.arrayContaining([
        expect.objectContaining({ thoughtSummary: 'final rejected by candidate pool whitelist' })
      ]),
      candidateScoreTablePreview: [
        expect.objectContaining({ id: '101', song: 'Soft Song' })
      ],
      candidateScoreTableCount: 1
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
    expect(llmClient.calls[1].messages.map((message) => message.content).join('\n')).not.toContain('tool_call');
    const finalPrompt = llmClient.calls[1].messages.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('"type":"final"');
    expect(finalPrompt).toContain('候选池数量达到或超过目标数量时，必须尽量返回 2 首');
    expect(finalPrompt).toContain('如果少于 2 首，必须在 rejected 里为每个缺口说明原因');
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[1].opts?.responseFormat);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      finalPickDiagnostics: expect.objectContaining({
        targetPickCount: 2,
        rawPickCount: 2,
        droppedPickCount: 0,
        rankedBackfillCount: 0,
        rejectedPickCount: 0
      }),
      step: 2,
      llmCalls: 2
    }));
  });

  it('rejects liked-only extra final picks for large explore auto-fill batches', async () => {
    const pool = new CandidatePool();
    for (let index = 1; index <= 5; index += 1) {
      pool.upsert(candidate({
        id: `liked-only-${index}`,
        name: `Liked Only ${index}`,
        artist: `Liked Artist ${index}`,
        sources: ['liked']
      }));
    }
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { queries: ['粤语流行 女声'] } }),
      JSON.stringify({
        type: 'final',
        say: '只从红心里选。',
        picks: [
          { id: 'liked-only-1', reason: '红心候选', source: 'liked' },
          { id: 'liked-only-2', reason: '红心候选', source: 'liked' },
          { id: 'liked-only-3', reason: '红心候选', source: 'liked' },
          { id: 'liked-only-4', reason: '红心候选', source: 'liked' }
        ],
        rejected: [{ id: 'liked-only-5', reason: '重复' }]
      })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_from_ncm_search: async () => ({
          summary: 'search recall added 0 candidates',
          candidateCount: pool.count(),
          problems: ['no external candidates']
        })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(result.say).toContain('暂时没有可用候选');
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'liked_only_final_rejected',
      status: 'empty_pool',
      candidateCount: 5,
      pickCount: 0,
      extraFinalProblem: 'liked_only_final'
    }));
  });

  it('retries once with a hard final-only prompt when the extra final-pick call returns a tool call', async () => {
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
      JSON.stringify({ type: 'tool_call', tool: 'diversify_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我只返回最终选择。',
        picks: [
          { id: '103', reason: '重试后选择最有新鲜感的一首', source: 'liked' },
          { id: '101', reason: '保留用户偏好的稳定锚点', source: 'liked' }
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
      budget: budget({ maxLlmCalls: 3, maxSteps: 3 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我只返回最终选择。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['103', '101']);
    expect(llmClient.calls).toHaveLength(3);
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[1].opts?.responseFormat);
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[2].opts?.responseFormat);
    const retryPrompt = llmClient.calls[2].messages.map((message) => message.content).join('\n');
    expect(retryPrompt).toContain('上一轮输出不是 final');
    expect(retryPrompt).not.toContain('tool_call');
    expect(retryPrompt).not.toContain('"tool":');
    expect(result.trace.at(-1)).toMatchObject({
      thoughtSummary: 'extra final returned tool_call; retrying final-only output'
    });
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      step: 3,
      llmCalls: 3
    }));
  });

  it('falls back after exactly one hard final-only retry still returns a tool call', async () => {
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
      JSON.stringify({ type: 'tool_call', tool: 'diversify_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({
        type: 'final',
        say: 'should not spend a second retry',
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
      budget: budget({ maxLlmCalls: 4, maxSteps: 4 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked fallback')).toBe(true);
    expect(llmClient.calls).toHaveLength(3);
    expect(result.trace.at(-1)).toMatchObject({
      thoughtSummary: 'hard final-only retry did not return final output'
    });
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'extra_final_returned_tool_call',
      extraFinalProblem: 'returned_tool_call',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      step: 3,
      llmCalls: 3
    }));
  });

  it('records a ranked fallback when the extra final-pick call does not return a final answer', async () => {
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
      JSON.stringify({ type: 'tool_call', tool: 'diversify_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context(),
      candidatePool: pool,
      tools: {
        diversify_candidates: async () => ({ summary: 'diversified candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.every((pick) => pick.reason === 'ranked fallback')).toBe(true);
    expect(result.trace.at(-1)).toMatchObject({
      thoughtSummary: 'extra final did not return final output'
    });
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'extra_final_returned_tool_call',
      extraFinalProblem: 'returned_tool_call',
      status: 'ok',
      candidateCount: 3,
      pickCount: 2,
      step: 2,
      llmCalls: 2
    }));
  });

  it('fills ranked fallback picks from scored duplicate-artist candidates when strict diversity is short', async () => {
    const pool = new CandidatePool();
    const liveCandidates = [
      ['live-1', '和每天讲再见', '李幸倪'],
      ['live-2', '一加一', 'AGA / 李幸倪'],
      ['live-3', '如果的事', '范玮琪 / 张韶涵'],
      ['live-4', '亲爱的，那不是爱情', '张韶涵'],
      ['live-5', '下一位', '李幸倪'],
      ['live-6', '有形的翅膀', '张韶涵']
    ] as const;

    for (const [id, name, artist] of liveCandidates) {
      pool.upsert(candidate({
        id,
        name,
        artist,
        sources: ['search']
      }));
    }
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'expand_queries', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        rank_candidates: async () => ({ summary: 'ranked candidates', candidateCount: pool.count() })
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2, maxToolCalls: 1 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(5);
    expect(result.picks.map((pick) => pick.id)).toEqual(['live-1', 'live-2', 'live-3', 'live-4', 'live-5']);
    expect(result.picks.every((pick) => pick.reason.startsWith('ranked '))).toBe(true);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      candidateCount: 6,
      pickCount: 5
    }));
  });

  it('does not reward query funnel entries from ranked fallback picks', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101', scores: { ...candidate().scores, intentMatch: 0.9 } }));
    pool.upsert(candidate({
      id: '102',
      name: 'Bright Song',
      artist: 'Another Singer',
      scores: { ...candidate().scores, intentMatch: 0.8 }
    }));
    const recordFinalPicks = vi.fn();
    const queryFunnel = [{
      query: '城市 synth pop',
      normalizedQuery: '城市 synth pop',
      source: 'search' as const,
      searchedCount: 1,
      resultCount: 8,
      addedCount: 2,
      selectedCount: 0,
      scoreMultiplier: 1,
      repeatPenalty: 0,
      selectionRate: null
    }];

    const result = await runMusicAgentLoop({
      llmClient: new LoopFakeLlmClient([]),
      context: context(),
      candidatePool: pool,
      tools: {
        getQueryFunnel: () => queryFunnel,
        recordFinalPicks
      },
      budget: budget({ maxLlmCalls: 0 })
    });

    expect(result.picks.every((pick) => pick.reason === 'ranked fallback')).toBe(true);
    expect(result.queryFunnel).toEqual(queryFunnel);
    expect(recordFinalPicks).not.toHaveBeenCalled();
  });

  it('does not spend an extra final-pick call when too little time remains', async () => {
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
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: 'should not be called',
        picks: [{ id: '103', reason: 'should not be used', source: 'liked' }],
        rejected: []
      })
    ]);

    try {
      const result = await runMusicAgentLoop({
        llmClient,
        context: context(),
        candidatePool: pool,
        tools: {
          rank_candidates: async () => {
            now = 8_500;
            return { summary: 'ranked candidates', candidateCount: pool.count() };
          }
        },
        budget: budget({ maxMs: 10_000, maxLlmCalls: 2, maxSteps: 2 }),
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
    } finally {
      nowSpy.mockRestore();
    }
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

  it('uses a final LLM call when a terminal ranking tool is skipped by the tool budget', async () => {
    const pool = new CandidatePool();
    for (let index = 0; index < 5; index += 1) {
      pool.upsert(candidate({
        id: String(101 + index),
        name: `Candidate ${index + 1}`,
        artist: `Artist ${index + 1}`,
        sources: ['trend'],
        scores: { ...candidate().scores, intentMatch: 0.9 - index * 0.05 }
      }));
    }
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { queries: ['下午 华语'] } }),
      JSON.stringify({ type: 'tool_call', tool: 'diversify_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我从预算内已经排好的候选里选这两首。',
        picks: [
          { id: '103', reason: '更贴合下午的松弛感', source: 'trend' },
          { id: '101', reason: '保留当前候选里的最高匹配度', source: 'trend' }
        ],
        rejected: []
      })
    ]);
    const tools: MusicAgentToolRegistry = {
      recall_from_ncm_search: async () => ({ summary: 'search kept same candidates', candidateCount: pool.count() }),
      diversify_candidates: async () => {
        throw new Error('should not call terminal tool after budget is exhausted');
      }
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools,
      budget: budget({ maxLlmCalls: 3, maxSteps: 3, maxToolCalls: 1 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我从预算内已经排好的候选里选这两首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['103', '101']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
    expect(result.trace.at(-1)).toMatchObject({
      thoughtSummary: 'terminal tool skipped by budget'
    });
    expect(llmClient.calls).toHaveLength(3);
    expect(llmClient.calls[2].messages.map((message) => message.content).join('\n')).not.toContain('tool_call');
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[2].opts?.responseFormat);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 5,
      pickCount: 2,
      step: 3,
      llmCalls: 3
    }));
  });

  it('retries hard final-only output after a skipped terminal tool returns a tool call', async () => {
    const pool = new CandidatePool();
    for (let index = 0; index < 5; index += 1) {
      pool.upsert(candidate({
        id: String(301 + index),
        name: `Skipped Candidate ${index + 1}`,
        artist: `Skipped Artist ${index + 1}`,
        sources: ['search'],
        scores: { ...candidate().scores, intentMatch: 0.9 - index * 0.04 }
      }));
    }
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { queries: ['summer pop'] } }),
      JSON.stringify({ type: 'tool_call', tool: 'diversify_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我在重试后完成最终选择。',
        picks: [
          { id: '301', reason: '预算内最贴合当前需求', source: 'search' },
          { id: '302', reason: '补足同一氛围但保持差异', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const tools: MusicAgentToolRegistry = {
      recall_from_ncm_search: async () => ({ summary: 'search kept same candidates', candidateCount: pool.count() }),
      diversify_candidates: async () => {
        throw new Error('should not call terminal tool after budget is exhausted');
      }
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools,
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 1 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我在重试后完成最终选择。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['301', '302']);
    expect(llmClient.calls).toHaveLength(4);
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[2].opts?.responseFormat);
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[3].opts?.responseFormat);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ thoughtSummary: 'terminal tool skipped by budget' }),
      expect.objectContaining({ thoughtSummary: 'extra final returned tool_call; retrying final-only output' })
    ]));
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 5,
      pickCount: 2,
      step: 4,
      llmCalls: 4
    }));
  });

  it('uses a final LLM call when recall is skipped by tool budget after two candidates exist', async () => {
    const pool = new CandidatePool();
    for (let index = 0; index < 2; index += 1) {
      pool.upsert(candidate({
        id: String(201 + index),
        name: `Search Candidate ${index + 1}`,
        artist: `Search Artist ${index + 1}`,
        sources: ['search'],
        scores: { ...candidate().scores, intentMatch: 0.85 - index * 0.04 }
      }));
    }
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { queries: ['afternoon jazz'] } }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { queries: ['more afternoon jazz'] } }),
      JSON.stringify({
        type: 'final',
        say: '我用已有的两首搜索候选完成最终选择。',
        picks: [
          { id: '202', reason: '比另一首更有午后爵士质感', source: 'search' },
          { id: '201', reason: '补足柔和背景氛围', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const tools: MusicAgentToolRegistry = {
      recall_from_ncm_search: async () => ({ summary: 'search kept same candidates', candidateCount: pool.count() })
    };

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools,
      budget: budget({ maxLlmCalls: 3, maxSteps: 3, maxToolCalls: 1 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我用已有的两首搜索候选完成最终选择。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['202', '201']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
    expect(result.trace.at(-1)).toMatchObject({
      tool: 'recall_from_ncm_search',
      thoughtSummary: 'tool budget exhausted with sufficient candidates'
    });
    expect(llmClient.calls).toHaveLength(3);
    expect(llmClient.calls[2].messages.map((message) => message.content).join('\n')).not.toContain('tool_call');
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[2].opts?.responseFormat);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 2,
      pickCount: 2,
      step: 3,
      llmCalls: 3
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
      JSON.stringify({
        type: 'final',
        say: '我从扩展搜索后的候选里选这两首。',
        picks: [
          { id: 'search-1', reason: '更贴合午后轻松的搜索结果', source: 'search' },
          { id: 'trend-1', reason: '补一点新鲜趋势感', source: 'trend' }
        ],
        rejected: []
      })
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
    expect(result.say).toBe('我从扩展搜索后的候选里选这两首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'trend-1']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
    expect(calls).toEqual([
      'recall_from_liked',
      'expand_queries',
      'recall_from_ncm_search',
      'recall_from_style_expansion',
      'recall_from_trending'
    ]);
    expect(llmClient.calls).toHaveLength(2);
    expect(pool.list().filter((item) => !item.sources.includes('liked'))).toHaveLength(8);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 18,
      step: 2,
      llmCalls: 2
    }));
  });

  it('lets web discovery run on an empty explore pool and then verifies hints through entity recall', async () => {
    const pool = new CandidatePool();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({
        type: 'tool_call',
        tool: 'web_music_discovery',
        input: {
          intent: '探索类似 Ben Howard 的民谣新歌',
          focus: 'similar_tracks',
          maxHints: 2
        }
      }),
      JSON.stringify({
        type: 'tool_call',
        tool: 'recall_from_entities',
        input: {
          hints: [{
            kind: 'track',
            name: 'Only Love',
            artist: 'Ben Howard',
            sourceUrl: 'https://example.com/ben-howard',
            snippet: 'The source names Only Love by Ben Howard.',
            confidence: 0.88,
            freshness: 'durable',
            observedAt: '2026-06-15T08:00:00.000Z'
          }]
        }
      }),
      JSON.stringify({
        type: 'final',
        say: '我用网页线索校验后的候选来选。',
        picks: [{ id: 'web-verified-1', reason: '网页 hint 经 NCM 校验后贴合当前探索意图', source: 'search' }],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({
        request: 'auto-fill',
        discoveryMode: 'explore',
        currentUserText: '探索类似 Ben Howard 的民谣新歌'
      }),
      candidatePool: pool,
      tools: {
        web_music_discovery: async () => {
          calls.push('web_music_discovery');
          return {
            summary: 'web discovery returned 1 hints from 1 raw hints.',
            candidateCount: pool.count(),
            data: {
              hints: [{
                kind: 'track',
                name: 'Only Love',
                artist: 'Ben Howard',
                sourceUrl: 'https://example.com/ben-howard',
                snippet: 'The source names Only Love by Ben Howard.',
                confidence: 0.88,
                freshness: 'durable',
                observedAt: '2026-06-15T08:00:00.000Z'
              }]
            }
          };
        },
        recall_from_entities: async () => {
          calls.push('recall_from_entities');
          pool.upsert(candidate({
            id: 'web-verified-1',
            name: 'Only Love',
            artist: 'Ben Howard',
            sources: ['search']
          }));
          return { summary: 'entity recall expanded 1 entities and added 1 candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          throw new Error('web discovery should not be rewritten to auto-fill mix');
        }
      },
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 3 }),
      targetPickCount: 1
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我用网页线索校验后的候选来选。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['web-verified-1']);
    expect(calls).toEqual(['web_music_discovery', 'recall_from_entities']);
    expect(result.trace[0]).toMatchObject({ tool: 'web_music_discovery' });
    expect(result.trace[0].rewriteReason).toBeUndefined();
    expect(JSON.stringify(llmClient.calls[1].messages)).toContain('Only Love');
  });

  it('prefers one aggregate auto-fill recall tool so rank still has budget', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我用补充搜索后的候选做了最终选择。',
        picks: [
          { id: 'search-11', reason: '搜索候选更符合当前指令', source: 'search' },
          { id: 'search-12', reason: '保持同一氛围但换一位艺人', source: 'search' }
        ],
        rejected: []
      })
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
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
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
    expect(result.say).toBe('我用补充搜索后的候选做了最终选择。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-11', 'search-12']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
    expect(calls).toEqual(['recall_from_liked', 'recall_auto_fill_mix']);
    expect(llmClient.calls).toHaveLength(2);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      toolCalls: 2,
      candidateCount: 18,
      step: 2,
      llmCalls: 2
    }));
  });

  it('does not converge after only eight aggregate auto-fill candidates for five-pick batches', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_auto_fill_mix', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'wider recall' } }),
      JSON.stringify({
        type: 'final',
        say: '我等扩展候选补足后再选五首。',
        picks: [
          { id: 'search-1', reason: '第一轮候选贴合', source: 'search' },
          { id: 'search-3', reason: '第一轮候选保持变化', source: 'search' },
          { id: 'search-5', reason: '第一轮候选补足节奏', source: 'search' },
          { id: 'search-9', reason: '扩展候选提高质量余量', source: 'search' },
          { id: 'search-12', reason: '扩展候选避免八选五过紧', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    function addSearchCandidates(count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        const number = start + index + 1;
        pool.upsert(candidate({
          id: `search-${number}`,
          name: `Search ${number}`,
          artist: `Search Artist ${number}`,
          sources: ['search']
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          addSearchCandidates(8);
          return { summary: 'auto-fill mix added 8 candidates', candidateCount: pool.count() };
        },
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          addSearchCandidates(7);
          return { summary: 'search recall added 7 wider candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 6, maxSteps: 6, maxToolCalls: 4 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我等扩展候选补足后再选五首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'search-3', 'search-5', 'search-9', 'search-12']);
    expect(calls).toEqual(['recall_auto_fill_mix', 'recall_from_ncm_search']);
    expect(llmClient.calls).toHaveLength(3);
    expect(fallbackLogger).not.toHaveBeenCalled();
  });

  it('converges after ranking a target-sized non-liked comfort auto-fill pool', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_auto_fill_mix', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          for (let index = 1; index <= 5; index += 1) {
            pool.upsert(candidate({
              id: `search-${index}`,
              name: `Search ${index}`,
              artist: index > 3 ? `Search Artist ${index - 3}` : `Search Artist ${index}`,
              sources: ['search']
            }));
          }
          return { summary: 'auto-fill mix added 5 candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          calls.push('rank_candidates');
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 3, maxSteps: 6, maxToolCalls: 4 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks).toHaveLength(5);
    expect(calls).toEqual(['recall_auto_fill_mix', 'rank_candidates']);
    expect(llmClient.calls).toHaveLength(3);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      candidateCount: 5,
      pickCount: 5
    }));
  });

  it('keeps looping after liked recall supplements only eight candidates for five-pick batches', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'wider recall' } }),
      JSON.stringify({
        type: 'final',
        say: '我等补充搜索扩大候选池后再选五首。',
        picks: [
          { id: 'search-1', reason: '第一轮候选贴合', source: 'search' },
          { id: 'search-3', reason: '第一轮候选保持变化', source: 'search' },
          { id: 'search-5', reason: '第一轮候选补足节奏', source: 'search' },
          { id: 'search-9', reason: '第二轮候选提高质量余量', source: 'search' },
          { id: 'search-12', reason: '第二轮候选避免八选五过紧', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    function addSearchCandidates(count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        const number = start + index + 1;
        pool.upsert(candidate({
          id: `search-${number}`,
          name: `Search ${number}`,
          artist: `Search Artist ${number}`,
          sources: ['search']
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          return { summary: 'liked recall added 0 candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          addSearchCandidates(8);
          return { summary: 'auto-fill mix added 8 candidates', candidateCount: pool.count() };
        },
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          addSearchCandidates(7);
          return { summary: 'search recall added 7 wider candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 6, maxSteps: 6, maxToolCalls: 4 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我等补充搜索扩大候选池后再选五首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'search-3', 'search-5', 'search-9', 'search-12']);
    expect(calls).toEqual(['recall_from_liked', 'recall_auto_fill_mix', 'recall_from_ncm_search']);
    expect(llmClient.calls).toHaveLength(3);
    expect(fallbackLogger).not.toHaveBeenCalled();
  });

  it('allows comfort auto-fill to converge after liked recall supplies ten candidates for five-pick batches', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '红心深扫已经给到足够候选，我从里面选五首。',
        picks: [1, 2, 3, 4, 5].map((index) => ({
          id: `liked-${index}`,
          reason: `红心候选 ${index} 适合当前补队列`,
          source: 'liked'
        })),
        rejected: []
      })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'comfort' }),
      candidatePool: pool,
      tools: {
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          for (let index = 1; index <= 10; index += 1) {
            pool.upsert(candidate({
              id: `liked-${index}`,
              name: `Liked ${index}`,
              artist: `Liked Artist ${index}`,
              sources: ['liked']
            }));
          }
          return { summary: 'liked recall added 10 candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          return { summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 5, maxSteps: 5, maxToolCalls: 4 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['liked-1', 'liked-2', 'liked-3', 'liked-4', 'liked-5']);
    expect(calls).toEqual(['recall_from_liked', 'recall_auto_fill_mix']);
    expect(llmClient.calls).toHaveLength(2);
    expectProviderSafeFinalPickResponseFormat(llmClient.calls[1]?.opts?.responseFormat);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 10,
      pickCount: 5
    }));
  });

  it('does not emit liked-only ranked fallback for explore auto-fill when tool budget blocks expansion', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'expand_queries', input: { context: 'summer pop' } })
    ]);
    const calls: string[] = [];

    for (let index = 1; index <= 10; index += 1) {
      pool.upsert(candidate({
        id: `liked-${index}`,
        name: `Liked ${index}`,
        artist: `Liked Artist ${index}`,
        sources: ['liked']
      }));
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        expand_queries: async () => {
          calls.push('expand_queries');
          return { summary: 'expanded queries', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 1, maxSteps: 6, maxToolCalls: 0 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'tool_budget_exhausted',
      status: 'empty_pool',
      candidateCount: 10,
      pickCount: 0,
      toolCalls: 0
    }));
  });

  it('rewrites first liked recall to external recall in explore auto-fill', async () => {
    const pool = new CandidatePool();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: { limit: 10 } }),
      JSON.stringify({
        type: 'final',
        say: '我先用外部候选完成选择。',
        picks: [
          { id: 'search-1', reason: '外部候选更适合探索', source: 'search' },
          { id: 'search-2', reason: '外部候选保持新鲜感', source: 'search' },
          { id: 'search-3', reason: '外部候选补足变化', source: 'search' },
          { id: 'search-4', reason: '外部候选延续氛围', source: 'search' },
          { id: 'search-5', reason: '外部候选收束主题', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          for (let index = 1; index <= 5; index += 1) {
            pool.upsert(candidate({
              id: `search-${index}`,
              name: `Search ${index}`,
              artist: `Search Artist ${index}`,
              sources: ['search']
            }));
          }
          return { summary: 'auto-fill mix added 5 search candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          throw new Error('liked recall should not run before external recall in explore mode');
        }
      },
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 3 }),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual([
      'search-1',
      'search-2',
      'search-3',
      'search-4',
      'search-5'
    ]);
    expect(calls).toEqual(['recall_auto_fill_mix']);
    expect(result.trace[0]).toMatchObject({
      thoughtSummary: 'liked recall rewritten to external recall first',
      tool: 'recall_auto_fill_mix',
      requestedTool: 'recall_from_liked',
      rewriteReason: 'explore_external_recall_before_liked'
    });
  });

  it('uses extra final after no-progress external recall leaves a small candidate pool', async () => {
    const pool = new CandidatePool();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'quiet cantonese' } }),
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_style_expansion', input: { styleHints: ['quiet'] } }),
      JSON.stringify({
        type: 'final',
        say: '我先从已有的小候选池里选。',
        picks: [
          { id: 'search-1', reason: '已有候选最贴合当前氛围', source: 'search' },
          { id: 'search-2', reason: '已有候选保持变化', source: 'search' }
        ],
        rejected: [{ reason: '候选池不足五首' }]
      })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          pool.upsert(candidate({
            id: 'search-1',
            name: 'Search 1',
            artist: 'Search Artist 1',
            sources: ['search']
          }));
          pool.upsert(candidate({
            id: 'search-2',
            name: 'Search 2',
            artist: 'Search Artist 2',
            sources: ['search']
          }));
          return { summary: 'search recall added 2 candidates', candidateCount: pool.count() };
        },
        recall_from_style_expansion: async () => {
          calls.push('recall_from_style_expansion');
          return {
            summary: 'style expansion added 0 candidates',
            candidateCount: pool.count(),
            problems: ['semantic discovery found no indexed entities']
          };
        }
      },
      budget: budget({ maxLlmCalls: 5, maxSteps: 5, maxToolCalls: 4 }),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我先从已有的小候选池里选。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'search-2']);
    expect(calls).toEqual(['recall_from_ncm_search', 'recall_from_style_expansion']);
    expect(llmClient.calls).toHaveLength(3);
    expect(result.finalPickDiagnostics).toMatchObject({
      targetPickCount: 5,
      rawPickCount: 2,
      acceptedPickCount: 2,
      rankedBackfillCount: 0
    });
  });

  it('runs post-expand recall before final for liked-only fallback pools', async () => {
    const pool = new CandidatePool();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'get_context_summary', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'expand_queries', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我用扩展后的搜索候选先锚定这一批。',
        picks: [
          { id: 'search-1', reason: '扩展查询后召回的新候选更贴近当前方向', source: 'search' },
          { id: 'search-2', reason: '避免只从红心兜底池里选择', source: 'search' },
          { id: 'search-3', reason: '提供足够外部候选锚点', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];
    let autoFillCalls = 0;

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => {
          autoFillCalls += 1;
          calls.push(`recall_auto_fill_mix:${autoFillCalls}`);
          if (autoFillCalls === 2) {
            for (let index = 1; index <= 3; index += 1) {
              pool.upsert(candidate({
                id: `search-${index}`,
                name: `Search ${index}`,
                artist: `Search Artist ${index}`,
                sources: ['search']
              }));
            }
          }
          return { summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          for (let index = 1; index <= 4; index += 1) {
            pool.upsert(candidate({
              id: `liked-${index}`,
              name: `Liked ${index}`,
              artist: `Liked Artist ${index}`,
              sources: ['liked']
            }));
          }
          return { summary: 'liked recall added 5 candidates', candidateCount: pool.count() };
        },
        expand_queries: async () => {
          calls.push('expand_queries');
          return { summary: 'expanded but added no candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 5, maxSteps: 5, maxToolCalls: 4 }),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我用扩展后的搜索候选先锚定这一批。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'search-2', 'search-3']);
    expect(calls).toEqual(['recall_auto_fill_mix:1', 'recall_from_liked', 'expand_queries', 'recall_auto_fill_mix:2']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked fallback')).toBe(true);
  });

  it('supplements no-progress expand queries while explore external candidates are still sparse', async () => {
    const pool = new CandidatePool();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'bright work pop' } }),
      JSON.stringify({ type: 'tool_call', tool: 'expand_queries', input: { styleHints: ['bright', 'focused'] } })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          for (let index = 1; index <= 6; index += 1) {
            pool.upsert(candidate({
              id: `search-${index}`,
              name: `Search ${index}`,
              artist: `Search Artist ${index}`,
              sources: ['search']
            }));
          }
          return { summary: 'search recall added 6 candidates', candidateCount: pool.count() };
        },
        expand_queries: async () => {
          calls.push('expand_queries');
          return { summary: 'expanded queries without adding candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          for (let index = 7; index <= 15; index += 1) {
            pool.upsert(candidate({
              id: `search-${index}`,
              name: `Search ${index}`,
              artist: `Search Artist ${index}`,
              sources: ['search']
            }));
          }
          return {
            summary: 'auto-fill mix expanded sparse external candidates',
            candidateCount: pool.count(),
            data: {
              stages: [
                { stage: 'web_discovery', summary: 'web discovery returned 3 hints from 3 raw hints.', problems: [] }
              ]
            }
          };
        }
      },
      budget: budget({ maxLlmCalls: 3, maxSteps: 2, maxToolCalls: 3 }),
      targetPickCount: 5
    });

    expect(result.status).toBe('ok');
    expect(calls).toEqual(['recall_from_ncm_search', 'expand_queries', 'recall_auto_fill_mix']);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'recall_auto_fill_mix',
        thoughtSummary: 'auto-fill recall mix tool executed',
        observationData: {
          stages: [
            expect.objectContaining({ stage: 'web_discovery' })
          ]
        }
      })
    ]));
  });

  it('uses liked only as tail fallback after explore recall finds enough external candidates to anchor a batch', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'quiet work songs' } }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我用搜索候选打底，再用红心补足最后一首。',
        picks: [
          { id: 'search-1', reason: '搜索候选贴合当前方向', source: 'search' },
          { id: 'search-2', reason: '搜索候选保持新鲜度', source: 'search' },
          { id: 'search-3', reason: '搜索候选补足变化', source: 'search' },
          { id: 'search-4', reason: '搜索候选延续安静氛围', source: 'search' },
          { id: 'liked-tail', reason: '红心候选只用于补尾', source: 'liked' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          for (let index = 1; index <= 4; index += 1) {
            pool.upsert(candidate({
              id: `search-${index}`,
              name: `Search ${index}`,
              artist: `Search Artist ${index}`,
              sources: ['search']
            }));
          }
          return { summary: 'search recall added 4 candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          calls.push('rank_candidates');
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          return { summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async () => {
          calls.push('recall_from_liked');
          pool.upsert(candidate({
            id: 'liked-tail',
            name: 'Liked Tail',
            artist: 'Known Artist',
            sources: ['liked']
          }));
          return { summary: 'liked recall added 1 candidate', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 6, maxSteps: 6, maxToolCalls: 5 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual([
      'search-1',
      'search-2',
      'search-3',
      'search-4',
      'liked-tail'
    ]);
    expect(calls).toEqual([
      'recall_from_ncm_search',
      'rank_candidates',
      'recall_auto_fill_mix',
      'recall_from_liked'
    ]);
    expect(fallbackLogger).not.toHaveBeenCalledWith(expect.objectContaining({
      reason: 'tool_budget_exhausted'
    }));
  });

  it('auto-fill supplements sparse ranked candidates before converging', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'summer' } }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我从补全后的候选里重新挑了两首。',
        picks: [
          { id: 'search-1', reason: '第一轮搜索已经足够贴合', source: 'search' },
          { id: 'style_expansion-7', reason: '风格扩展补足了变化', source: 'style_expansion' }
        ],
        rejected: []
      })
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
    expect(result.say).toBe('我从补全后的候选里重新挑了两首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'style_expansion-7']);
    expect(result.picks.every((pick) => pick.reason !== 'ranked convergence')).toBe(true);
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
    expect(llmClient.calls).toHaveLength(3);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 10,
      step: 3,
      llmCalls: 3
    }));
  });

  it('keeps supplementing ranked five-pick auto-fill batches until the larger recall pool target is met', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'recall_from_ncm_search', input: { query: 'evening mix' } }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({
        type: 'final',
        say: '我从更宽的候选池里选五首。',
        picks: [
          { id: 'search-1', reason: '第一轮候选贴合', source: 'search' },
          { id: 'search-4', reason: '第一轮候选保留变化', source: 'search' },
          { id: 'search-8', reason: '补充召回后质量更稳定', source: 'search' },
          { id: 'search-12', reason: '候选池更宽后有更好选择', source: 'search' },
          { id: 'search-15', reason: '避免七选五过窄', source: 'search' }
        ],
        rejected: []
      })
    ]);
    const calls: string[] = [];

    function addSearchCandidates(count: number): void {
      const start = pool.count();
      for (let index = 0; index < count; index += 1) {
        const number = start + index + 1;
        pool.upsert(candidate({
          id: `search-${number}`,
          name: `Search ${number}`,
          artist: `Search Artist ${number}`,
          sources: ['search']
        }));
      }
    }

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill', discoveryMode: 'explore' }),
      candidatePool: pool,
      tools: {
        recall_from_ncm_search: async () => {
          calls.push('recall_from_ncm_search');
          addSearchCandidates(7);
          return { summary: 'search recall added 7 candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          calls.push('rank_candidates');
          return { summary: 'ranked candidates', candidateCount: pool.count() };
        },
        recall_auto_fill_mix: async () => {
          calls.push('recall_auto_fill_mix');
          addSearchCandidates(8);
          return { summary: 'auto-fill mix added 8 candidates', candidateCount: pool.count() };
        }
      },
      budget: budget({ maxLlmCalls: 6, maxSteps: 6, maxToolCalls: 4 }),
      targetPickCount: 5,
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我从更宽的候选池里选五首。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['search-1', 'search-4', 'search-8', 'search-12', 'search-15']);
    expect(calls).toEqual(['recall_from_ncm_search', 'rank_candidates', 'recall_auto_fill_mix']);
    expect(pool.count()).toBe(15);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ranked_tool_completed',
      status: 'ok',
      candidateCount: 15,
      pickCount: 5
    }));
  });

  it('rewrites empty-pool non-recall tools into forced auto-fill and liked recall', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: { limit: 8 } }),
      JSON.stringify({
        type: 'final',
        say: '我用保底召回后的候选完成最终选择。',
        picks: [
          { id: 'liked-1', reason: '红心候选保证了可播性', source: 'liked' },
          { id: 'liked-2', reason: '补足自动 DJ 的两首目标', source: 'liked' }
        ],
        rejected: []
      })
    ]);
    const calls: Array<{ tool: string; input?: Record<string, unknown> }> = [];

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async (toolInput) => {
          calls.push({ tool: 'recall_auto_fill_mix', input: toolInput });
          return { summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() };
        },
        recall_from_liked: async (toolInput) => {
          calls.push({ tool: 'recall_from_liked', input: toolInput });
          pool.upsert(candidate({ id: 'liked-1', name: 'Liked One', sources: ['liked'] }));
          pool.upsert(candidate({ id: 'liked-2', name: 'Liked Two', artist: 'Another Singer', sources: ['liked'] }));
          return { summary: 'liked recall added 2 candidates', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          throw new Error('empty pool rank should be rewritten before execution');
        }
      },
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 4 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.say).toBe('我用保底召回后的候选完成最终选择。');
    expect(result.picks.map((pick) => pick.id)).toEqual(['liked-1', 'liked-2']);
    expect(calls).toEqual([
      { tool: 'recall_auto_fill_mix', input: {} },
      { tool: 'recall_from_liked', input: { limit: 10 } }
    ]);
    expect(result.trace[0]).toMatchObject({
      tool: 'recall_auto_fill_mix',
      requestedTool: 'rank_candidates',
      executedTool: 'recall_auto_fill_mix',
      rewriteReason: 'empty_pool_non_recall_tool'
    });
    expect(result.trace[1]).toMatchObject({
      tool: 'recall_from_liked',
      requestedTool: 'recall_from_liked',
      executedTool: 'recall_from_liked',
      rewriteReason: 'empty_pool_forced_liked_recall'
    });
    expect(fallbackLogger).not.toHaveBeenCalled();
  });

  it('does not rewrite reserved rank into forced recall after tool budget is exhausted', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: 'only-1', name: 'Only Candidate' }));
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: { limit: 8 } })
    ]);
    let forcedRecallCalls = 0;

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => {
          forcedRecallCalls += 1;
          throw new Error('forced recall should not execute after tool budget is exhausted');
        },
        rank_candidates: async () => {
          throw new Error('reserved rank should be rewritten before execution');
        }
      },
      budget: budget({ maxLlmCalls: 2, maxSteps: 2, maxToolCalls: 0 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['only-1']);
    expect(forcedRecallCalls).toBe(0);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'tool_budget_exhausted',
      status: 'ok',
      candidateCount: 1,
      pickCount: 1,
      toolCalls: 0
    }));
  });

  it('reports empty_pool_after_forced_recall when forced recall still leaves no candidates', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => ({ summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() }),
        recall_from_liked: async () => ({ summary: 'liked recall added 0 candidates', candidateCount: pool.count() }),
        rank_candidates: async () => {
          throw new Error('empty pool rank should not execute after forced recall');
        }
      },
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 4 }),
      fallbackLogger
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'empty_pool_after_forced_recall',
      status: 'empty_pool',
      candidateCount: 0,
      pickCount: 0,
      toolCalls: 2
    }));
  });

  it('reports insufficient_pool_after_forced_recall when forced recall leaves one candidate', async () => {
    const pool = new CandidatePool();
    const fallbackLogger = vi.fn();
    const llmClient = new LoopFakeLlmClient([
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} }),
      JSON.stringify({ type: 'tool_call', tool: 'rank_candidates', input: {} })
    ]);

    const result = await runMusicAgentLoop({
      llmClient,
      context: context({ request: 'auto-fill' }),
      candidatePool: pool,
      tools: {
        recall_auto_fill_mix: async () => ({ summary: 'auto-fill mix added 0 candidates', candidateCount: pool.count() }),
        recall_from_liked: async () => {
          pool.upsert(candidate({ id: 'liked-1', name: 'Liked One', sources: ['liked'] }));
          return { summary: 'liked recall added 1 candidate', candidateCount: pool.count() };
        },
        rank_candidates: async () => {
          throw new Error('sparse pool rank should not execute after forced recall');
        }
      },
      budget: budget({ maxLlmCalls: 4, maxSteps: 4, maxToolCalls: 4 }),
      fallbackLogger
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['liked-1']);
    expect(fallbackLogger).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'insufficient_pool_after_forced_recall',
      status: 'ok',
      candidateCount: 1,
      pickCount: 1,
      toolCalls: 2
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
