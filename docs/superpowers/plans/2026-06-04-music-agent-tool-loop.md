# Music Agent Tool-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded tool-loop MusicAgent that unifies automatic DJ pick-next and chat recommendation, with retrieval/rerank candidate generation, trend context, curated music knowledge, chat memory extraction, strict candidate whitelisting, and abort-safe route integration.

**Architecture:** Add `src/server/music-agent/` as the new service boundary. The route layer keeps existing HTTP/SSE contracts and queue mutations, while `MusicAgent` owns context building, tool-loop reasoning, candidate recall/ranking, trend/knowledge retrieval, and final pick validation. The implementation is incremental: first pure types and deterministic helpers, then tools/loop, then route migration.

**Tech Stack:** TypeScript, Node.js, Express, better-sqlite3, zod, OpenAI-compatible LLM client, NeteaseCloudMusicApi adapter, Vitest.

---

## File Structure

Create:

- `src/server/music-agent/schema.ts`: zod schemas and exported types for tools, candidates, budgets, trace, final output, context summaries, trend and knowledge data.
- `src/server/music-agent/candidates.ts`: `CandidatePool`, dedupe helpers, hard filters, final pick validation, top-N summaries.
- `src/server/music-agent/rank.ts`: deterministic scoring and diversity helpers.
- `src/server/music-agent/data/music-knowledge.zh-CN.ts`: curated low-drift music knowledge.
- `src/server/music-agent/knowledge.ts`: query-scoped knowledge slice selection.
- `src/server/music-agent/trends.ts`: NCM trend adapter, cache read/write, trend context building.
- `src/server/music-agent/memory.ts`: chat preference extraction using existing `messages` and `chat_preferences` stores.
- `src/server/music-agent/context.ts`: compact context builder for pick-next and chat recommend.
- `src/server/music-agent/tools.ts`: whitelisted tool registry backed by `CandidatePool`.
- `src/server/music-agent/prompts.ts`: tool-loop system and user prompts.
- `src/server/music-agent/loop.ts`: bounded tool-loop runner.
- `src/server/music-agent/index.ts`: `MusicAgent` facade and fallback helpers.
- `tests/unit/music-agent-schema.spec.ts`
- `tests/unit/music-agent-candidates.spec.ts`
- `tests/unit/music-agent-rank.spec.ts`
- `tests/unit/music-agent-knowledge.spec.ts`
- `tests/unit/music-agent-trends.spec.ts`
- `tests/unit/music-agent-memory.spec.ts`
- `tests/unit/music-agent-loop.spec.ts`
- `tests/unit/music-agent-integration.spec.ts`

Modify:

- `src/server/ncm/client.ts`: add narrow public methods for trend endpoints.
- `src/server/http/chat-sse-worker.ts`: route chat recommendation actions through `MusicAgent.recommendFromChat()`.
- `src/server/http/routes/djNext.ts`: route automatic pick-next through `MusicAgent.pickNext()` and pass abort signals.
- Existing tests under `tests/unit/dj-next.spec.ts` and `tests/unit/agent-*` only when imports move.

Execution notes:

- Keep old helper functions in `djNext.ts` until route integration passes.
- Do not change frontend API or SSE event names in the first implementation.
- Do not expose full prompts, cookies, API keys, or full raw chats in trace.
- Use `.js` extensions in imports between `src/server/*` modules.

---

### Task 1: Schema and Contracts

**Files:**
- Create: `src/server/music-agent/schema.ts`
- Test: `tests/unit/music-agent-schema.spec.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/unit/music-agent-schema.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  candidateSourceSchema,
  musicAgentLoopOutputSchema,
  musicAgentToolNameSchema,
  musicCandidateSchema,
  musicAgentFinalOutputSchema
} from '../../src/server/music-agent/schema';

describe('music-agent schema', () => {
  it('accepts all first-version tool names', () => {
    expect(musicAgentToolNameSchema.parse('get_context_summary')).toBe('get_context_summary');
    expect(musicAgentToolNameSchema.parse('get_music_knowledge')).toBe('get_music_knowledge');
    expect(musicAgentToolNameSchema.parse('get_trend_context')).toBe('get_trend_context');
    expect(musicAgentToolNameSchema.parse('expand_queries')).toBe('expand_queries');
    expect(musicAgentToolNameSchema.parse('recall_from_liked')).toBe('recall_from_liked');
    expect(musicAgentToolNameSchema.parse('recall_from_playlists')).toBe('recall_from_playlists');
    expect(musicAgentToolNameSchema.parse('recall_from_plan_segment')).toBe('recall_from_plan_segment');
    expect(musicAgentToolNameSchema.parse('recall_from_ncm_search')).toBe('recall_from_ncm_search');
    expect(musicAgentToolNameSchema.parse('recall_from_trending')).toBe('recall_from_trending');
    expect(musicAgentToolNameSchema.parse('recall_from_style_expansion')).toBe('recall_from_style_expansion');
    expect(musicAgentToolNameSchema.parse('rank_candidates')).toBe('rank_candidates');
    expect(musicAgentToolNameSchema.parse('diversify_candidates')).toBe('diversify_candidates');
    expect(musicAgentToolNameSchema.parse('finalize_pick')).toBe('finalize_pick');
  });

  it('rejects unknown tools', () => {
    expect(() => musicAgentToolNameSchema.parse('write_database')).toThrow();
  });

  it('accepts trend as a candidate source', () => {
    expect(candidateSourceSchema.parse('trend')).toBe('trend');
  });

  it('validates a candidate with sources, evidence, and scores', () => {
    const candidate = musicCandidateSchema.parse({
      id: '101',
      name: 'Soft Song',
      artist: 'Singer',
      sources: ['liked', 'trend'],
      evidence: ['用户红心歌曲', '近期热搜关联'],
      scores: {
        intentMatch: 0.8,
        tasteMatch: 0.7,
        timeFit: 0.6,
        planFit: 0.5,
        novelty: 0.4,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 0.7
      }
    });

    expect(candidate.id).toBe('101');
    expect(candidate.sources).toContain('trend');
  });

  it('validates tool_call and final loop outputs', () => {
    expect(musicAgentLoopOutputSchema.parse({
      type: 'tool_call',
      tool: 'rank_candidates',
      input: { limit: 20 }
    }).type).toBe('tool_call');

    const output = musicAgentLoopOutputSchema.parse({
      type: 'final',
      say: '这两首更适合现在的下午状态。',
      picks: [{ id: '101', reason: '女声且能量适中', source: 'trend' }],
      rejected: [{ id: '202', reason: '最近刚播过同艺人' }]
    });

    expect(output.type).toBe('final');
  });

  it('validates final MusicAgent output', () => {
    const finalOutput = musicAgentFinalOutputSchema.parse({
      mode: 'pick_next',
      say: '补两首轻一点的。',
      picks: [{ id: '101', name: 'Soft Song', artist: 'Singer', reason: '符合下午低能量', source: 'liked' }],
      rejected: [],
      trace: [{ step: 1, thoughtSummary: '需要女声候选', candidateCount: 1, elapsedMs: 20 }]
    });

    expect(finalOutput.mode).toBe('pick_next');
    expect(finalOutput.picks[0].source).toBe('liked');
  });
});
```

- [ ] **Step 2: Run schema test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-schema.spec.ts
```

Expected: FAIL because `src/server/music-agent/schema.ts` does not exist.

- [ ] **Step 3: Implement schema contracts**

Create `src/server/music-agent/schema.ts`:

```ts
import { z } from 'zod';
import type { LlmMessage } from '../llm/client.js';

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
  'recall_from_trending',
  'recall_from_style_expansion',
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

export const musicCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artist: z.string().min(1),
  sources: z.array(candidateSourceSchema).min(1),
  evidence: z.array(z.string()).default([]),
  scores: musicCandidateScoresSchema
});

export type MusicCandidate = z.infer<typeof musicCandidateSchema>;

export const queryPlanSchema = z.object({
  intentQueries: z.array(z.string()).default([]),
  tasteAnchorQueries: z.array(z.string()).default([]),
  planQueries: z.array(z.string()).default([]),
  trendQueries: z.array(z.string()).default([]),
  explorationQueries: z.array(z.string()).default([]),
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
  diversityRules: z.array(z.string()).default([]),
  negativeMappings: z.array(z.string()).default([])
});

export type MusicKnowledgeSlice = z.infer<typeof musicKnowledgeSliceSchema>;

export const musicAgentContextSummarySchema = z.object({
  request: z.enum(['auto-fill', 'chat-recommend']),
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
  bannedSummary: z.string().default('')
});

export type MusicAgentContextSummary = z.infer<typeof musicAgentContextSummarySchema>;

export const agentTraceStepSchema = z.object({
  step: z.number().int().positive(),
  thoughtSummary: z.string(),
  tool: musicAgentToolNameSchema.optional(),
  toolInputSummary: z.string().optional(),
  observationSummary: z.string().optional(),
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

export const rejectedPickSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1)
});

export type RejectedPick = z.infer<typeof rejectedPickSchema>;

export const musicAgentLoopOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_call'),
    tool: musicAgentToolNameSchema,
    input: z.unknown().default({})
  }),
  z.object({
    type: z.literal('final'),
    say: z.string().min(1),
    picks: z.array(finalPickSchema).max(2),
    rejected: z.array(rejectedPickSchema).default([])
  })
]);

export type MusicAgentLoopOutput = z.infer<typeof musicAgentLoopOutputSchema>;

export const musicAgentFinalOutputSchema = z.object({
  mode: z.enum(['pick_next', 'chat_recommend']),
  say: z.string(),
  picks: z.array(finalPickSchema).max(2),
  rejected: z.array(rejectedPickSchema).default([]),
  trace: z.array(agentTraceStepSchema).default([])
});

