import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractQueueDirectiveFromText } from '../../src/server/http/chat-sse-worker';
import { buildDiscoveryModePromptParts, buildDjTimeContext, buildTrackDedupeKey, createDjPickNextFallbackStatsTracker, getCandidateSourceMix, getMusicAgentCandidateSourceDiagnostics, parseDjCandidatePicks, serializeDjPickNextErrorForLog, searchCandidates } from '../../src/server/http/routes/djNext';
import { LlmError } from '../../src/server/llm/client';
import type { NcmClient } from '../../src/server/ncm/client';
import type { NcmSong } from '../../src/shared/schema';

// ── Helpers ────────────────────────────────────────────────────────────────

const root = process.cwd();

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function extractBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectBefore(source: string, before: string, after: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex, `missing before marker: ${before}`).toBeGreaterThanOrEqual(0);
  expect(afterIndex, `missing after marker: ${after}`).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

function makeSong(id: number, name: string, artist: string): NcmSong {
  return { id, name, artists: [artist] };
}

function mockNcmClient(songMap: Record<string, NcmSong[]>): Pick<NcmClient, 'searchSongs'> {
  return {
    searchSongs: vi.fn(async (keywords: string) => songMap[keywords] ?? [])
  };
}

// ── serializeDjPickNextErrorForLog ─────────────────────────────────────────

