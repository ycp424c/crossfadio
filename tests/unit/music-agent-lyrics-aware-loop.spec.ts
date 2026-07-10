import { describe, expect, it, vi } from 'vitest';
import { CandidatePool } from '../../src/server/music-agent/candidates.js';
import { runMusicAgentLoop } from '../../src/server/music-agent/loop.js';
import type { FinalShortlistEnricher } from '../../src/server/music-agent/final-shortlist-enrichment.js';
import type { MusicAgentToolRegistry } from '../../src/server/music-agent/tools.js';
import type {
  AgentBudget,
  MusicAgentContextSummary,
  MusicAgentLlmClient,
  MusicCandidate,
  QueryPlan
} from '../../src/server/music-agent/schema.js';
import type {
  ShortlistPromptPacket,
  TrackAssessment
} from '../../src/server/music-agent/track-understanding.js';

function budget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return {
    maxMs: 10_000,
    maxSteps: 6,
    maxLlmCalls: 6,
    maxToolCalls: 3,
    maxNcmSearches: 0,
    maxPlaylistFetches: 0,
    maxTrendFetchMs: 0,
    maxCandidates: 20,
    ...overrides
  };
}

function context(): MusicAgentContextSummary {
  return {
    request: 'auto-fill',
    currentUserText: '想听舒缓安静的歌',
    currentMoment: {
      localTime: '2026-07-10T20:00:00+08:00',
      daypart: 'evening',
      weather: null,
      dailyTheme: '舒缓'
    },
    activeDirective: '保持舒缓，不要太吵',
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}

function queryPlan(constraints = ['calm']): QueryPlan {
  return {
    exactTrackQueries: [], artistAnchors: [], albumAnchors: [], playlistQueries: [],
    intentQueries: [], tasteAnchorQueries: [], trendQueries: [], explorationQueries: [],
    styleHints: [], listeningConstraints: constraints, avoidArtists: [], negativeTerms: [], rationale: ''
  };
}

function candidate(id: string, overrides: Partial<MusicCandidate> = {}): MusicCandidate {
  return {
    id,
    name: `Song ${id}`,
    artist: `Artist ${id}`,
    sources: ['search'],
    evidence: [],
    scores: {
      intentMatch: 0.9,
      tasteMatch: 0.8,
      timeFit: 0.8,
      contextFit: 0.8,
      novelty: 0.5,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.8
    },
    ...overrides
  };
}

function assessment(
  id: string,
  overrides: Partial<TrackAssessment['profile']> = {},
  claim = 'mood=calm'
): TrackAssessment {
  return {
    id,
    profile: {
      genres: [], moods: ['calm'], energy: 'low', aggression: 'low',
      vocalIntensity: 'low', lyricThemes: [], language: 'unknown', ...overrides
    },
    confidence: {
      genres: 0.9, moods: 0.9, energy: 0.9, aggression: 0.9,
      vocalIntensity: 0.9, lyricThemes: 0.2, language: 0.2
    },
    evidence: [{ claim, source: 'lyric_analysis' }]
  };
}

function evidencePacket(item: MusicCandidate): ShortlistPromptPacket {
  return {
    id: item.id,
    name: item.name,
    artist: item.artist,
    sources: item.sources,
    ...(item.qualitySignals ? { qualitySignals: item.qualitySignals } : {}),
    kind: 'evidence',
    lyricEvidence: {
      lyricStatus: 'available', lyricHash: `hash-${item.id}`, sampleMode: 'full',
      credits: { lyricist: ['Writer'] }, lineCount: 2, hasTranslation: false,
      repeatedHookCount: 0, sampledCharCount: 20,
      sampledLines: [{ position: 'opening', text: 'untrusted raw lyric' }]
    },
    wikiTags: []
  };
}

function profilePacket(item: MusicCandidate, value: TrackAssessment): ShortlistPromptPacket {
  return {
    id: item.id,
    name: item.name,
    artist: item.artist,
    sources: item.sources,
    kind: 'profile',
    assessment: value
  };
}

function enricherFor(
  items: MusicCandidate[],
  packets: ShortlistPromptPacket[] = items.map(evidencePacket)
): FinalShortlistEnricher {
  return vi.fn(async () => ({
    shortlist: items,
    promptPackets: packets,
    diagnostics: {
      shortlistCount: items.length,
      cacheHits: packets.filter((packet) => packet.kind === 'profile').length,
      cacheMisses: packets.filter((packet) => packet.kind !== 'profile').length,
      lyricAttempted: 0, lyricSuccess: 0, lyricMissing: 0, lyricFail: 0,
      lyricTimeout: 0, lyricCancelled: 0, wikiAttempted: 0, wikiSuccess: 0,
      wikiFail: 0, wikiTimeout: 0, wikiCancelled: 0, cacheWriteFailed: 0,
      sampledChars: 0, elapsedMs: 12, deadlineReached: false
    }
  }));
}

function llm(responses: unknown[]): MusicAgentLlmClient & { calls: number } {
  const client = {
    calls: 0,
    async complete() {
      const response = responses[client.calls++];
      return { content: JSON.stringify(response), model: 'test-model' };
    }
  };
  return client;
}

function finalOutput(picks: string[], assessments: TrackAssessment[]) {
  return {
    type: 'final', say: 'done', assessments,
    picks: picks.map((id) => ({ id, reason: 'fit', source: 'search' })), rejected: []
  };
}

describe('lyrics-aware music agent loop', () => {
  it('routes an unassessed direct final through one fused call and applies query-plan fit constraints', async () => {
    const death = candidate('death');
    const calm = candidate('calm');
    const pool = new CandidatePool();
    pool.upsert(death); pool.upsert(calm);
    const enrich = enricherFor([death, calm]);
    const persisted: TrackAssessment[][] = [];
    const client = llm([
      finalOutput(['death', 'calm'], []),
      finalOutput(['death', 'calm'], [
        assessment('death', { genres: ['death metal'], energy: 'high', aggression: 'high' }, 'genre=death metal'),
        assessment('calm')
      ])
    ]);
    const tools: MusicAgentToolRegistry = { getQueryPlan: () => queryPlan(['calm']) };

    const result = await runMusicAgentLoop({
      llmClient: client, context: context(), candidatePool: pool, tools,
      budget: budget(), targetPickCount: 2, lyricsSelectionMode: 'enforce_fit',
      finalShortlistEnricher: enrich,
      persistTrackAssessments: async (value) => { persisted.push(value.assessments); }
    });

    expect(client.calls).toBe(2);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(result.picks.map((pick) => pick.id)).toEqual(['calm']);
    expect(persisted[0]?.map((item) => item.id)).toEqual(['death', 'calm']);
    expect(result.finalPickDiagnostics).toMatchObject({ semanticConflictDroppedCount: 1 });
    expect(result.lyricsAwareDiagnostics).toMatchObject({
      mode: 'enforce_fit', assessmentCoverageValid: true, allReturnedPicksAssessed: true,
      enforcementApplied: true
    });
    expect(result.lyricsAwareDiagnostics?.decisions.find((item) => item.id === 'death')).toMatchObject({
      compatibility: 'conflict'
    });
  });

  it('reuses the same enrichment when the hard-final retry is needed', async () => {
    const one = candidate('one');
    const two = candidate('two');
    const three = candidate('three');
    const pool = new CandidatePool(); pool.upsert(one); pool.upsert(two); pool.upsert(three);
    const enrich = enricherFor([one, two, three]);
    const client = llm([
      finalOutput(['one', 'two'], []),
      { type: 'tool_call', tool: 'rank_candidates', input: {} },
      finalOutput(['one', 'two'], [assessment('one'), assessment('two'), assessment('three')])
    ]);

    const result = await runMusicAgentLoop({
      llmClient: client, context: context(), candidatePool: pool,
      tools: {},
      budget: budget(), targetPickCount: 2, lyricsSelectionMode: 'shadow',
      finalShortlistEnricher: enrich
    });

    expect(result.status).toBe('ok');
    expect(client.calls).toBe(3);
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', [assessment('one')]],
    ['duplicate', [assessment('one'), assessment('one')]],
    ['unknown', [assessment('one'), assessment('unknown')]]
  ])('blocks enforcement and persistence for %s assessment coverage', async (_case, assessments) => {
    const one = candidate('one'); const two = candidate('two');
    const pool = new CandidatePool(); pool.upsert(one); pool.upsert(two);
    const persist = vi.fn();
    const client = llm([finalOutput(['one'], []), finalOutput(['one'], assessments)]);

    const result = await runMusicAgentLoop({
      llmClient: client, context: context(), candidatePool: pool, tools: {},
      budget: budget(), lyricsSelectionMode: 'enforce_fit',
      finalShortlistEnricher: enricherFor([one, two]), persistTrackAssessments: persist
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(result.finalPickDiagnostics).toMatchObject({ assessmentValidationFailureCount: 1 });
    expect(result.lyricsAwareDiagnostics).toMatchObject({ assessmentCoverageValid: false, fallbackSuppressed: true });
  });

  it('keeps the final picks in shadow mode even when assessment coverage is invalid', async () => {
    const one = candidate('one'); const two = candidate('two');
    const pool = new CandidatePool(); pool.upsert(one); pool.upsert(two);
    const result = await runMusicAgentLoop({
      llmClient: llm([finalOutput(['one'], []), finalOutput(['one'], [assessment('one')])]),
      context: context(), candidatePool: pool, tools: {}, budget: budget(),
      lyricsSelectionMode: 'shadow', finalShortlistEnricher: enricherFor([one, two])
    });

    expect(result.status).toBe('ok');
    expect(result.picks.map((pick) => pick.id)).toEqual(['one']);
    expect(result.lyricsAwareDiagnostics?.assessmentCoverageValid).toBe(false);
  });

  it('backfills only assessed compatible shortlist tracks without another LLM call', async () => {
    const one = candidate('one'); const death = candidate('death'); const two = candidate('two');
    const pool = new CandidatePool(); pool.upsert(one); pool.upsert(death); pool.upsert(two);
    const client = llm([
      finalOutput(['one'], []),
      finalOutput([], [
        assessment('one'),
        assessment('death', { genres: ['death metal'], energy: 'high', aggression: 'high' }, 'genre=death metal'),
        assessment('two')
      ])
    ]);
    const result = await runMusicAgentLoop({
      llmClient: client, context: context(), candidatePool: pool,
      tools: { getQueryPlan: () => queryPlan(['calm']) }, budget: budget(), targetPickCount: 2,
      lyricsSelectionMode: 'enforce_fit', finalShortlistEnricher: enricherFor([one, death, two])
    });

    expect(client.calls).toBe(2);
    expect(result.picks.map((pick) => pick.id)).toEqual(['one', 'two']);
    expect(result.finalPickDiagnostics).toMatchObject({ rankedBackfillCount: 2, semanticConflictDroppedCount: 1 });
  });

  it('does not let ranked fallback reselect a cached aggressive assessment', async () => {
    const death = candidate('death'); const pool = new CandidatePool(); pool.upsert(death);
    const deathAssessment = assessment(
      'death', { genres: ['death metal'], energy: 'high', aggression: 'high' }, 'genre=death metal'
    );
    const result = await runMusicAgentLoop({
      llmClient: llm([]), context: context(), candidatePool: pool,
      tools: { getQueryPlan: () => queryPlan(['calm']) }, budget: budget({ maxSteps: 0 }),
      lyricsSelectionMode: 'enforce_fit',
      finalShortlistEnricher: enricherFor([death], [profilePacket(death, deathAssessment)])
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(result.finalPickDiagnostics).toMatchObject({ semanticConflictDroppedCount: 1 });
    expect(result.lyricsAwareDiagnostics).toMatchObject({ fallbackSuppressed: true });
  });

  it('returns a safety-blocked empty result when ranked convergence has no eligible assessed track', async () => {
    const items = ['death-1', 'death-2'].map((id) => candidate(id));
    const pool = new CandidatePool(); items.forEach((item) => pool.upsert(item));
    const profiles = items.map((item) => profilePacket(item, assessment(
      item.id, { genres: ['death metal'], energy: 'high', aggression: 'high' }, 'genre=death metal'
    )));
    const result = await runMusicAgentLoop({
      llmClient: llm([{ type: 'tool_call', tool: 'finalize_pick', input: {} }]),
      context: context(), candidatePool: pool,
      tools: {
        getQueryPlan: () => queryPlan(['calm']),
        finalize_pick: async () => ({ summary: 'ready', candidateCount: 2 })
      },
      budget: budget({ maxLlmCalls: 1 }), lyricsSelectionMode: 'enforce_fit',
      finalShortlistEnricher: enricherFor(items, profiles)
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(result.lyricsAwareDiagnostics?.fallbackSuppressed).toBe(true);
  });

  it('fails closed instead of throwing when shortlist enrichment itself fails', async () => {
    const one = candidate('one'); const pool = new CandidatePool(); pool.upsert(one);
    const result = await runMusicAgentLoop({
      llmClient: llm([]), context: context(), candidatePool: pool, tools: {},
      budget: budget({ maxSteps: 0 }), lyricsSelectionMode: 'enforce_fit',
      finalShortlistEnricher: vi.fn(async () => { throw new Error('cache unavailable'); })
    });

    expect(result.status).toBe('empty_pool');
    expect(result.picks).toEqual([]);
    expect(result.lyricsAwareDiagnostics).toMatchObject({
      assessmentCoverageValid: false, fallbackSuppressed: true,
      assessmentValidationProblems: ['enrichment_failed']
    });
  });

  it('drops suspicious external tracks in enforce_all when an acceptable alternative exists', async () => {
    const spam = candidate('spam', {
      artist: '网络歌手',
      qualitySignals: { popularity: 1, albumName: null, copyright: 1 }
    });
    const good = candidate('good', {
      qualitySignals: { popularity: 80, albumName: 'Real Album', copyright: 1 }
    });
    const pool = new CandidatePool(); pool.upsert(spam); pool.upsert(good);
    const result = await runMusicAgentLoop({
      llmClient: llm([
        finalOutput(['spam', 'good'], []),
        finalOutput(['spam', 'good'], [assessment('spam'), assessment('good')])
      ]),
      context: context(), candidatePool: pool, tools: {}, budget: budget(), targetPickCount: 2,
      lyricsSelectionMode: 'enforce_all', finalShortlistEnricher: enricherFor([spam, good])
    });

    expect(result.picks.map((pick) => pick.id)).toEqual(['good']);
    expect(result.finalPickDiagnostics).toMatchObject({ qualityDroppedCount: 1 });
  });

  it('keeps the exact legacy behavior when lyrics selection is off', async () => {
    const one = candidate('one'); const pool = new CandidatePool(); pool.upsert(one);
    const enrich = enricherFor([one]);
    const client = llm([finalOutput(['one'], [])]);
    const result = await runMusicAgentLoop({
      llmClient: client, context: context(), candidatePool: pool, tools: {}, budget: budget(),
      lyricsSelectionMode: 'off', finalShortlistEnricher: enrich
    });

    expect(result.picks.map((pick) => pick.id)).toEqual(['one']);
    expect(client.calls).toBe(1);
    expect(enrich).not.toHaveBeenCalled();
    expect(result.lyricsAwareDiagnostics).toBeUndefined();
  });
});