export type MusicAgentFinalOutput = z.infer<typeof musicAgentFinalOutputSchema>;

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
  complete(messages: LlmMessage[], opts?: { signal?: AbortSignal; temperature?: number; maxTokens?: number }): Promise<{ content: string; model: string }>;
};
```

- [ ] **Step 4: Run schema test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-schema.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit schema contracts**

```bash
git add src/server/music-agent/schema.ts tests/unit/music-agent-schema.spec.ts
git commit -m "feat(agent): add music agent schema contracts"
```

---

### Task 2: CandidatePool and Ranking

**Files:**
- Create: `src/server/music-agent/candidates.ts`
- Create: `src/server/music-agent/rank.ts`
- Test: `tests/unit/music-agent-candidates.spec.ts`
- Test: `tests/unit/music-agent-rank.spec.ts`

- [ ] **Step 1: Write failing CandidatePool tests**

Create `tests/unit/music-agent-candidates.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CandidatePool, buildCandidateDedupeKey, validateFinalPicks } from '../../src/server/music-agent/candidates';
import type { MusicCandidate } from '../../src/server/music-agent/schema';

function candidate(overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id: '101',
    name: 'Soft Song',
    artist: 'Singer / Band',
    sources: ['liked'],
    evidence: ['用户红心歌曲'],
    scores: {
      intentMatch: 0,
      tasteMatch: 0,
      timeFit: 0,
      planFit: 0,
      novelty: 0,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0
    },
    ...overrides
  };
}

describe('CandidatePool', () => {
  it('merges candidates by id and keeps all sources and evidence', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '1', sources: ['liked'], evidence: ['liked evidence'] }));
    pool.upsert(candidate({ id: '1', sources: ['trend'], evidence: ['trend evidence'] }));

    const merged = pool.get('1');
    expect(merged?.sources).toEqual(['liked', 'trend']);
    expect(merged?.evidence).toEqual(['liked evidence', 'trend evidence']);
  });

  it('deduplicates same title and primary artist across different ids', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '1', name: 'Three Little Birds (Live)', artist: 'Bob Marley / The Wailers' }));
    pool.upsert(candidate({ id: '2', name: 'Three Little Birds', artist: 'Bob Marley' }));

    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0].id).toBe('1');
  });

  it('builds a normalized dedupe key', () => {
    expect(buildCandidateDedupeKey({ name: 'Song (Live)', artist: 'Artist / Other' })).toBe('song::artist');
  });

  it('filters banned artists and tracks', () => {
    const pool = new CandidatePool({
      bannedArtists: new Set(['Singer']),
      bannedTrackKeys: new Set([buildCandidateDedupeKey({ name: 'Blocked', artist: 'Other' })])
    });
    pool.upsert(candidate({ id: '1', artist: 'Singer' }));
    pool.upsert(candidate({ id: '2', name: 'Blocked', artist: 'Other' }));
    pool.upsert(candidate({ id: '3', name: 'Allowed', artist: 'Other' }));

    expect(pool.list().map((item) => item.id)).toEqual(['3']);
  });

  it('validates final picks against the candidate whitelist', () => {
    const pool = new CandidatePool();
    pool.upsert(candidate({ id: '101' }));

    expect(validateFinalPicks([{ id: '101', reason: 'ok', source: 'liked' }], pool)).toEqual([
      { id: '101', reason: 'ok', source: 'liked' }
    ]);
    expect(() => validateFinalPicks([{ id: '999', reason: 'bad', source: 'liked' }], pool)).toThrow(/not in CandidatePool/);
  });
});
```

- [ ] **Step 2: Write failing rank tests**

Create `tests/unit/music-agent-rank.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diversifyCandidates, scoreCandidate } from '../../src/server/music-agent/rank';
import type { MusicCandidate } from '../../src/server/music-agent/schema';

function candidate(id: string, artist: string, source: MusicCandidate['sources'][number], scoreSeed = 0): MusicCandidate {
  return {
    id,
    name: `Song ${id}`,
    artist,
    sources: [source],
    evidence: [],
    scores: {
      intentMatch: scoreSeed,
      tasteMatch: scoreSeed,
      timeFit: scoreSeed,
      planFit: scoreSeed,
      novelty: scoreSeed,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: scoreSeed
    }
  };
}

describe('music-agent rank', () => {
  it('scores active directive matches above trend-only novelty', () => {
    const directiveMatch = candidate('1', 'Singer A', 'search', 0.6);
    directiveMatch.scores.intentMatch = 1;
    const trendOnly = candidate('2', 'Singer B', 'trend', 0.8);
    trendOnly.scores.intentMatch = 0.2;

    expect(scoreCandidate(directiveMatch)).toBeGreaterThan(scoreCandidate(trendOnly));
  });

  it('subtracts recent and skip penalties', () => {
    const clean = candidate('1', 'Singer A', 'liked', 0.8);
    const skipped = candidate('2', 'Singer B', 'liked', 0.8);
    skipped.scores.skipPenalty = 0.5;
    skipped.scores.recentPenalty = 0.2;

    expect(scoreCandidate(clean)).toBeGreaterThan(scoreCandidate(skipped));
  });

  it('diversifies top candidates by artist', () => {
    const result = diversifyCandidates([
      candidate('1', 'Same Artist', 'search', 1),
      candidate('2', 'Same Artist', 'trend', 0.9),
      candidate('3', 'Other Artist', 'playlist', 0.8)
    ], 3);

    expect(result.map((item) => item.id)).toEqual(['1', '3']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-candidates.spec.ts tests/unit/music-agent-rank.spec.ts
```

Expected: FAIL because `candidates.ts` and `rank.ts` do not exist.

- [ ] **Step 4: Implement CandidatePool**

Create `src/server/music-agent/candidates.ts`:

```ts
import type { FinalPick, MusicCandidate } from './schema.js';

export type CandidatePoolOptions = {
  bannedArtists?: Set<string>;
  bannedTrackKeys?: Set<string>;
  maxCandidates?: number;
};

export class CandidatePool {
  private readonly byId = new Map<string, MusicCandidate>();
  private readonly dedupeIdByKey = new Map<string, string>();
  private readonly bannedArtists: Set<string>;
  private readonly bannedTrackKeys: Set<string>;
  private readonly maxCandidates: number;

  constructor(options: CandidatePoolOptions = {}) {
    this.bannedArtists = new Set([...options.bannedArtists ?? []].map((artist) => normalizeDedupeText(artist)));
    this.bannedTrackKeys = options.bannedTrackKeys ?? new Set();
    this.maxCandidates = options.maxCandidates ?? 120;
  }

  upsert(candidate: MusicCandidate): void {
    if (this.byId.size >= this.maxCandidates && !this.byId.has(candidate.id)) return;
    if (this.isHardFiltered(candidate)) return;

    const dedupeKey = buildCandidateDedupeKey(candidate);
    const existingIdForKey = dedupeKey ? this.dedupeIdByKey.get(dedupeKey) : undefined;
    const targetId = existingIdForKey ?? candidate.id;
    const existing = this.byId.get(targetId);

    if (!existing) {
      this.byId.set(candidate.id, cloneCandidate(candidate));
      if (dedupeKey) this.dedupeIdByKey.set(dedupeKey, candidate.id);
      return;
    }

    existing.sources = mergeUnique(existing.sources, candidate.sources);
    existing.evidence = mergeUnique(existing.evidence, candidate.evidence);
    existing.scores = {
      intentMatch: Math.max(existing.scores.intentMatch, candidate.scores.intentMatch),
      tasteMatch: Math.max(existing.scores.tasteMatch, candidate.scores.tasteMatch),
      timeFit: Math.max(existing.scores.timeFit, candidate.scores.timeFit),
      planFit: Math.max(existing.scores.planFit, candidate.scores.planFit),
      novelty: Math.max(existing.scores.novelty, candidate.scores.novelty),
      recentPenalty: Math.max(existing.scores.recentPenalty, candidate.scores.recentPenalty),
      skipPenalty: Math.max(existing.scores.skipPenalty, candidate.scores.skipPenalty),
      sourceConfidence: Math.max(existing.scores.sourceConfidence, candidate.scores.sourceConfidence)
    };
  }

  get(id: string): MusicCandidate | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): MusicCandidate[] {
    return [...this.byId.values()].map(cloneCandidate);
  }

  count(): number {
    return this.byId.size;
  }

  topBy(score: (candidate: MusicCandidate) => number, limit: number): MusicCandidate[] {
    return this.list().sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  private isHardFiltered(candidate: MusicCandidate): boolean {
    const artist = normalizeDedupeText(primaryArtist(candidate.artist));
    if (artist && this.bannedArtists.has(artist)) return true;
    const dedupeKey = buildCandidateDedupeKey(candidate);
    return dedupeKey.length > 0 && this.bannedTrackKeys.has(dedupeKey);
  }
}

export function validateFinalPicks(picks: FinalPick[], pool: CandidatePool): FinalPick[] {
  for (const pick of picks) {
    if (!pool.has(pick.id)) {
      throw new Error(`final pick id=${pick.id} is not in CandidatePool`);
    }
    const candidate = pool.get(pick.id);
    if (candidate && !candidate.sources.includes(pick.source)) {
      throw new Error(`final pick id=${pick.id} source=${pick.source} is not present on candidate`);
    }
  }
  return picks;
}

export function buildCandidateDedupeKey(track: { name?: string | null; artist?: string | null }): string {
  const name = normalizeDedupeText(track.name ?? '');
  const artist = normalizeDedupeText(primaryArtist(track.artist ?? ''));
  if (!name || !artist) return '';
  return `${name}::${artist}`;
}

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|、|&|feat\.?|ft\.?)\s*/i)[0]?.trim() ?? '';
}

function normalizeDedupeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|\[[^\]]*]|\{[^}]*}/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function cloneCandidate(candidate: MusicCandidate): MusicCandidate {
  return {
    ...candidate,
    sources: [...candidate.sources],
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores }
  };
}
```

- [ ] **Step 5: Implement ranking**

Create `src/server/music-agent/rank.ts`:

```ts
import type { MusicCandidate } from './schema.js';