describe('DJ pick-next diagnostics', () => {
  it('tracks route-level fallback rate by fallback path', () => {
    const tracker = createDjPickNextFallbackStatsTracker();

    expect(tracker.record({ path: 'music_agent_success' })).toMatchObject({
      totalRuns: 1,
      fallbackRuns: 0,
      fallbackRate: 0,
      fallbackPaths: {}
    });
    expect(tracker.record({ path: 'music_agent_ranked_fallback' })).toMatchObject({
      totalRuns: 2,
      fallbackRuns: 1,
      fallbackRate: 0.5,
      fallbackPaths: {
        music_agent_ranked_fallback: 1
      }
    });
    expect(tracker.record({ path: 'legacy_random_fallback' })).toMatchObject({
      totalRuns: 3,
      fallbackRuns: 2,
      fallbackRate: 0.667,
      fallbackPaths: {
        music_agent_ranked_fallback: 1,
        legacy_random_fallback: 1
      }
    });
  });

  it('keeps LLM HTTP details in structured log payloads', () => {
    const error = new LlmError(
      'LLM request failed: 400 Bad Request; response body: {"error":{"message":"bad schema"}}',
      {
        status: 400,
        statusText: 'Bad Request',
        responseBody: '{"error":{"message":"bad schema"}}'
      }
    );

    expect(serializeDjPickNextErrorForLog(error)).toEqual({
      name: 'LlmError',
      message: 'LLM request failed: 400 Bad Request; response body: {"error":{"message":"bad schema"}}',
      status: 400,
      statusText: 'Bad Request',
      responseBody: '{"error":{"message":"bad schema"}}'
    });
  });

  it('includes exclusion lists in DJ debug events for browser diagnostics', () => {
    const source = readSource('src/server/http/routes/djNext.ts');

    expect(source).toContain('excludedIds: Array.from(excludeState.ids)');
    expect(source).toContain('excludedDedupeKeys: Array.from(excludeState.dedupeKeys)');
  });

  it('includes actually appended MusicAgent final pick reasons in DJ debug events', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const musicAgentDebugHelper = extractBetween(source, 'function buildMusicAgentDebugPayload', 'function getMusicAgentRoutePath');

    expect(doPickNext).toContain('const appendedPicks: typeof output.picks = [];');
    expect(doPickNext).toContain('appendedPicks.push(pick);');
    expect(doPickNext).toContain('emit(buildMusicAgentDebugPayload({ output, appendedPicks, excludeState })');
    expect(musicAgentDebugHelper).toContain('selectedTracks: createMusicAgentSelectedTrackDebug(appendedPicks)');
    expect(musicAgentDebugHelper).toContain('reason: pick.reason');
    expect(musicAgentDebugHelper).toContain('source: pick.source');
  });

  it('routes MusicAgent ranked fallback picks through legacy LLM instead of appending them', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const rankedFallbackBlock = extractBetween(
      doPickNext,
      "if (output.status === 'ok' && hasRankedFallbackPicks(output)) {",
      "} else if (output.status === 'ok') {"
    );

    expect(rankedFallbackBlock).toContain("legacyFallbackPath = 'music_agent_legacy_fallback';");
    expect(rankedFallbackBlock).toContain('rankedFallbackPicks: createMusicAgentSelectedTrackDebug(output.picks)');
    expect(rankedFallbackBlock).toContain('MusicAgent returned ranked fallback picks, using legacy fallback');
    expectBefore(
      doPickNext,
      "if (output.status === 'ok' && hasRankedFallbackPicks(output))",
      'const pathQueueLength = getQueue(userId).length'
    );
    expect(source).toContain('function hasRankedFallbackPicks(output: MusicAgentRunOutput): boolean');
  });

  it('emits MusicAgent debug details before broadcasting partial append success', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const partialAppendBlock = extractBetween(
      doPickNext,
      'if (appendedCount > 0) {',
      "legacyFallbackPath = 'music_agent_legacy_fallback';"
    );

    expect(partialAppendBlock).toContain('emit(buildMusicAgentDebugPayload({');
    expect(partialAppendBlock).toContain('partial: true');
    expect(partialAppendBlock).toContain('skippedPicks: musicAgentSkippedPicks');
    expectBefore(partialAppendBlock, 'emit(buildMusicAgentDebugPayload({', 'broadcastAppended(');
  });

  it('emits legacy selected track details before broadcasting partial append success', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const legacyStart = doPickNext.indexOf('if (pickedTracks.length > 0) {');
    expect(legacyStart).toBeGreaterThanOrEqual(0);
    const legacySection = doPickNext.slice(legacyStart);
    const legacyPartialAppendBlock = extractBetween(
      legacySection,
      'if (appendedCount > 0) {',
      "logger.warn(\n          {\n            targetCount: targetPickCount,\n            appendedCount,\n            pickedCount: pickedTracks.length"
    );

    expect(legacyPartialAppendBlock).toContain('emit(buildLegacyDebugPayload({');
    expect(legacyPartialAppendBlock).toContain('selectedTracks: createLegacySelectedTrackDebug');
    expect(legacyPartialAppendBlock).toContain('partial: true');
    expectBefore(legacyPartialAppendBlock, 'emit(buildLegacyDebugPayload({', 'broadcastAppended(');
  });

  it('emits legacy selected track details before broadcasting full append success', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const legacyStart = doPickNext.indexOf('if (pickedTracks.length > 0) {');
    expect(legacyStart).toBeGreaterThanOrEqual(0);
    const legacySection = doPickNext.slice(legacyStart);
    const legacyFullAppendBlock = extractBetween(
      legacySection,
      'if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {',
      'const appendedCount = getQueue(userId).length - initialQueueLength;'
    );

    expect(legacyFullAppendBlock).toContain('emit(buildLegacyDebugPayload({');
    expect(legacyFullAppendBlock).toContain('selectedTracks: createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById)');
    expect(legacyFullAppendBlock).not.toContain("emit({ type: 'dj.debug', ...phase3Debug, selectedSay: pickSay })");
    expectBefore(legacyFullAppendBlock, 'emit(buildLegacyDebugPayload({', 'broadcastAppended(');
  });

  it('includes a console-table friendly candidate table in legacy debug events', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const phase3DebugBlock = extractBetween(
      doPickNext,
      'const phase3Debug = {',
      '};\n\n      logger.info('
    );

    expect(source).toContain('function createLegacyCandidateScoreTable');
    expect(phase3DebugBlock).toContain('candidateScoreTable: createLegacyCandidateScoreTable(allCandidates, likedSampleIds)');
    expect(source).toContain("sources: likedSampleIds.has(track.id) ? 'liked' : 'search'");
  });

  it('summarizes MusicAgent candidate sources for production diagnostics', () => {
    expect(getMusicAgentCandidateSourceDiagnostics({
      candidateScoreTable: [
        { rank: 1, id: '1', song: 'Liked', artist: 'A', sources: 'liked', baseScore: 1, artistPenalty: 0, trackPenalty: 0, repeatPenalty: 0, qualityPenalty: 0, titlePollutionPenalty: 0, adjustedScore: 1 },
        { rank: 2, id: '2', song: 'Merged', artist: 'B', sources: 'liked,search', baseScore: 1, artistPenalty: 0, trackPenalty: 0, repeatPenalty: 0, qualityPenalty: 0, titlePollutionPenalty: 0, adjustedScore: 1 },
        { rank: 3, id: '3', song: 'Trend', artist: 'C', sources: 'trend', baseScore: 1, artistPenalty: 0, trackPenalty: 0, repeatPenalty: 0, qualityPenalty: 0, titlePollutionPenalty: 0, adjustedScore: 1 }
      ]
    })).toEqual({
      nonLikedCandidateCount: 2,
      candidateSourceCounts: {
        liked: 2,
        search: 1,
        trend: 1
      }
    });
  });

  it('logs skipped pick reasons when append paths fall short of the target', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');

    expect(doPickNext).toContain('const musicAgentSkippedPicks: SkippedPickLog[] = [];');
    expect(doPickNext).toContain('const whitelistedSkippedPicks: SkippedPickLog[] = [];');
    expect(doPickNext).toContain('skippedPicks: musicAgentSkippedPicks');
    expect(doPickNext).toContain('skippedPicks: whitelistedSkippedPicks');
    expect(doPickNext).toContain("'id_excluded'");
    expect(doPickNext).toContain("'dedupe_excluded'");
    expect(doPickNext).not.toContain('excludedIds: Array.from(excludeState.ids),\n            excludedDedupeKeys: Array.from(excludeState.dedupeKeys),\n            skippedPicks');
  });

  it('routes DJ pick-next through MusicAgent with abort and status guards', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const runPickNextJob = extractBetween(source, 'async function runPickNextJob', 'async function doPickNext');
    const doPickNext = extractBetween(source, 'async function doPickNext', 'function broadcastAppended');
    const sseHandler = extractBetween(source, 'export function createSseDjPickNextHandler', 'function getScopedNcmClient');

    expect(runPickNextJob).toContain("controller.abort(new Error('job-timeout'))");
    expect(runPickNextJob).toContain('doPickNext(userId, ncmClient, undefined, controller.signal)');

    expect(sseHandler).toContain("controller.abort(new Error('job-timeout'))");
    expect(sseHandler).toContain('doPickNext(userId, ncmClient, emit, controller.signal)');
    expectBefore(sseHandler, 'if (isRunning.get(userId))', 'applyClientQueueSnapshot(req, userId)');

    expect(doPickNext).toContain('new MusicAgent');
    expect(doPickNext).toContain("output.status === 'ok'");
    expect(doPickNext).toContain('const targetPickCount = getAutoFillBatchSize(userId)');
    expect(doPickNext).toContain('createAbortTimeoutSignal(signal, getDjAgentTimeoutMs(targetPickCount))');
    expect(doPickNext).toContain('includeDailyTheme: dailyThemeEnabled');
    expect(doPickNext).toContain('const excludeState = getTodayAndQueueDedupeState(userId)');
    expect(doPickNext).toContain('const initialQueueLength = getQueue(userId).length');
    expect(doPickNext).toContain('excludeTrackIds: excludeState.ids');
    expect(doPickNext).toContain('excludeTrackDedupeKeys: excludeState.dedupeKeys');
    expect(doPickNext).toContain('targetPickCount');
    expect(doPickNext).toContain('if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) break');
    expect(doPickNext).toContain('if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount))');
    expect(doPickNext).toContain('djPickReasonCache.set(track.ncmId, output.say.trim())');
    expect(doPickNext).toContain('broadcastAppended(');
    expect(doPickNext).toContain('musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)');
    expect(source).toContain('rankedBackfillCount: metrics.rankedBackfillCount');
    expect(source).toContain('finalPickDiagnostics: metrics.finalPickDiagnostics');
    expect(source).toContain('totalCandidates: getMusicAgentDebugCandidateCount(output)');
    expect(doPickNext).not.toContain('totalCandidates: output.picks.length');
    expect(doPickNext).toContain('MusicAgent appended fewer than target');
    expect(doPickNext).toContain('whitelisted picks appended fewer than target');
    expect(doPickNext).toContain('getRemainingPickSlots(userId, initialQueueLength, targetPickCount) * 4');
    expect(doPickNext).toContain('targetCount: targetPickCount');
    expect(source).toContain('addedCount: newTracks.length');
    expect(source).toContain('trackNames: names');
    expect(source).toContain('trackIds: newTracks.map((track) => track.ncmId)');

    expect(doPickNext).toContain('const styleAbort = createAbortTimeoutSignal(signal, SEARCH_QUERY_LLM_TIMEOUT_MS)');
    expect(doPickNext).toContain('{ signal: styleAbort.signal }');
    expect(doPickNext).toContain('styleAbort.cleanup()');
    expectBefore(doPickNext, 'const styleAbort = createAbortTimeoutSignal(signal, SEARCH_QUERY_LLM_TIMEOUT_MS)', 'new LlmClient(llmConfig).complete');
    expectBefore(doPickNext, '{ signal: styleAbort.signal }', 'styleAbort.cleanup()');

    expect(doPickNext).toContain('const pickAbort = createAbortTimeoutSignal(signal, PICK_LLM_TIMEOUT_MS)');
    expect(doPickNext).toContain('{ signal: pickAbort.signal }');
    expect(doPickNext).toContain('pickAbort.cleanup()');
    expectBefore(doPickNext, 'const pickAbort = createAbortTimeoutSignal(signal, PICK_LLM_TIMEOUT_MS)', 'parseDjCandidatePicks');
    expectBefore(doPickNext, '{ signal: pickAbort.signal }', 'pickAbort.cleanup()');
  });

  it('keeps the MusicAgent auto-fill timeout above slow final-pick windows', () => {
    const musicAgentSource = readSource('src/server/music-agent/index.ts');
    const djNextSource = readSource('src/server/http/routes/djNext.ts');

    expect(musicAgentSource).toContain('maxMs: largeBatch ? 150_000 : 120_000');
    expect(djNextSource).toContain('const DJ_AGENT_TIMEOUT_MS = 135_000');
    expect(djNextSource).toContain('const LARGE_BATCH_DJ_AGENT_TIMEOUT_MS = 165_000');
  });

  it('does not apply stale client queue snapshots to already-running DJ jobs', () => {
    const source = readSource('src/server/http/routes/djNext.ts');
    const jsonHandler = extractBetween(source, 'export function createDjPickNextHandler', 'async function runPickNextJob');
    const sseHandler = extractBetween(source, 'export function createSseDjPickNextHandler', 'function getScopedNcmClient');

    expectBefore(jsonHandler, 'if (isRunning.get(userId))', 'applyClientQueueSnapshot(req, userId)');
    expectBefore(sseHandler, 'if (isRunning.get(userId))', 'applyClientQueueSnapshot(req, userId)');
    expect(jsonHandler).toContain('res.json({ ok: true, running: true })');
    expect(sseHandler).toContain("endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' })");
  });

  it('routes chat recommendations through MusicAgent with status guards', () => {
    const source = readSource('src/server/http/chat-sse-worker.ts');
    const recommendBlock = extractBetween(source, 'if (isRecommend) {', '      } else {\n        if (signal?.aborted) return;');
    const applyPicks = extractBetween(source, 'function applyMusicAgentPicks', 'function createAbortTimeoutSignal');

    expect(recommendBlock).toContain('new MusicAgent');
    expect(recommendBlock).toContain('recommendFromChat');
    expect(recommendBlock).toContain('actions: songActions');
    expect(recommendBlock).toContain('createAbortTimeoutSignal(controller.signal, CHAT_AGENT_TIMEOUT_MS)');
    expect(recommendBlock).toContain("output.status === 'aborted'");
    expect(recommendBlock).toContain("if (signal?.aborted) {\n          onParentAbort();\n        } else {\n          signal?.addEventListener('abort', onParentAbort, { once: true });\n        }");
    expect(recommendBlock).toContain('const addedTracks = applyMusicAgentPicks');
    expect(recommendBlock).toContain("if (!shouldRunLegacyFallback && addedTracks.length > 0)");
    expectBefore(recommendBlock, 'const addedTracks = applyMusicAgentPicks', "reportProgress({ phase: 'done'");
    expectBefore(recommendBlock, "if (!shouldRunLegacyFallback && addedTracks.length > 0)", "reportProgress({ phase: 'done'");

    expect(applyPicks).toContain('getRecentPlays(userId, RECENT_PLAY_EXCLUDE_COUNT)');
    expect(applyPicks).toContain('const queuedTracks = getQueue(userId)');
    expect(applyPicks).toContain('const excludedIds = new Set([...recentIds, ...queuedTracks.map((track) => track.ncmId)])');
    expect(applyPicks).toContain('const excludedDedupeKeys = new Set([...recentDedupeKeys, ...queueDedupeKeys])');
    expect(applyPicks).toContain('const dedupeKey = buildTrackDedupeKey(pick)');
    expect(applyPicks).toContain('isTrackDedupeKeyExcluded(dedupeKey, excludedDedupeKeys)');
  });
});