export function scoreCandidate(candidate: MusicCandidate): number {
  const score =
    candidate.scores.intentMatch * 0.30 +
    candidate.scores.tasteMatch * 0.20 +
    candidate.scores.timeFit * 0.15 +
    candidate.scores.planFit * 0.10 +
    candidate.scores.sourceConfidence * 0.10 +
    candidate.scores.novelty * 0.15 -
    candidate.scores.recentPenalty -
    candidate.scores.skipPenalty;

  return Math.max(0, score);
}

export function diversifyCandidates(candidates: MusicCandidate[], limit: number): MusicCandidate[] {
  const sorted = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const selected: MusicCandidate[] = [];
  const artists = new Set<string>();

  for (const candidate of sorted) {
    const artistKey = normalizeArtist(candidate.artist);
    if (artistKey && artists.has(artistKey)) continue;
    selected.push(candidate);
    if (artistKey) artists.add(artistKey);
    if (selected.length >= limit) break;
  }

  return selected;
}

function normalizeArtist(artist: string): string {
  return artist
    .split(/\s*(?:\/|,|，|、|&|feat\.?|ft\.?)\s*/i)[0]
    ?.trim()
    .toLowerCase() ?? '';
}
```

- [ ] **Step 6: Run CandidatePool and rank tests**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-candidates.spec.ts tests/unit/music-agent-rank.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit candidate and rank helpers**

```bash
git add src/server/music-agent/candidates.ts src/server/music-agent/rank.ts tests/unit/music-agent-candidates.spec.ts tests/unit/music-agent-rank.spec.ts
git commit -m "feat(agent): add candidate pool and ranking"
```

---

### Task 3: Curated Music Knowledge

**Files:**
- Create: `src/server/music-agent/data/music-knowledge.zh-CN.ts`
- Create: `src/server/music-agent/knowledge.ts`
- Test: `tests/unit/music-agent-knowledge.spec.ts`

- [ ] **Step 1: Write failing knowledge tests**

Create `tests/unit/music-agent-knowledge.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getMusicKnowledgeSlice } from '../../src/server/music-agent/knowledge';

describe('music knowledge', () => {
  it('returns scene rules for afternoon and female vocal requests', () => {
    const slice = getMusicKnowledgeSlice({
      text: '下午多来点女歌手，别太吵',
      daypart: '下午'
    });

    expect(slice.sceneRules.join('\n')).toContain('下午');
    expect(slice.queryTemplates.join('\n')).toContain('女声');
    expect(slice.negativeMappings.join('\n')).toContain('高能量');
  });

  it('returns style adjacency for city pop', () => {
    const slice = getMusicKnowledgeSlice({ text: 'City Pop 女声', daypart: '晚上' });

    expect(slice.styleAdjacency.join('\n').toLowerCase()).toContain('synth pop');
    expect(slice.styleAdjacency.join('\n')).toContain('粤语');
  });

  it('keeps the returned slice compact', () => {
    const slice = getMusicKnowledgeSlice({ text: '随便推荐几首', daypart: '上午' });
    const serialized = JSON.stringify(slice);

    expect(serialized.length).toBeLessThan(3000);
  });
});
```

- [ ] **Step 2: Run knowledge test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-knowledge.spec.ts
```

Expected: FAIL because `knowledge.ts` does not exist.

- [ ] **Step 3: Add curated knowledge data**

Create `src/server/music-agent/data/music-knowledge.zh-CN.ts`:

```ts
export type MusicKnowledgeBase = {
  styleGraph: Record<string, string[]>;
  sceneProfiles: Record<string, {
    energyRange: [number, number];
    vocalDensity: 'low' | 'medium' | 'high';
    preferredStyles: string[];
    avoidTraits: string[];
  }>;
  queryTemplates: Array<{ intent: string; templates: string[] }>;
  negativeMappings: Record<string, string[]>;
  diversityRules: string[];
};

export const musicKnowledgeZhCN: MusicKnowledgeBase = {
  styleGraph: {
    'city pop': ['synth pop', 'AOR', '80s J-pop', '粤语怀旧流行', '轻快放克'],
    'indie pop': ['dream pop', 'bedroom pop', 'indie folk', 'soft rock'],
    'dream pop': ['shoegaze', 'ambient pop', 'female vocal dream pop', 'indie pop'],
    '粤语': ['港乐', '粤语流行', 'city pop', '华语女声'],
    '女声': ['female vocal', '女歌手', '女性主唱', 'soft female vocal']
  },
  sceneProfiles: {
    上午: {
      energyRange: [35, 65],
      vocalDensity: 'medium',
      preferredStyles: ['indie pop', 'city pop', '轻快流行'],
      avoidTraits: ['过重低频', '极高能量']
    },
    下午: {
      energyRange: [25, 55],
      vocalDensity: 'medium',
      preferredStyles: ['soft pop', 'dream pop', 'city pop', 'acoustic pop'],
      avoidTraits: ['高能量', '重型摇滚', '强噪声']
    },
    深夜: {
      energyRange: [10, 35],
      vocalDensity: 'low',
      preferredStyles: ['ambient', 'piano', 'downtempo', 'dream pop'],
      avoidTraits: ['高能量', '密集鼓点', '喊唱']
    },
    跑步: {
      energyRange: [65, 90],
      vocalDensity: 'high',
      preferredStyles: ['hip hop', 'dance pop', 'electropop'],
      avoidTraits: ['过慢', '过长前奏']
    }
  },
  queryTemplates: [
    { intent: 'female-vocal', templates: ['{style} 女声', '{style} 女歌手', 'female vocal {style}', '女性主唱 {style}'] },
    { intent: 'quiet', templates: ['安静 {style}', 'soft {style}', 'chill {style}', '低能量 {style}'] },
    { intent: 'afternoon', templates: ['下午 放松 {style}', 'afternoon chill {style}', '轻松 {style}'] },
    { intent: 'focus', templates: ['专注 {style}', 'focus {style}', '少人声 {style}'] }
  ],
  negativeMappings: {
    别太吵: ['高能量', '强噪声', '重型摇滚', '密集鼓点'],
    不要太吵: ['高能量', '强噪声', '重型摇滚', '密集鼓点'],
    少人声: ['高人声密度', '喊唱', '副歌过密'],
    不要人声: ['高人声密度', 'vocal-heavy']
  },
  diversityRules: [
    '同一艺人不要连续占满候选',
    '同一 OST、合集、厂牌类艺人名应降权',
    '探索模式需要至少一个非红心来源候选',
    '舒适区模式需要保留可解释的品味锚点'
  ]
};
```

- [ ] **Step 4: Implement knowledge slice selection**

Create `src/server/music-agent/knowledge.ts`:

```ts
import { musicKnowledgeZhCN } from './data/music-knowledge.zh-CN.js';
import type { MusicKnowledgeSlice } from './schema.js';

export type KnowledgeRequest = {
  text: string;
  daypart: string;
};

export function getMusicKnowledgeSlice(request: KnowledgeRequest): MusicKnowledgeSlice {
  const haystack = `${request.text} ${request.daypart}`.toLowerCase();
  const styleAdjacency = selectStyleAdjacency(haystack);
  const sceneRules = selectSceneRules(request.daypart);
  const queryTemplates = selectQueryTemplates(haystack);
  const negativeMappings = selectNegativeMappings(request.text);

  return {
    styleAdjacency,
    sceneRules,
    queryTemplates,
    diversityRules: musicKnowledgeZhCN.diversityRules.slice(0, 4),
    negativeMappings
  };
}

function selectStyleAdjacency(text: string): string[] {
  const result: string[] = [];
  for (const [style, adjacent] of Object.entries(musicKnowledgeZhCN.styleGraph)) {
    if (text.includes(style.toLowerCase())) {
      result.push(`${style}: ${adjacent.join(' / ')}`);
    }
  }
  if (/女声|女歌手|female/.test(text)) {
    result.push(`女声: ${musicKnowledgeZhCN.styleGraph['女声'].join(' / ')}`);
  }
  return result.slice(0, 6);
}

function selectSceneRules(daypart: string): string[] {
  const profile = musicKnowledgeZhCN.sceneProfiles[daypart];
  if (!profile) return [];
  return [
    `${daypart}: energy ${profile.energyRange[0]}-${profile.energyRange[1]}`,
    `${daypart}: vocalDensity ${profile.vocalDensity}`,
    `${daypart}: preferred ${profile.preferredStyles.join(' / ')}`,
    `${daypart}: avoid ${profile.avoidTraits.join(' / ')}`
  ];
}

function selectQueryTemplates(text: string): string[] {
  const templates: string[] = [];
  for (const item of musicKnowledgeZhCN.queryTemplates) {
    if (item.intent === 'female-vocal' && /女声|女歌手|female/.test(text)) {
      templates.push(...item.templates);
    }
    if (item.intent === 'quiet' && /安静|别太吵|不要太吵|soft|chill/.test(text)) {
      templates.push(...item.templates);
    }
    if (item.intent === 'afternoon' && /下午|afternoon/.test(text)) {
      templates.push(...item.templates);
    }
    if (item.intent === 'focus' && /专注|工作|少人声|focus/.test(text)) {
      templates.push(...item.templates);
    }
  }
  return [...new Set(templates)].slice(0, 10);
}

function selectNegativeMappings(text: string): string[] {
  const result: string[] = [];
  for (const [phrase, traits] of Object.entries(musicKnowledgeZhCN.negativeMappings)) {
    if (text.includes(phrase)) {
      result.push(`${phrase}: ${traits.join(' / ')}`);
    }
  }
  return result.slice(0, 6);
}
```

- [ ] **Step 5: Run knowledge tests**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-knowledge.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit music knowledge**

```bash
git add src/server/music-agent/data/music-knowledge.zh-CN.ts src/server/music-agent/knowledge.ts tests/unit/music-agent-knowledge.spec.ts
git commit -m "feat(agent): add curated music knowledge"
```

---

### Task 4: Trend Context and NCM Trend Adapter

**Files:**
- Modify: `src/server/ncm/client.ts`
- Create: `src/server/music-agent/trends.ts`
- Test: `tests/unit/music-agent-trends.spec.ts`

- [ ] **Step 1: Write failing trend tests**

Create `tests/unit/music-agent-trends.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-trends-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('trend context', () => {
  it('builds trend context from NCM hot search and top song data', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends');
    const ncm = {
      getSearchHotDetail: vi.fn(async () => [{ searchWord: '新晋女声', content: '热门搜索' }]),
      getTopSongHints: vi.fn(async () => [{ title: 'New Song', artist: 'New Artist', source: 'ncm_top_song' as const, reason: '新歌速递' }]),
      getArtistToplist: vi.fn(async () => ['Hot Artist'])
    };

    const context = await buildTrendContext({ ncmClient: ncm, locale: 'zh-CN', maxFetchMs: 2000 });

    expect(context.sources).toContain('ncm_search_hot');
    expect(context.hotStyles).toContain('新晋女声');
    expect(context.hotArtists).toContain('Hot Artist');
    expect(context.chartTrackHints[0].title).toBe('New Song');
  });

  it('uses cache when it is fresh', async () => {
    const { readTrendCache, writeTrendCache, buildTrendContext } = await import('../../src/server/music-agent/trends');
    const cached = {
      fetchedAt: new Date().toISOString(),
      locale: 'zh-CN' as const,
      sources: ['manual_cache' as const],
      hotArtists: ['Cached Artist'],
      hotStyles: ['Cached Style'],
      chartTrackHints: [],
      confidence: 0.5
    };
    writeTrendCache(cached);

    const context = await buildTrendContext({
      ncmClient: {
        getSearchHotDetail: vi.fn(async () => []),
        getTopSongHints: vi.fn(async () => []),
        getArtistToplist: vi.fn(async () => [])
      },
      locale: 'zh-CN',
      maxFetchMs: 1
    });

    expect(readTrendCache('zh-CN')?.hotArtists).toEqual(['Cached Artist']);
    expect(context.hotStyles).toEqual(['Cached Style']);
  });

  it('returns empty context when NCM trend methods fail', async () => {
    const { buildTrendContext } = await import('../../src/server/music-agent/trends');
    const context = await buildTrendContext({
      ncmClient: {
        getSearchHotDetail: vi.fn(async () => { throw new Error('ncm down'); }),
        getTopSongHints: vi.fn(async () => { throw new Error('ncm down'); }),
        getArtistToplist: vi.fn(async () => { throw new Error('ncm down'); })
      },
      locale: 'zh-CN',
      maxFetchMs: 100
    });

    expect(context.sources).toEqual([]);
    expect(context.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run trend test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-trends.spec.ts
```

Expected: FAIL because `trends.ts` does not exist.

- [ ] **Step 3: Add NCM trend methods**

Modify `src/server/ncm/client.ts` by adding these public methods above `private async getJson(...)`:

```ts
  async getSearchHotDetail(): Promise<Array<{ searchWord: string; content?: string }>> {
    const json = await this.getJson('/search/hot/detail', {});
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((item: unknown) => {
        const row = item as Record<string, unknown>;
        return {
          searchWord: typeof row.searchWord === 'string' ? row.searchWord : '',
          content: typeof row.content === 'string' ? row.content : undefined
        };
      })
      .filter((item: { searchWord: string }) => item.searchWord.length > 0)
      .slice(0, 20);
  }

  async getTopSongHints(type = '0'): Promise<Array<{ title: string; artist: string; source: 'ncm_top_song'; reason: string }>> {
    const json = await this.getJson('/top/song', { type });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((item: unknown) => {
        const row = item as Record<string, unknown>;
        const artists = Array.isArray(row.ar)
          ? row.ar.map((artist) => (artist as Record<string, unknown>).name).filter((name): name is string => typeof name === 'string')
          : [];
        return {
          title: typeof row.name === 'string' ? row.name : '',
          artist: artists.join(' / '),
          source: 'ncm_top_song' as const,
          reason: '新歌速递'
        };
      })
      .filter((item: { title: string; artist: string }) => item.title.length > 0 && item.artist.length > 0)
      .slice(0, 30);
  }

  async getArtistToplist(): Promise<string[]> {
    const json = await this.getJson('/toplist/artist', {});
    const artists = Array.isArray(json?.list?.artists) ? json.list.artists : [];
    return artists
      .map((item: unknown) => (item as Record<string, unknown>).name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
      .slice(0, 30);
  }
```

- [ ] **Step 4: Implement trend context and cache**

Create `src/server/music-agent/trends.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { resolveAppDataDir } from '../app-paths.js';
import { trendContextSchema, type TrendContext, type TrendTrackHint } from './schema.js';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export type TrendCapableNcmClient = {
  getSearchHotDetail(): Promise<Array<{ searchWord: string; content?: string }>>;
  getTopSongHints(type?: string): Promise<TrendTrackHint[]>;
  getArtistToplist(): Promise<string[]>;
};

export type BuildTrendContextOptions = {
  ncmClient: TrendCapableNcmClient;
  locale: 'zh-CN' | 'global';
  maxFetchMs: number;
  ttlMs?: number;
};

export async function buildTrendContext(options: BuildTrendContextOptions): Promise<TrendContext> {
  const cached = readTrendCache(options.locale);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < (options.ttlMs ?? DEFAULT_TTL_MS)) {
    return cached;
  }

  const fresh = await withTimeout(fetchTrendContext(options.ncmClient, options.locale), options.maxFetchMs, emptyTrendContext(options.locale));
  if (fresh.sources.length > 0) {
    writeTrendCache(fresh);
  }
  return fresh;
}

export function readTrendCache(locale: 'zh-CN' | 'global'): TrendContext | null {
  const filePath = trendCachePath(locale);
  if (!fs.existsSync(filePath)) return null;
  try {
    return trendContextSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function writeTrendCache(context: TrendContext): void {
  const filePath = trendCachePath(context.locale);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(context, null, 2), 'utf-8');
}

async function fetchTrendContext(ncmClient: TrendCapableNcmClient, locale: 'zh-CN' | 'global'): Promise<TrendContext> {
  const [hotSearch, topSongs, artistToplist] = await Promise.all([
    ncmClient.getSearchHotDetail().catch(() => []),
    ncmClient.getTopSongHints('0').catch(() => []),
    ncmClient.getArtistToplist().catch(() => [])
  ]);

  const hotStyles = hotSearch.map((item) => item.searchWord).slice(0, 12);
  const chartTrackHints = topSongs.slice(0, 20);
  const hotArtists = artistToplist.slice(0, 20);
  const sources = [
    hotStyles.length > 0 ? 'ncm_search_hot' as const : null,
    chartTrackHints.length > 0 ? 'ncm_top_song' as const : null,
    hotArtists.length > 0 ? 'ncm_artist_toplist' as const : null
  ].filter((source): source is NonNullable<typeof source> => source !== null);

  return {
    fetchedAt: new Date().toISOString(),
    locale,
    sources,
    hotArtists,
    hotStyles,
    chartTrackHints,
    confidence: sources.length === 0 ? 0 : Math.min(1, sources.length / 3)
  };
}

function emptyTrendContext(locale: 'zh-CN' | 'global'): TrendContext {
  return {
    fetchedAt: new Date().toISOString(),
    locale,
    sources: [],
    hotArtists: [],
    hotStyles: [],
    chartTrackHints: [],
    confidence: 0
  };
}

function trendCachePath(locale: 'zh-CN' | 'global'): string {
  return path.join(resolveAppDataDir(), 'cache', 'trends', `${locale}.json`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}
```

- [ ] **Step 5: Run trend tests**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-trends.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit trend context**

```bash
git add src/server/ncm/client.ts src/server/music-agent/trends.ts tests/unit/music-agent-trends.spec.ts
git commit -m "feat(agent): add trend context sources"
```

---

### Task 5: Chat Memory Extraction and Context Builder

**Files:**
- Create: `src/server/music-agent/memory.ts`
- Create: `src/server/music-agent/context.ts`
- Test: `tests/unit/music-agent-memory.spec.ts`

- [ ] **Step 1: Write failing memory tests**

Create `tests/unit/music-agent-memory.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLlmClient } from '../support/fake-llm';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-agent-memory-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('music-agent memory', () => {
  it('skips extraction when there are fewer than four unextracted messages', async () => {
    const { saveMessage } = await import('../../src/server/store/messages');
    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory');
    saveMessage('user-1', 'user', '来点女声');
    saveMessage('user-1', 'assistant', '好的');

    const fake = new FakeLlmClient();
    const result = await extractChatPreferencesIfDue('user-1', fake);

    expect(result.extracted).toBe(false);
    expect(fake.completeCalls).toHaveLength(0);
  });

  it('extracts music preferences and marks messages extracted', async () => {
    const { saveMessage, getUnextractedMessages } = await import('../../src/server/store/messages');
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences');
    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory');
    saveMessage('user-1', 'user', '下午多来点女歌手');
    saveMessage('user-1', 'assistant', '我会记住这个方向');
    saveMessage('user-1', 'user', '别太吵');
    saveMessage('user-1', 'assistant', '安排轻一点的');

    const fake = new FakeLlmClient().queueResponse(JSON.stringify({
      musicRelated: true,
      summary: '近期偏好：下午更喜欢女声、女歌手，整体不要太吵，适合低到中能量流行。'
    }));
    const result = await extractChatPreferencesIfDue('user-1', fake);

    expect(result.extracted).toBe(true);
    expect(getPreferenceContext('user-1', 1)).toContain('女声');
    expect(getUnextractedMessages('user-1')).toHaveLength(0);
  });

  it('marks non-music chat extracted without saving a preference summary', async () => {
    const { saveMessage, getUnextractedMessages } = await import('../../src/server/store/messages');
    const { getPreferenceContext } = await import('../../src/server/store/chat-preferences');
    const { extractChatPreferencesIfDue } = await import('../../src/server/music-agent/memory');
    saveMessage('user-1', 'user', '今天工作很多');
    saveMessage('user-1', 'assistant', '辛苦了');
    saveMessage('user-1', 'user', '天气还不错');
    saveMessage('user-1', 'assistant', '是的');

    const fake = new FakeLlmClient().queueResponse(JSON.stringify({
      musicRelated: false,
      summary: ''
    }));
    const result = await extractChatPreferencesIfDue('user-1', fake);

    expect(result.extracted).toBe(true);
    expect(getPreferenceContext('user-1', 1)).toBe('');
    expect(getUnextractedMessages('user-1')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run memory test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-memory.spec.ts
```