describe('DJ discovery mode prompt parts', () => {
  const tasteHints = ['该用户的音乐品味偏好：粤语流行、City Pop、陈奕迅'];

  it('uses personal taste as an expansion seed in explore mode', () => {
    const parts = buildDiscoveryModePromptParts('explore', tasteHints);

    expect(parts.tasteContext).toContain('品味外延');
    expect(parts.styleInstruction).toContain('今日主题、时间、天气');
    expect(parts.pickInstruction).toContain('有可解释连接');
    expect(parts.pickInstruction).not.toContain('优先选择符合用户品味偏好的歌曲');
  });

  it('keeps personal taste as a strong anchor in comfort mode', () => {
    const parts = buildDiscoveryModePromptParts('comfort', tasteHints);

    expect(parts.tasteContext).toContain('个人品味锚点');
    expect(parts.styleInstruction).toContain('优先推荐符合该用户品味偏好的风格和艺人');
    expect(parts.pickInstruction).toContain('优先选择符合用户品味偏好的歌曲');
  });
});

describe('DJ candidate source mix', () => {
  it('uses fewer liked-song candidates in explore mode than comfort mode', () => {
    const explore = getCandidateSourceMix('explore');
    const comfort = getCandidateSourceMix('comfort');

    expect(explore.likedSampleSize).toBeLessThan(comfort.likedSampleSize);
    expect(explore.likedSampleSize).toBeLessThanOrEqual(Math.floor(explore.searchResultSize / 4));
    expect(explore.preferSearchCandidates).toBe(true);
    expect(comfort.preferSearchCandidates).toBe(false);
  });
});