Expected: FAIL because `memory.ts` does not exist.

- [ ] **Step 3: Implement memory extraction**

Create `src/server/music-agent/memory.ts`:

```ts
import { z } from 'zod';
import type { MusicAgentLlmClient } from './schema.js';
import { getUnextractedMessages, markMessagesExtracted } from '../store/messages.js';
import { saveChatPreference } from '../store/chat-preferences.js';

const extractionSchema = z.object({
  musicRelated: z.boolean(),
  summary: z.string().default('')
});

export type MemoryExtractionResult = {
  extracted: boolean;
  messageIds: number[];
  summary: string;
};

export async function extractChatPreferencesIfDue(
  userId: string,
  llmClient: MusicAgentLlmClient,
  signal?: AbortSignal
): Promise<MemoryExtractionResult> {
  const messages = getUnextractedMessages(userId);
  if (messages.length < 4) {
    return { extracted: false, messageIds: [], summary: '' };
  }

  const messageIds = messages.map((message) => message.id);
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  const response = await llmClient.complete([
    {
      role: 'system',
      content: [
        '你是音乐偏好抽取器。只抽取和选歌相关的偏好。',
        '不要保存身份、位置、工作内容或非音乐闲聊。',
        '输出严格 JSON：{"musicRelated": boolean, "summary": string}。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `<messages>\n${transcript}\n</messages>`
    }
  ], { signal, temperature: 0.2, maxTokens: 500 });

  const parsed = parseExtraction(response.content);
  if (parsed.musicRelated && parsed.summary.trim()) {
    saveChatPreference(userId, parsed.summary.trim(), messageIds);
  }
  markMessagesExtracted(userId, messageIds);

  return {
    extracted: true,
    messageIds,
    summary: parsed.musicRelated ? parsed.summary.trim() : ''
  };
}

function parseExtraction(raw: string): z.infer<typeof extractionSchema> {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { musicRelated: false, summary: '' };
  try {
    return extractionSchema.parse(JSON.parse(match[0]));
  } catch {
    return { musicRelated: false, summary: '' };
  }
}
```

- [ ] **Step 4: Implement context builder**

Create `src/server/music-agent/context.ts`:

```ts
import type { NcmClient } from '../ncm/client.js';
import { loadLatestPlan, todayDateStr } from '../store/plan.js';
import { getRecentMessages } from '../store/messages.js';
import { getRecentPlays } from '../store/plays.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { getPref } from '../store/prefs.js';
import { getQueue } from '../store/queue.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { fetchWeather } from '../weather.js';
import { getDailyTheme } from '../daily-theme.js';
import type { MusicAgentContextSummary } from './schema.js';

export type BuildMusicAgentContextInput = {
  userId: string;
  ncmClient: NcmClient;
  request: 'auto-fill' | 'chat-recommend';
  userText?: string;
};

export async function buildMusicAgentContext(input: BuildMusicAgentContextInput): Promise<MusicAgentContextSummary> {
  const now = new Date();
  const corpus = loadUserCorpus(input.userId);
  const weather = await fetchWeather(input.userId).catch(() => null);
  const plan = loadLatestPlan(input.userId, todayDateStr());
  const recentPlays = getRecentPlays(input.userId, 50);
  const recentChat = getRecentMessages(input.userId, 8, 120);
  const activeDirective = getActiveDirective(input.userId);
  const dailyTheme = getDailyTheme();
  const queue = getQueue(input.userId);

  return {
    request: input.request,
    currentMoment: {
      localTime: formatLocalTime(now),
      daypart: getDaypart(now.getHours()),
      weather: weather ? `${weather.tempC}°C，${weather.desc}` : null,
      dailyTheme: dailyTheme ? `${dailyTheme.theme}（${dailyTheme.keywords.join('、')}）` : undefined
    },
    activeDirective,
    currentPlanSegment: summarizePlanSegment(plan, now),
    tasteSummary: compactText(corpus.taste, 600),
    recentPreferenceSummary: compactText(getPreferenceContext(input.userId, 3), 600),
    recentPlaySignals: recentPlays.slice(0, 12).map((play) => `${play.song_name ?? '?'} - ${play.artist_name ?? '?'} (${play.end_reason ?? 'playing'})`).join('\n'),
    queueStateSummary: queue.slice(0, 8).map((track, index) => `${index + 1}. ${track.name ?? track.ncmId} - ${(track.artists ?? []).join(' / ')}`).join('\n'),
    bannedSummary: summarizeBans(input.userId),
  };
}

function getActiveDirective(userId: string): string {
  const directive = getPref<{ text?: string; expiresAt?: string }>(userId, 'queue.activeDirective');
  if (!directive?.text || !directive.expiresAt) return '';
  const expiresAt = Date.parse(directive.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return '';
  return directive.text.trim();
}

function summarizePlanSegment(plan: ReturnType<typeof loadLatestPlan>, now: Date): string | null {
  if (!plan) return null;
  const hour = now.getHours();
  const id = hour < 12 ? 'morning' : hour < 17 ? 'work' : hour < 21 ? 'evening' : 'late-night';
  const segment = plan.segments.find((item) => item.id === id) ?? plan.segments[0];
  if (!segment) return null;
  return `${segment.label}: mood=${segment.mood}, energy=${segment.energyPct}, tracks=${segment.tracks.map((track) => track.query).join(' / ')}`;
}

function summarizeBans(userId: string): string {
  const moodOverride = getPref<unknown>(userId, 'queue.moodOverride');
  const replanHint = getPref<unknown>(userId, 'plan.replanHint');
  return [
    moodOverride ? `queue.moodOverride=${JSON.stringify(moodOverride)}` : '',
    replanHint ? `plan.replanHint=${JSON.stringify(replanHint)}` : ''
  ].filter(Boolean).join('\n');
}

function compactText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}

function getDaypart(hour: number): string {
  if (hour >= 5 && hour < 9) return '早晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19) return '傍晚';
  if (hour >= 19 && hour < 23) return '晚上';
  return '深夜';
}
```

- [ ] **Step 5: Run memory tests**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-memory.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit memory and context**

```bash
git add src/server/music-agent/memory.ts src/server/music-agent/context.ts tests/unit/music-agent-memory.spec.ts
git commit -m "feat(agent): extract chat music memory"
```

---

### Task 6: Tools, Prompts, and Loop Runner

**Files:**
- Create: `src/server/music-agent/tools.ts`
- Create: `src/server/music-agent/prompts.ts`
- Create: `src/server/music-agent/loop.ts`
- Test: `tests/unit/music-agent-loop.spec.ts`

- [ ] **Step 1: Write failing loop tests**

Create `tests/unit/music-agent-loop.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { FakeLlmClient } from '../support/fake-llm';
import { CandidatePool } from '../../src/server/music-agent/candidates';
import { runMusicAgentLoop } from '../../src/server/music-agent/loop';
import type { MusicCandidate, MusicAgentContextSummary } from '../../src/server/music-agent/schema';

function context(): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
    currentMoment: { localTime: '周四 15:00', daypart: '下午', weather: null },
    activeDirective: '接下来多来点女声',
    currentPlanSegment: null,
    tasteSummary: '喜欢 City Pop',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}

function candidate(id: string): MusicCandidate {
  return {
    id,
    name: `Song ${id}`,
    artist: 'Singer',
    sources: ['liked'],
    evidence: ['test'],
    scores: {
      intentMatch: 1,
      tasteMatch: 1,
      timeFit: 1,
      planFit: 0,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 1
    }
  };
}

describe('music-agent loop', () => {
  it('executes a tool call and then accepts a whitelisted final pick', async () => {
    const pool = new CandidatePool();
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }))
      .queueResponse(JSON.stringify({ type: 'final', say: '选这首', picks: [{ id: '101', reason: '匹配女声', source: 'liked' }], rejected: [] }));

    const result = await runMusicAgentLoop({
      mode: 'pick_next',
      context: context(),
      candidatePool: pool,
      llmClient: fake,
      tools: {
        recall_from_liked: vi.fn(async () => {
          pool.upsert(candidate('101'));
          return { summary: 'added liked candidate', candidateCount: pool.count() };
        })
      },
      budget: { maxMs: 1000, maxSteps: 4, maxLlmCalls: 4, maxToolCalls: 4, maxNcmSearches: 4, maxPlaylistFetches: 2, maxTrendFetchMs: 100, maxCandidates: 20 }
    });

    expect(result.picks[0].id).toBe('101');
    expect(result.trace.map((step) => step.tool)).toContain('recall_from_liked');
  });

  it('falls back when final pick is not in the candidate pool', async () => {
    const pool = new CandidatePool();
    pool.upsert(candidate('101'));
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'final', say: '选不存在的', picks: [{ id: '999', reason: 'bad', source: 'liked' }], rejected: [] }));

    const result = await runMusicAgentLoop({
      mode: 'pick_next',
      context: context(),
      candidatePool: pool,
      llmClient: fake,
      tools: {},
      budget: { maxMs: 1000, maxSteps: 2, maxLlmCalls: 2, maxToolCalls: 1, maxNcmSearches: 1, maxPlaylistFetches: 1, maxTrendFetchMs: 100, maxCandidates: 20 }
    });

    expect(result.picks[0].id).toBe('101');
    expect(result.say).toContain('fallback');
  });

  it('does not execute more tools after abort', async () => {
    const pool = new CandidatePool();
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }));
    const controller = new AbortController();
    controller.abort(new Error('test abort'));

    const result = await runMusicAgentLoop({
      mode: 'pick_next',
      context: context(),
      candidatePool: pool,
      llmClient: fake,
      tools: {
        recall_from_liked: vi.fn(async () => ({ summary: 'should not run', candidateCount: 0 }))
      },
      signal: controller.signal,
      budget: { maxMs: 1000, maxSteps: 2, maxLlmCalls: 2, maxToolCalls: 1, maxNcmSearches: 1, maxPlaylistFetches: 1, maxTrendFetchMs: 100, maxCandidates: 20 }
    });

    expect(result.picks).toEqual([]);
    expect(result.say).toContain('aborted');
  });
});
```

- [ ] **Step 2: Run loop test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-loop.spec.ts
```

Expected: FAIL because `loop.ts` does not exist.

- [ ] **Step 3: Add prompts**

Create `src/server/music-agent/prompts.ts`:

```ts
import type { LlmMessage } from '../llm/client.js';
import type { MusicAgentContextSummary, MusicAgentToolName } from './schema.js';

const TOOL_NAMES: MusicAgentToolName[] = [
  'get_context_summary',
  'get_music_knowledge',
  'get_trend_context',
  'expand_queries',
  'recall_from_liked',
  'recall_from_playlists',
  'recall_from_plan_segment',
  'recall_from_ncm_search',
  'recall_from_trending',
  'recall_from_style_expansion',
  'rank_candidates',
  'diversify_candidates',
  'finalize_pick'
];

export function buildLoopMessages(input: {
  context: MusicAgentContextSummary;
  observations: string[];
  candidateSummary: string;
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 Crossfadio 的选歌 agent。你必须通过工具改善候选池，再从候选白名单中做最终选择。',
        '每轮只输出严格 JSON，不要输出 markdown。',
        '允许输出：{"type":"tool_call","tool":"工具名","input":{}} 或 {"type":"final","say":"...","picks":[...],"rejected":[...]}。',
        `工具白名单：${TOOL_NAMES.join(', ')}`,
        'final.picks 的 id 必须来自候选池，不能编造歌曲或 NCM id。',
        '短期 activeDirective 和当前聊天请求优先于趋势和大众榜单。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        '<context>',
        JSON.stringify(input.context),
        '</context>',
        '<candidate_pool>',
        input.candidateSummary || '候选池为空',
        '</candidate_pool>',
        '<observations>',
        input.observations.join('\n') || '暂无 observation',
        '</observations>'
      ].join('\n')
    }
  ];
}
```

- [ ] **Step 4: Add tools registry type**

Create `src/server/music-agent/tools.ts`:

```ts
import type { MusicAgentToolName } from './schema.js';

export type ToolObservation = {
  summary: string;
  candidateCount: number;
  problems?: string[];
};

export type MusicAgentTool = (input: unknown, signal?: AbortSignal) => Promise<ToolObservation>;

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>>;
```

- [ ] **Step 5: Implement loop runner**

Create `src/server/music-agent/loop.ts`:

```ts
import { musicAgentLoopOutputSchema, type AgentBudget, type MusicAgentContextSummary, type MusicAgentFinalOutput, type MusicAgentLlmClient } from './schema.js';
import { CandidatePool, validateFinalPicks } from './candidates.js';
import { diversifyCandidates, scoreCandidate } from './rank.js';
import { buildLoopMessages } from './prompts.js';
import type { MusicAgentToolRegistry } from './tools.js';

export type RunMusicAgentLoopInput = {
  mode: 'pick_next' | 'chat_recommend';
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  llmClient: MusicAgentLlmClient;
  tools: MusicAgentToolRegistry;
  budget: AgentBudget;
  signal?: AbortSignal;
};