describe('DJ time context', () => {
  it('labels afternoon explicitly so pick reasons do not infer night', () => {
    const context = buildDjTimeContext(new Date(2026, 4, 15, 14, 30));

    expect(context.localTime).toBe('周五 14:30（下午）');
    expect(context.sayInstruction).toContain('当前时间段是“下午”');
    expect(context.sayInstruction).toContain('不要写成晚上');
  });

  it('uses Shanghai time even when the server process timezone is UTC', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const context = buildDjTimeContext(new Date('2026-06-09T04:30:00.000Z'));

      expect(context.localTime).toBe('周二 12:30（中午）');
      expect(context.daypart).toBe('中午');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('chat queue directives', () => {
  it('documents queue.activeDirective as a set_pref action in the chat intent prompt', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/agent/modes.ts'), 'utf-8');

    expect(source).toContain('queue.activeDirective');
    expect(source).toContain('"ttlHours": 6');
    expect(source).toContain('{ "type": "set_pref", "key": "queue.activeDirective", "value": null }');
  });

  it('extracts a short-lived female-vocal directive from casual chat text', () => {
    const directive = extractQueueDirectiveFromText(
      '这个下午多来点女歌手吧，才休息一天就上班有点累了',
      new Date('2026-05-11T06:00:00.000Z')
    );

    expect(directive?.text).toContain('女声');
    expect(directive?.text).toContain('女歌手');
    expect(directive?.expiresAt).toBe('2026-05-11T12:00:00.000Z');
  });

  it('treats explicit negative wording as clearing the female-vocal directive', () => {
    const directive = extractQueueDirectiveFromText('先不要女声了', new Date('2026-05-11T06:00:00.000Z'));

    expect(directive).toEqual({ text: '', expiresAt: '2026-05-11T06:00:00.000Z' });
  });
});

// ── searchCandidates ───────────────────────────────────────────────────────

describe('searchCandidates', () => {
  it('returns empty array when given no queries', async () => {
    const ncm = mockNcmClient({});
    const result = await searchCandidates([], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([]);
    expect(ncm.searchSongs).not.toHaveBeenCalled();
  });

  it('maps NcmSong id+name+artists into Track shape', async () => {
    const ncm = mockNcmClient({
      '周杰伦': [makeSong(123, '夜曲', '周杰伦')]
    });
    const result = await searchCandidates(['周杰伦'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([{ id: '123', name: '夜曲', artist: '周杰伦' }]);
  });

  it('excludes tracks whose id is in excludeIds', async () => {
    const ncm = mockNcmClient({
      '民谣': [makeSong(1, '成都', '赵雷'), makeSong(2, '理想三旬', '陈鸿宇')]
    });
    const result = await searchCandidates(['民谣'], ncm as unknown as NcmClient, new Set(['1']), 20);
    expect(result.map((t) => t.id)).toEqual(['2']);
  });

  it('deduplicates tracks that appear in multiple query results', async () => {
    const ncm = mockNcmClient({
      'query1': [makeSong(10, 'A', 'X'), makeSong(11, 'B', 'Y')],
      'query2': [makeSong(11, 'B', 'Y'), makeSong(12, 'C', 'Z')]
    });
    const result = await searchCandidates(['query1', 'query2'], ncm as unknown as NcmClient, new Set(), 20);
    const ids = result.map((t) => t.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('excludes same song by normalized title and primary artist even when NCM ids differ', async () => {
    const ncm = mockNcmClient({
      'Bob Marley': [
        makeSong(25702070, 'Three Little Birds', 'Bob Marley'),
        makeSong(100, 'Could You Be Loved', 'Bob Marley')
      ]
    });
    const excludedKey = buildTrackDedupeKey({
      name: 'Three Little Birds',
      artist: 'Bob Marley / The Wailers'
    });

    const result = await searchCandidates(
      ['Bob Marley'],
      ncm as unknown as NcmClient,
      new Set(['2066898431']),
      20,
      undefined,
      new Set([excludedKey])
    );

    expect(result.map((track) => track.id)).toEqual(['100']);
  });

  it('excludes source-prefixed live variants by normalized title and primary artist', async () => {
    const ncm = mockNcmClient({
      '钟舒漫': [
        makeSong(1, '感应 + 给自己的信 (Live)', '钟舒漫'),
        makeSong(2, '下一首', '钟舒漫')
      ]
    });
    const excludedKey = buildTrackDedupeKey({
      name: '给自己的信(Live)',
      artist: '钟舒漫'
    });

    const result = await searchCandidates(
      ['钟舒漫'],
      ncm as unknown as NcmClient,
      new Set(),
      20,
      undefined,
      new Set([excludedKey])
    );

    expect(result.map((track) => track.id)).toEqual(['2']);
  });

  it('deduplicates source-prefixed variants within search results by title similarity', async () => {
    const ncm = mockNcmClient({
      '钟舒漫': [
        makeSong(1, '感应 + 给自己的信 (Live)', '钟舒漫'),
        makeSong(2, '给自己的信(Live)', '钟舒漫'),
        makeSong(3, '下一首', '钟舒漫')
      ]
    });

    const result = await searchCandidates(['钟舒漫'], ncm as unknown as NcmClient, new Set(), 20);

    expect(result.map((track) => track.id)).toEqual(['1', '3']);
  });

  it('deduplicates high-overlap title variants that are not exact substrings', async () => {
    const ncm = mockNcmClient({
      '莫文蔚': [
        makeSong(1, '慢慢喜欢你', '莫文蔚'),
        makeSong(2, '慢慢地喜欢你', '莫文蔚'),
        makeSong(3, '阴天', '莫文蔚')
      ]
    });

    const result = await searchCandidates(['莫文蔚'], ncm as unknown as NcmClient, new Set(), 20);

    expect(result.map((track) => track.id)).toEqual(['1', '3']);
  });

  it('respects the limit and stops collecting once reached', async () => {
    const songs = Array.from({ length: 30 }, (_, i) => makeSong(i + 1, `Song${i}`, 'X'));
    const ncm = mockNcmClient({ 'pop': songs });
    const result = await searchCandidates(['pop'], ncm as unknown as NcmClient, new Set(), 5);
    expect(result).toHaveLength(5);
  });

  it('spreads the per-query limit across multiple queries', async () => {
    // With limit=20 and 2 queries → perQuery = ceil(25/2) = 13
    // Both queries return results → should combine up to 20
    const songs1 = Array.from({ length: 13 }, (_, i) => makeSong(i + 1, `A${i}`, 'X'));
    const songs2 = Array.from({ length: 13 }, (_, i) => makeSong(i + 100, `B${i}`, 'Y'));
    const ncm = mockNcmClient({ 'q1': songs1, 'q2': songs2 });
    const result = await searchCandidates(['q1', 'q2'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toHaveLength(20);
    // results should include tracks from both queries
    const fromQ1 = result.filter((t) => parseInt(t.id) < 100);
    const fromQ2 = result.filter((t) => parseInt(t.id) >= 100);
    expect(fromQ1.length).toBeGreaterThan(0);
    expect(fromQ2.length).toBeGreaterThan(0);
  });

  it('returns empty array when NCM search throws (error is swallowed)', async () => {
    const ncm: Pick<NcmClient, 'searchSongs'> = {
      searchSongs: vi.fn().mockRejectedValue(new Error('NCM unavailable'))
    };
    const result = await searchCandidates(['test'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([]);
  });

  it('joins multiple artists with " / "', async () => {
    const ncm = mockNcmClient({
      'collab': [{ id: 42, name: 'Track', artists: ['Artist A', 'Artist B'] }]
    });
    const result = await searchCandidates(['collab'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result[0].artist).toBe('Artist A / Artist B');
  });
});

// ── parseDjCandidatePicks ──────────────────────────────────────────────────

describe('parseDjCandidatePicks', () => {
  const candidates = [
    { id: '101', name: '候选一', artist: '歌手一' },
    { id: '202', name: '候选二', artist: '歌手二' },
    { id: '303', name: '候选三', artist: '歌手三' }
  ];

  it('keeps only IDs that exist in the candidate pool', () => {
    const parsed = parseDjCandidatePicks(
      JSON.stringify({
        say: '选两首',
        pickIds: ['202', '999', '303']
      }),
      candidates
    );

    expect(parsed.say).toBe('选两首');
    expect(parsed.tracks.map((track) => track.id)).toEqual(['202', '303']);
  });

  it('maps 1-based candidate indexes to whitelisted candidate tracks', () => {
    const parsed = parseDjCandidatePicks(
      JSON.stringify({
        say: '按编号选',
        picks: [2, 4, 1]
      }),
      candidates
    );

    expect(parsed.tracks.map((track) => track.id)).toEqual(['202', '101']);
  });

  it('keeps picks up to the configured target count', () => {
    const batchCandidates = [1, 2, 3, 4, 5].map((id) => ({
      id: String(id),
      name: `Song ${id}`,
      artist: `Artist ${id}`
    }));

    const parsed = parseDjCandidatePicks(
      JSON.stringify({ say: '一次补五首', pickIds: ['1', '2', '3', '4', '5'] }),
      batchCandidates,
      5
    );

    expect(parsed.tracks.map((track) => track.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps per-track reasons from structured LLM picks', () => {
    const parsed = parseDjCandidatePicks(
      JSON.stringify({
        say: '整体偏轻快',
        picks: [
          { id: '202', reason: '节奏轻快，适合周一上午提神' },
          { index: 1, reason: '旋律明亮，和夏日主题贴合' }
        ]
      }),
      candidates
    );

    expect(parsed.tracks.map((track) => track.id)).toEqual(['202', '101']);
    expect(parsed.reasonsById).toEqual({
      '202': '节奏轻快，适合周一上午提神',
      '101': '旋律明亮，和夏日主题贴合'
    });
  });
});