export async function runMusicAgentLoop(input: RunMusicAgentLoopInput): Promise<MusicAgentFinalOutput> {
  const startedAt = Date.now();
  const observations: string[] = [];
  const trace: MusicAgentFinalOutput['trace'] = [];
  let llmCalls = 0;
  let toolCalls = 0;

  for (let step = 1; step <= input.budget.maxSteps; step++) {
    if (input.signal?.aborted) return emptyAborted(input.mode, trace);
    if (Date.now() - startedAt > input.budget.maxMs) break;
    if (llmCalls >= input.budget.maxLlmCalls) break;

    llmCalls++;
    const response = await input.llmClient.complete(buildLoopMessages({
      context: input.context,
      observations,
      candidateSummary: summarizeCandidates(input.candidatePool)
    }), { signal: input.signal, temperature: 0.2, maxTokens: 1000 });

    const parsed = parseLoopOutput(response.content);

    if (parsed.type === 'final') {
      try {
        const picks = validateFinalPicks(parsed.picks, input.candidatePool);
        return {
          mode: input.mode,
          say: parsed.say,
          picks,
          rejected: parsed.rejected,
          trace
        };
      } catch (error) {
        observations.push(`final rejected: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }

    if (toolCalls >= input.budget.maxToolCalls) break;
    const tool = input.tools[parsed.tool];
    if (!tool) {
      observations.push(`tool unavailable: ${parsed.tool}`);
      continue;
    }

    if (input.signal?.aborted) return emptyAborted(input.mode, trace);
    toolCalls++;
    const observation = await tool(parsed.input, input.signal);
    observations.push(`${parsed.tool}: ${observation.summary}`);
    trace.push({
      step,
      thoughtSummary: `called ${parsed.tool}`,
      tool: parsed.tool,
      toolInputSummary: JSON.stringify(parsed.input).slice(0, 200),
      observationSummary: observation.summary,
      candidateCount: input.candidatePool.count(),
      elapsedMs: Date.now() - startedAt
    });
  }

  return rankedFallback(input.mode, input.candidatePool, trace);
}

function parseLoopOutput(raw: string) {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { type: 'tool_call' as const, tool: 'rank_candidates' as const, input: {} };
  }
  try {
    return musicAgentLoopOutputSchema.parse(JSON.parse(match[0]));
  } catch {
    return { type: 'tool_call' as const, tool: 'rank_candidates' as const, input: {} };
  }
}

function rankedFallback(mode: MusicAgentFinalOutput['mode'], pool: CandidatePool, trace: MusicAgentFinalOutput['trace']): MusicAgentFinalOutput {
  const picks = diversifyCandidates(pool.topBy(scoreCandidate, 10), 2).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    reason: 'ranked fallback',
    source: candidate.sources[0]
  }));
  return {
    mode,
    say: picks.length > 0 ? 'fallback: 使用已排序候选补歌。' : 'fallback: 没有可用候选。',
    picks,
    rejected: [],
    trace
  };
}

function emptyAborted(mode: MusicAgentFinalOutput['mode'], trace: MusicAgentFinalOutput['trace']): MusicAgentFinalOutput {
  return { mode, say: 'aborted: 任务已取消。', picks: [], rejected: [], trace };
}

function summarizeCandidates(pool: CandidatePool): string {
  return pool.list()
    .slice(0, 30)
    .map((candidate, index) => `${index + 1}. id=${candidate.id} ${candidate.name} - ${candidate.artist} sources=${candidate.sources.join('/')} evidence=${candidate.evidence.slice(0, 2).join('; ')}`)
    .join('\n');
}
```

- [ ] **Step 6: Run loop tests**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-loop.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit loop runner**

```bash
git add src/server/music-agent/prompts.ts src/server/music-agent/tools.ts src/server/music-agent/loop.ts tests/unit/music-agent-loop.spec.ts
git commit -m "feat(agent): add bounded music tool loop"
```

---

### Task 7: MusicAgent Facade and Tool Implementations

**Files:**
- Create: `src/server/music-agent/index.ts`
- Modify: `src/server/music-agent/tools.ts`
- Test: `tests/unit/music-agent-integration.spec.ts`

- [ ] **Step 1: Write failing MusicAgent integration test**

Create `tests/unit/music-agent-integration.spec.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLlmClient } from '../support/fake-llm';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-music-agent-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('MusicAgent facade', () => {
  it('runs pickNext with recalled candidates and finalizes a whitelisted pick', async () => {
    const { MusicAgent } = await import('../../src/server/music-agent');
    const ncmClient = {
      getLikedSongIds: vi.fn(async () => ['101']),
      getSongDetails: vi.fn(async () => [{ id: 101, name: 'Soft Song', artists: ['Singer'] }]),
      searchSongs: vi.fn(async () => []),
      getPlaylistDetail: vi.fn(async () => null),
      getSearchHotDetail: vi.fn(async () => []),
      getTopSongHints: vi.fn(async () => []),
      getArtistToplist: vi.fn(async () => [])
    };
    const fake = new FakeLlmClient()
      .queueResponse(JSON.stringify({ type: 'tool_call', tool: 'recall_from_liked', input: {} }))
      .queueResponse(JSON.stringify({ type: 'final', say: '选红心里的轻歌', picks: [{ id: '101', reason: '红心且适合当前', source: 'liked' }], rejected: [] }));

    const agent = new MusicAgent({ llmClient: fake });
    const result = await agent.pickNext({ userId: 'user-1', ncmClient: ncmClient as any });

    expect(result.picks[0].id).toBe('101');
    expect(result.say).toContain('红心');
  });
});
```

- [ ] **Step 2: Run integration test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-integration.spec.ts
```

Expected: FAIL because `MusicAgent` facade does not exist.

- [ ] **Step 3: Expand tools registry with real recall and planning tools**

Modify `src/server/music-agent/tools.ts`:

```ts
import type { NcmClient } from '../ncm/client.js';
import { loadLatestPlan, todayDateStr } from '../store/plan.js';
import { CandidatePool } from './candidates.js';
import { diversifyCandidates, scoreCandidate } from './rank.js';
import { queryPlanSchema, type MusicAgentContextSummary, type MusicAgentToolName, type MusicCandidate, type QueryPlan, type TrendContext } from './schema.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { searchArtistsForStyle } from '../web-search.js';
import { getMusicKnowledgeSlice } from './knowledge.js';
import { buildTrendContext, type TrendCapableNcmClient } from './trends.js';

export type ToolObservation = {
  summary: string;
  candidateCount: number;
  problems?: string[];
};

export type MusicAgentTool = (input: unknown, signal?: AbortSignal) => Promise<ToolObservation>;

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>>;

export type CreateMusicAgentToolsInput = {
  userId: string;
  ncmClient: Pick<NcmClient, 'getLikedSongIds' | 'getSongDetails' | 'searchSongs' | 'getPlaylistDetail'> & Partial<TrendCapableNcmClient>;
  context: MusicAgentContextSummary;
  candidatePool: CandidatePool;
  maxTrendFetchMs?: number;
};

export function createMusicAgentTools(input: CreateMusicAgentToolsInput): MusicAgentToolRegistry {
  let queryPlan: QueryPlan = {
    intentQueries: [],
    tasteAnchorQueries: [],
    planQueries: [],
    trendQueries: [],
    explorationQueries: [],
    negativeTerms: [],
    rationale: ''
  };
  let trendContext: TrendContext | null = null;

  return {
    get_context_summary: async () => ({
      summary: JSON.stringify(input.context),
      candidateCount: input.candidatePool.count()
    }),
    get_music_knowledge: async (toolInput) => {
      const text = extractString(toolInput, 'text') || input.context.activeDirective || input.context.tasteSummary;
      const slice = getMusicKnowledgeSlice({ text, daypart: input.context.currentMoment.daypart });
      return {
        summary: JSON.stringify(slice),
        candidateCount: input.candidatePool.count()
      };
    },
    get_trend_context: async () => {
      if (!isTrendCapable(input.ncmClient)) {
        trendContext = {
          fetchedAt: new Date().toISOString(),
          locale: 'zh-CN',
          sources: [],
          hotArtists: [],
          hotStyles: [],
          chartTrackHints: [],
          confidence: 0
        };
      } else {
        trendContext = await buildTrendContext({
          ncmClient: input.ncmClient,
          locale: 'zh-CN',
          maxFetchMs: input.maxTrendFetchMs ?? 2_000
        });
      }
      return {
        summary: JSON.stringify(trendContext),
        candidateCount: input.candidatePool.count()
      };
    },
    expand_queries: async (toolInput) => {
      queryPlan = queryPlanSchema.parse(toolInput ?? {});
      return {
        summary: `query plan: ${JSON.stringify(queryPlan)}`,
        candidateCount: input.candidatePool.count()
      };
    },
    recall_from_liked: async () => {
      const ids = (await input.ncmClient.getLikedSongIds().catch(() => [] as string[])).slice(0, 30);
      const details = await input.ncmClient.getSongDetails(ids).catch(() => []);
      for (const track of details) {
        const artist = track.artists.join(' / ');
        if (!artist) continue;
        input.candidatePool.upsert(makeCandidate({
          id: String(track.id),
          name: track.name,
          artist,
          source: 'liked',
          evidence: '用户红心歌曲',
          sourceConfidence: 0.8,
          tasteMatch: 0.7
        }));
      }
      return { summary: `liked recall added ${details.length} tracks`, candidateCount: input.candidatePool.count() };
    },
    recall_from_playlists: async () => {
      const corpus = loadUserCorpus(input.userId);
      const playlists = corpus.playlists
        .filter((playlist) => playlist.segments.some((segment) => (input.context.currentPlanSegment ?? '').includes(segment)) || playlist.tags.length > 0)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 3);
      let added = 0;
      for (const playlist of playlists) {
        const detail = await input.ncmClient.getPlaylistDetail(playlist.id).catch(() => null);
        for (const track of detail?.tracks.slice(0, 20) ?? []) {
          const artist = track.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(track.id),
            name: track.name,
            artist,
            source: 'playlist',
            evidence: `来自歌单 ${playlist.name}`,
            sourceConfidence: 0.7,
            tasteMatch: 0.5,
            planFit: 0.5
          }));
          added++;
        }
      }
      return { summary: `playlist recall added ${added} tracks`, candidateCount: input.candidatePool.count() };
    },
    recall_from_plan_segment: async () => {
      const plan = loadLatestPlan(input.userId, todayDateStr());
      const segment = plan?.segments.find((item) => input.context.currentPlanSegment?.includes(item.label)) ?? plan?.segments[0];
      const queries = segment?.tracks.map((track) => track.query).slice(0, 8) ?? [];
      let added = 0;
      for (const query of queries) {
        const songs = await input.ncmClient.searchSongs(query, 3).catch(() => []);
        for (const song of songs) {
          const artist = song.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(song.id),
            name: song.name,
            artist,
            source: 'plan',
            evidence: `今日计划 query: ${query}`,
            sourceConfidence: 0.75,
            planFit: 0.9,
            intentMatch: 0.4
          }));
          added++;
        }
      }
      return { summary: `plan recall added ${added} tracks`, candidateCount: input.candidatePool.count() };
    },
    recall_from_ncm_search: async (toolInput) => {
      const explicitQueries = Array.isArray((toolInput as { queries?: unknown })?.queries)
        ? (toolInput as { queries: unknown[] }).queries.filter((query): query is string => typeof query === 'string')
        : [];
      const queries = uniqueStrings([
        ...explicitQueries,
        ...queryPlan.intentQueries,
        ...queryPlan.tasteAnchorQueries,
        ...queryPlan.planQueries,
        ...queryPlan.explorationQueries
      ]).slice(0, 8);
      let added = 0;
      for (const query of queries) {
        const songs = await input.ncmClient.searchSongs(query, 8).catch(() => []);
        for (const song of songs) {
          const artist = song.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(song.id),
            name: song.name,
            artist,
            source: 'search',
            evidence: `搜索 query: ${query}`,
            sourceConfidence: 0.55,
            intentMatch: queryPlan.intentQueries.includes(query) ? 0.8 : 0.4,
            tasteMatch: queryPlan.tasteAnchorQueries.includes(query) ? 0.7 : 0.3
          }));
          added++;
        }
      }
      return { summary: `search recall added ${added} tracks from ${queries.length} queries`, candidateCount: input.candidatePool.count() };
    },
    recall_from_trending: async () => {
      const trends = trendContext ?? {
        fetchedAt: new Date().toISOString(),
        locale: 'zh-CN' as const,
        sources: [],
        hotArtists: [],
        hotStyles: [],
        chartTrackHints: [],
        confidence: 0
      };
      const queries = uniqueStrings([
        ...trends.hotArtists.slice(0, 5),
        ...trends.hotStyles.slice(0, 5),
        ...queryPlan.trendQueries.slice(0, 5)
      ]).slice(0, 8);
      let added = 0;
      for (const hint of trends.chartTrackHints.slice(0, 10)) {
        const songs = await input.ncmClient.searchSongs(`${hint.title} ${hint.artist}`, 2).catch(() => []);
        for (const song of songs) {
          const artist = song.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(song.id),
            name: song.name,
            artist,
            source: 'trend',
            evidence: `趋势歌曲: ${hint.reason}`,
            sourceConfidence: 0.45,
            intentMatch: 0.3
          }));
          added++;
        }
      }
      for (const query of queries) {
        const songs = await input.ncmClient.searchSongs(query, 4).catch(() => []);
        for (const song of songs) {
          const artist = song.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(song.id),
            name: song.name,
            artist,
            source: 'trend',
            evidence: `趋势 query: ${query}`,
            sourceConfidence: 0.4,
            intentMatch: queryPlan.trendQueries.includes(query) ? 0.6 : 0.2
          }));
          added++;
        }
      }
      return { summary: `trend recall added ${added} tracks`, candidateCount: input.candidatePool.count() };
    },
    recall_from_style_expansion: async () => {
      const styles = uniqueStrings([...queryPlan.explorationQueries, ...queryPlan.tasteAnchorQueries]).slice(0, 3);
      const artists = (await Promise.all(styles.map((style) => searchArtistsForStyle(style).catch(() => [] as string[]))))
        .flat()
        .slice(0, 8);
      let added = 0;
      for (const artistQuery of artists) {
        const songs = await input.ncmClient.searchSongs(artistQuery, 4).catch(() => []);
        for (const song of songs) {
          const artist = song.artists.join(' / ');
          if (!artist) continue;
          input.candidatePool.upsert(makeCandidate({
            id: String(song.id),
            name: song.name,
            artist,
            source: 'style_expansion',
            evidence: `风格扩展艺人: ${artistQuery}`,
            sourceConfidence: 0.35,
            intentMatch: 0.3,
            tasteMatch: 0.4
          }));
          added++;
        }
      }
      return { summary: `style expansion added ${added} tracks`, candidateCount: input.candidatePool.count() };
    },
    rank_candidates: async () => ({
      summary: `ranked top candidates: ${input.candidatePool.topBy(scoreCandidate, 10).map((candidate) => candidate.id).join(', ')}`,
      candidateCount: input.candidatePool.count()
    }),
    diversify_candidates: async () => ({
      summary: `diversified candidates: ${diversifyCandidates(input.candidatePool.topBy(scoreCandidate, 10), 10).map((candidate) => candidate.id).join(', ')}`,
      candidateCount: input.candidatePool.count()
    })
  };
}

function makeCandidate(input: {
  id: string;
  name: string;
  artist: string;
  source: MusicCandidate['sources'][number];
  evidence: string;
  sourceConfidence: number;
  tasteMatch?: number;
  intentMatch?: number;
  planFit?: number;
}): MusicCandidate {
  return {
    id: input.id,
    name: input.name,
    artist: input.artist,
    sources: [input.source],
    evidence: [input.evidence],
    scores: {
      intentMatch: input.intentMatch ?? 0,
      tasteMatch: input.tasteMatch ?? 0,
      timeFit: 0.5,
      planFit: input.planFit ?? 0,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: input.sourceConfidence
    }
  };
}

function extractString(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function isTrendCapable(client: CreateMusicAgentToolsInput['ncmClient']): client is CreateMusicAgentToolsInput['ncmClient'] & TrendCapableNcmClient {
  return typeof client.getSearchHotDetail === 'function' &&
    typeof client.getTopSongHints === 'function' &&
    typeof client.getArtistToplist === 'function';
}
```

- [ ] **Step 4: Implement MusicAgent facade**

Create `src/server/music-agent/index.ts`:

```ts
import { LlmClient, type LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import { CandidatePool } from './candidates.js';
import { buildMusicAgentContext } from './context.js';
import { runMusicAgentLoop } from './loop.js';
import { createMusicAgentTools } from './tools.js';
import type { AgentBudget, MusicAgentFinalOutput, MusicAgentLlmClient } from './schema.js';

export type MusicAgentOptions = {
  llmClient?: MusicAgentLlmClient;
  llmConfig?: LlmConfig;
};

export type PickNextInput = {
  userId: string;
  ncmClient: NcmClient;
  signal?: AbortSignal;
};

export type ChatRecommendInput = PickNextInput & {
  userText: string;
};

export class MusicAgent {
  constructor(private readonly options: MusicAgentOptions = {}) {}

  async pickNext(input: PickNextInput): Promise<MusicAgentFinalOutput> {
    return this.run({
      mode: 'pick_next',
      request: 'auto-fill',
      userId: input.userId,
      ncmClient: input.ncmClient,
      signal: input.signal,
      budget: pickNextBudget()
    });
  }

  async recommendFromChat(input: ChatRecommendInput): Promise<MusicAgentFinalOutput> {
    return this.run({
      mode: 'chat_recommend',
      request: 'chat-recommend',
      userId: input.userId,
      ncmClient: input.ncmClient,
      userText: input.userText,
      signal: input.signal,
      budget: chatRecommendBudget()
    });
  }

  private async run(input: {
    mode: MusicAgentFinalOutput['mode'];
    request: 'auto-fill' | 'chat-recommend';
    userId: string;
    ncmClient: NcmClient;
    userText?: string;
    signal?: AbortSignal;
    budget: AgentBudget;
  }): Promise<MusicAgentFinalOutput> {
    const llmClient = this.resolveLlmClient();
    const context = await buildMusicAgentContext({
      userId: input.userId,
      ncmClient: input.ncmClient,
      request: input.request,
      userText: input.userText
    });
    const candidatePool = new CandidatePool({ maxCandidates: input.budget.maxCandidates });
    const tools = createMusicAgentTools({
      userId: input.userId,
      ncmClient: input.ncmClient,
      context,
      candidatePool,
      maxTrendFetchMs: input.budget.maxTrendFetchMs
    });

    return runMusicAgentLoop({
      mode: input.mode,
      context,
      candidatePool,
      llmClient,
      tools,
      budget: input.budget,
      signal: input.signal
    });
  }

  private resolveLlmClient(): MusicAgentLlmClient {
    if (this.options.llmClient) return this.options.llmClient;
    if (this.options.llmConfig) return new LlmClient(this.options.llmConfig);
    throw new Error('MusicAgent requires llmClient or llmConfig');
  }
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
```

- [ ] **Step 5: Run integration test**

Run:

```bash
pnpm exec vitest run tests/unit/music-agent-integration.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit MusicAgent facade**

```bash
git add src/server/music-agent/index.ts src/server/music-agent/tools.ts tests/unit/music-agent-integration.spec.ts
git commit -m "feat(agent): add music agent facade"
```

---

### Task 8: Route Integration for Chat and Pick-Next

**Files:**
- Modify: `src/server/http/chat-sse-worker.ts`
- Modify: `src/server/http/routes/djNext.ts`
- Test: `tests/unit/dj-next.spec.ts`
- Test: `tests/unit/music-agent-integration.spec.ts`

- [ ] **Step 1: Write route integration assertions**

Append these assertions to `tests/unit/dj-next.spec.ts`:

```ts
describe('DJ pick-next route integration', () => {
  it('documents that pick-next passes AbortSignal into MusicAgent', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/http/routes/djNext.ts'), 'utf-8');

    expect(source).toContain('new MusicAgent');
    expect(source).toContain('signal: controller.signal');
  });
});
```

- [ ] **Step 2: Run assertion to verify it fails**

Run:

```bash
pnpm exec vitest run tests/unit/dj-next.spec.ts
```

Expected: FAIL because `djNext.ts` does not instantiate `MusicAgent`.

- [ ] **Step 3: Integrate chat recommendation**

Modify `src/server/http/chat-sse-worker.ts`:

1. Add imports:

```ts
import { MusicAgent } from '../music-agent/index.js';
```

2. Inside the `isRecommend` branch, replace the call to `runChatRecommendPipeline(...)` with:

```ts
const agent = new MusicAgent({ llmConfig });
const output = await agent.recommendFromChat({
  userId,
  ncmClient,
  userText: text,
  signal: controller.signal
});
added = applyMusicAgentPicks(userId, output, songActions.some((a) => a.type === 'swap_next'));
reportProgress({ phase: 'done', tracks: output.picks.map((pick) => ({ name: pick.name ?? pick.id, artist: pick.artist ?? '' })) });
```

3. Add helper near `fallbackAddFromLiked`:

```ts
function applyMusicAgentPicks(
  userId: string,
  output: import('../music-agent/schema.js').MusicAgentFinalOutput,
  isSwap: boolean
): number {
  let added = 0;
  const alreadyQueued = new Set(getQueue(userId).map((track) => track.ncmId));
  for (const pick of output.picks) {
    if (alreadyQueued.has(pick.id)) continue;
    alreadyQueued.add(pick.id);
    const track = {
      ncmId: pick.id,
      name: pick.name,
      artists: pick.artist ? [pick.artist] : []
    };
    if (isSwap) {
      swapNext(userId, track);
    } else {
      addToQueue(userId, track, 'end');
    }
    added++;
  }
  return added;
}
```

Keep `runChatRecommendPipeline()` in the file until the new path is stable; remove it in a later cleanup commit after all tests pass.

- [ ] **Step 4: Integrate pick-next with signal**

Modify `src/server/http/routes/djNext.ts`:

1. Add import:

```ts
import { MusicAgent } from '../../music-agent/index.js';
```

2. Change `doPickNext` signature:

```ts
async function doPickNext(
  userId: string,
  ncmClient: NcmClient,
  emit: DjEventSink = (payload) => broadcastToUser(userId, payload),
  signal?: AbortSignal
): Promise<void> {
```

3. At the start of `doPickNext`, after daily theme setup, add the new path:

```ts
  const llmConfig = resolveLlmConfig();
  if (llmConfig && !signal?.aborted) {
    try {
      const agent = new MusicAgent({ llmConfig });
      const output = await agent.pickNext({ userId, ncmClient, signal });
      const prevQueueLength = getQueue(userId).length;
      for (const pick of output.picks) {
        if (signal?.aborted) return;
        addToQueue(userId, {
          ncmId: pick.id,
          name: pick.name,
          artists: pick.artist ? [pick.artist] : []
        }, 'end');
      }
      if (getQueue(userId).length > prevQueueLength) {
        emit({
          type: 'dj.debug',
          likedSample: [],
          sqRaw: output.trace.map((step) => step.observationSummary ?? step.thoughtSummary).join('\n'),
          searchQueries: [],
          searchedTracks: output.picks.map((pick) => ({ id: pick.id, name: pick.name, artist: pick.artist })),
          excludedIds: [],
          excludedDedupeKeys: [],
          totalCandidates: output.picks.length,
          selectedSay: output.say
        });
        broadcastAppended(userId, prevQueueLength, emit);
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'MusicAgent pick-next failed, using legacy fallback');
    }
  }
```

4. In `createSseDjPickNextHandler`, change the Promise.race call:

```ts
void Promise.race([doPickNext(userId, ncmClient, emit, controller.signal).then(() => 'done' as const), jobTimer]).then((result) => {
```

This keeps the legacy body below as fallback while introducing the new agent path.

- [ ] **Step 5: Run route tests**

Run:

```bash
pnpm exec vitest run tests/unit/dj-next.spec.ts tests/unit/music-agent-integration.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit route integration**

```bash
git add src/server/http/chat-sse-worker.ts src/server/http/routes/djNext.ts tests/unit/dj-next.spec.ts
git commit -m "feat(agent): route recommendations through music agent"
```

---

### Task 9: Full Verification and Cleanup

**Files:**
- Modify only files touched in prior tasks if verification reveals compile or test failures.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
pnpm exec vitest run \
  tests/unit/music-agent-schema.spec.ts \
  tests/unit/music-agent-candidates.spec.ts \
  tests/unit/music-agent-rank.spec.ts \
  tests/unit/music-agent-knowledge.spec.ts \
  tests/unit/music-agent-trends.spec.ts \
  tests/unit/music-agent-memory.spec.ts \
  tests/unit/music-agent-loop.spec.ts \
  tests/unit/music-agent-integration.spec.ts \
  tests/unit/dj-next.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat
git diff --check
```

Expected: `git diff --check` exits 0.

- [ ] **Step 5: Commit verification fixes if any were needed**

If Step 1-4 required changes, commit them:

```bash
git add src/server/music-agent src/server/ncm/client.ts src/server/http/chat-sse-worker.ts src/server/http/routes/djNext.ts tests/unit
git commit -m "fix(agent): stabilize music agent integration"
```

If no changes were needed, skip this commit.

- [ ] **Step 6: Report completion**

Report:

```text
Implemented MusicAgent tool-loop with retrieval/rerank candidate pool, curated music knowledge, trend context, chat memory extraction, route integration, and abort-safe pick-next wiring.

Verification:
- pnpm check
- pnpm test
```
