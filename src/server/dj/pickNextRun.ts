import type { Track } from '../agent/schema.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import { LlmClient } from '../llm/client.js';
import { resolveLlmConfig } from '../llm/config.js';
import type { NcmClient } from '../ncm/client.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { getRecentPlays, getTodayPlayedSongIds, getTodayPlays } from '../store/plays.js';
import { getRecentMessages } from '../store/messages.js';
import { getRecentSegues } from '../store/segues.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { fetchWeather } from '../weather.js';
import { searchArtistsForStyle } from '../web-search.js';
import { getQueue } from '../store/queue.js';
import { getPref } from '../store/prefs.js';
import { getActiveTemporaryQueueBanDedupeState } from '../store/temporary-bans.js';
import { broadcastToUser } from '../http/broadcast.js';
import { getLogger } from '../logger.js';
import { getOrGenerateDailyThemeWithin } from '../daily-theme.js';
import { MusicAgent } from '../music-agent/index.js';
import { DJAgent } from '../dj-agent/index.js';
import { createLegacyCandidatePool } from './legacyCandidatePool.js';
import { loadLegacyLikedSample } from './legacyLikedSample.js';
import { handleLegacyPickNextOutput } from './legacyPickNextResult.js';
import { buildLegacyPickPrompt } from './legacyPickPrompt.js';
import { handleLegacyRandomFallback } from './legacyRandomFallback.js';
import {
  buildLegacySearchQueries,
  discoverLegacyWebArtists,
  parseLegacyStyleArtistResponse
} from './legacyStyleDiscovery.js';
import { buildLegacyStylePrompt } from './legacyStylePrompt.js';
import { createDjPickNextTelemetry } from './pickNextTelemetry.js';
import {
  buildTrackDedupeKey,
  getMusicAgentCandidateSourceDiagnostics,
  handleMusicAgentPickNextOutput,
  isLyricsAwareSafetyBlock,
  isTrackDedupeKeyExcluded
} from './musicAgentPickNextResult.js';
import type {
  DedupeState,
  DjEventSink,
  DjPickNextFallbackPath
} from './musicAgentPickNextResult.js';
import type { DjSelectionEventContext } from './eventLogging.js';
import { formatShanghaiLocalTime, getDaypart, getShanghaiTimeParts } from '../timezone.js';
import { parseAutoFillBatchSize, parseDiscoveryMode } from '../../shared/dj.js';
import type { DiscoveryMode } from '../../shared/dj.js';

export { buildTrackDedupeKey, getMusicAgentCandidateSourceDiagnostics, isTrackDedupeKeyExcluded };
export type { DiscoveryMode } from '../../shared/dj.js';
export type { DjPickNextFallbackPath } from './musicAgentPickNextResult.js';

export function handleLyricsAwareSafetyBlockAtRoute(input: {
  result: { status: 'handled' | 'legacy-fallback' | 'aborted'; output: MusicAgentRunOutput };
  handle(): void;
}): boolean {
  if (input.result.status === 'aborted' && isLyricsAwareSafetyBlock(input.result.output)) {
    input.handle();
    return true;
  }
  return false;
}

const JOB_TIMEOUT_MS = 180_000;
const LARGE_BATCH_JOB_TIMEOUT_MS = 210_000;
const SEARCH_QUERY_LLM_TIMEOUT_MS = 120_000;
const PICK_LLM_TIMEOUT_MS = 120_000;
const LIKED_IDS_TIMEOUT_MS = 8_000;
const LIKED_DETAILS_TIMEOUT_MS = 8_000;
const LIKED_IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const LIKED_SAMPLE_SIZE = 20;
const EXPLORE_LIKED_SAMPLE_SIZE = 8;
const SEARCH_RESULT_SIZE = 40;
const DAILY_THEME_CONTEXT_TIMEOUT_MS = 1_500;
const DJ_AGENT_TIMEOUT_MS = 135_000;
const LARGE_BATCH_DJ_AGENT_TIMEOUT_MS = 165_000;

const djPickNextTelemetry = createDjPickNextTelemetry();
const djPickNextFallbackStats = djPickNextTelemetry.fallbackStats;
const broadcastAppended = djPickNextTelemetry.broadcastAppended;
type LikedIdsCache = { ids: string[]; fetchedAt: number };
const likedIdsCache = new Map<string, LikedIdsCache>();

type QueueActiveDirective = {
  text: string;
  expiresAt: string;
};

// trackId → short DJ selection reason, populated on each successful LLM pick
const djPickReasonCache = new Map<string, string>();

export function getDjPickReason(trackId: string): string | null {
  return djPickReasonCache.get(trackId) ?? null;
}

export type DjTimeContext = {
  localTime: string;
  daypart: string;
  contextInstruction: string;
  sayInstruction: string;
};

export function buildDjTimeContext(date: Date): DjTimeContext {
  const daypart = getDaypart(getShanghaiTimeParts(date).hour);
  const localTime = `${formatShanghaiLocalTime(date)}（${daypart}）`;
  const contextInstruction = `当前时间段是“${daypart}”，所有时间判断都必须以这个时间段为准；今日主题和天气只影响氛围，不能覆盖当前时间段。`;
  const sayInstruction = `say 字段必须与当前时间一致：当前时间段是“${daypart}”。不要写成晚上、夜晚、深夜、周五晚或其他不匹配的时间段。`;

  return { localTime, daypart, contextInstruction, sayInstruction };
}

function getDiscoveryMode(userId: string): DiscoveryMode {
  return parseDiscoveryMode(getPref<DiscoveryMode>(userId, 'discovery.mode'));
}

function getAutoFillBatchSize(userId: string): number {
  return parseAutoFillBatchSize(getPref<number>(userId, 'dj.autoFillBatchSize'));
}

function getJobTimeoutMs(targetPickCount: number): number {
  return targetPickCount >= 4 ? LARGE_BATCH_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS;
}

function getDjAgentTimeoutMs(targetPickCount: number): number {
  return targetPickCount >= 4 ? LARGE_BATCH_DJ_AGENT_TIMEOUT_MS : DJ_AGENT_TIMEOUT_MS;
}

export function buildDiscoveryModePromptParts(
  mode: DiscoveryMode,
  tasteHints: string[]
): {
  tasteContext: string;
  styleInstruction: string;
  pickInstruction: string;
  userContextLabel: string;
} {
  if (tasteHints.length === 0) {
    return {
      tasteContext: '',
      styleInstruction: '请根据今日主题、时间、天气、最近播放和 DJ 偏好，推荐 2-3 个适合当下情境的音乐风格方向。',
      pickInstruction: '从候选歌曲列表中挑选最适合当前情境的 2 首，返回它们的候选歌曲 id。',
      userContextLabel: ''
    };
  }

  if (mode === 'comfort') {
    return {
      tasteContext: `\n## 个人品味锚点\n${tasteHints.join('\n')}\n（舒适区模式：选曲时优先选择符合以上品味的风格和艺人，允许少量相邻扩展。）\n`,
      styleInstruction: '请根据以上信息（包括今日主题和个人品味偏好），推荐 2-3 个适合当下情境的音乐风格方向。优先推荐符合该用户品味偏好的风格和艺人。',
      pickInstruction: '优先选择符合用户品味偏好的歌曲，同时兼顾当前时间、天气、今日主题和最近播放，返回候选歌曲 id。',
      userContextLabel: `用户品味偏好：${tasteHints.join('；')}\n`
    };
  }

  if (mode === 'legacy') {
    return {
      tasteContext: `\n## Legacy LLM 参考\n${tasteHints.join('\n')}\n（Legacy LLM 模式：跳过 MusicAgent，只使用旧版 LLM 候选生成和白名单选曲链路。）\n`,
      styleInstruction: '请沿用旧版 LLM 自动选曲思路，根据今日主题、时间、天气、最近播放、DJ 偏好与个人品味，推荐 2-3 个适合当下情境的音乐风格方向。',
      pickInstruction: '沿用旧版 LLM 选择逻辑：从候选歌曲列表中挑选适合当前情境、用户品味和 DJ 偏好的歌曲，返回候选歌曲 id。',
      userContextLabel: `Legacy LLM 参考：${tasteHints.join('；')}\n`
    };
  }

  return {
    tasteContext: `\n## 个人品味外延\n${tasteHints.join('\n')}\n（探索模式：把个人品味当作出发点和边界，向相邻风格、陌生艺人、今日主题、时间、天气与 DJ 偏好扩展；不要只复刻用户已知偏好。）\n`,
    styleInstruction: '请根据今日主题、时间、天气、最近播放、DJ 偏好与个人品味外延，推荐 2-3 个适合当下情境且有新鲜感的音乐风格方向。',
    pickInstruction: '选择与用户品味有可解释连接、但能由今日主题/时间/天气/DJ 偏好带出新鲜感的歌曲，返回候选歌曲 id。',
    userContextLabel: `用户品味外延参考：${tasteHints.join('；')}\n`
  };
}

export function getCandidateSourceMix(mode: DiscoveryMode): {
  likedSampleSize: number;
  searchResultSize: number;
  preferSearchCandidates: boolean;
} {
  return mode === 'comfort' || mode === 'legacy'
    ? {
        likedSampleSize: LIKED_SAMPLE_SIZE,
        searchResultSize: SEARCH_RESULT_SIZE,
        preferSearchCandidates: false
      }
    : {
        likedSampleSize: EXPLORE_LIKED_SAMPLE_SIZE,
        searchResultSize: SEARCH_RESULT_SIZE,
        preferSearchCandidates: true
      };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function createAbortTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeoutId = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason ?? new Error('aborted'));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
    timedOut: () => didTimeOut
  };
}

// Fisher-Yates sample: return up to n random items from arr
function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Run parallel NCM searches, deduplicate results, exclude known IDs
export async function searchCandidates(
  queries: string[],
  ncmClient: NcmClient,
  excludeIds: Set<string>,
  limit: number,
  signal?: AbortSignal,
  excludeDedupeKeys: Set<string> = new Set()
): Promise<Track[]> {
  if (queries.length === 0) return [];
  if (signal?.aborted) return [];
  const perQuery = Math.max(3, Math.ceil((limit + 5) / queries.length));
  const results = await Promise.all(
    queries.map((q) => signal?.aborted ? [] : ncmClient.searchSongs(q, perQuery).catch(() => []))
  );
  const seen = new Set<string>();
  const seenDedupeKeys = new Set<string>();
  const tracks: Track[] = [];
  for (const songs of results) {
    for (const song of songs) {
      const id = String(song.id);
      const track = { id, name: song.name, artist: song.artists.join(' / ') };
      const dedupeKey = buildTrackDedupeKey(track);
      if (
        !seen.has(id)
        && !excludeIds.has(id)
        && !isTrackDedupeKeyExcluded(dedupeKey, excludeDedupeKeys)
        && !isTrackDedupeKeyExcluded(dedupeKey, seenDedupeKeys)
        && song.artists.length > 0
      ) {
        seen.add(id);
        if (dedupeKey) seenDedupeKeys.add(dedupeKey);
        tracks.push(track);
        if (tracks.length >= limit) return tracks;
      }
    }
  }
  return tracks;
}

export type ParsedDjCandidatePicks = {
  say: string;
  tracks: Track[];
  reasonsById: Record<string, string>;
};

export function parseDjCandidatePicks(raw: string, candidates: Track[], targetPickCount = 2): ParsedDjCandidatePicks {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { say: '', tracks: [], reasonsById: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { say: '', tracks: [], reasonsById: {} };
  }

  if (!parsed || typeof parsed !== 'object') return { say: '', tracks: [], reasonsById: {} };

  const obj = parsed as Record<string, unknown>;
  const say = typeof obj.say === 'string' ? obj.say : '';
  const byId = new Map(candidates.map((track) => [track.id, track]));
  const seen = new Set<string>();
  const tracks: Track[] = [];
  const reasonsById: Record<string, string> = {};

  const addTrack = (track: Track | undefined, reason?: unknown): void => {
    if (!track) return;
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!seen.has(track.id)) {
      seen.add(track.id);
      tracks.push(track);
    }
    if (normalizedReason && !reasonsById[track.id]) {
      reasonsById[track.id] = normalizedReason;
    }
  };

  const resolveById = (value: unknown): Track | undefined => {
    const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    return id ? byId.get(id) : undefined;
  };

  const resolveByIndex = (value: unknown): Track | undefined => {
    const index = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
    return Number.isInteger(index) ? candidates[index - 1] : undefined;
  };

  const addById = (value: unknown): void => {
    addTrack(resolveById(value));
  };

  const addByIndex = (value: unknown): void => {
    addTrack(resolveByIndex(value));
  };

  for (const key of ['pickIds', 'ids', 'trackIds']) {
    const values = obj[key];
    if (Array.isArray(values)) values.forEach(addById);
  }

  for (const key of ['picks', 'indexes', 'indices', 'candidateIndexes']) {
    const values = obj[key];
    if (Array.isArray(values)) {
      for (const value of values) {
        if (value && typeof value === 'object') {
          const pick = value as Record<string, unknown>;
          addTrack(resolveById(pick.id) ?? resolveByIndex(pick.index), pick.reason);
        } else {
          addByIndex(value);
        }
      }
    }
  }

  for (const key of ['reasons', 'pickReasons', 'reasonsById']) {
    const reasons = obj[key];
    if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) continue;
    for (const [id, reason] of Object.entries(reasons as Record<string, unknown>)) {
      const track = byId.get(id);
      if (track && seen.has(track.id)) addTrack(track, reason);
    }
  }

  const selectedTracks = tracks.slice(0, targetPickCount);
  const selectedIds = new Set(selectedTracks.map((track) => track.id));
  const selectedReasonsById: Record<string, string> = {};
  for (const [id, reason] of Object.entries(reasonsById)) {
    if (selectedIds.has(id)) selectedReasonsById[id] = reason;
  }

  return { say, tracks: selectedTracks, reasonsById: selectedReasonsById };
}

export { getAutoFillBatchSize, getJobTimeoutMs };

export async function runDjPickNext(
  userId: string,
  ncmClient: NcmClient,
  emit: DjEventSink = (payload) => broadcastToUser(userId, payload),
  signal?: AbortSignal
): Promise<void> {
  const logger = getLogger();
  const startedAt = Date.now();
  let debugBroadcastSent = false;
  const dailyThemeEnabled = getPref<boolean>(userId, 'dailyTheme.enabled') !== false;
  const targetPickCount = getAutoFillBatchSize(userId);
  const discoveryMode = getDiscoveryMode(userId);
  const dailyThemePromise = dailyThemeEnabled
    ? getOrGenerateDailyThemeWithin(DAILY_THEME_CONTEXT_TIMEOUT_MS)
    : Promise.resolve(null);
  const excludeState = getTodayAndQueueDedupeState(userId);
  const initialQueueLength = getQueue(userId).length;
  let legacyFallbackPath: DjPickNextFallbackPath | undefined;
  let djEventContext: DjSelectionEventContext | undefined;

  const llmConfig = resolveLlmConfig(userId);
  if (llmConfig && discoveryMode === 'legacy') {
    logger.info(
      { discoveryMode, targetPickCount },
      'DJ pick-next: Legacy LLM mode selected, skipping MusicAgent'
    );
  }

  if (llmConfig && discoveryMode !== 'legacy' && !signal?.aborted) {
    const agentAbort = createAbortTimeoutSignal(signal, getDjAgentTimeoutMs(targetPickCount));
    try {
      const agent = new DJAgent({
        musicAgentFactory: (config) => new MusicAgent({ llmConfig: config })
      });
      const result = await agent.pickNext({
        userId,
        ncmClient,
        llmConfig,
        includeDailyTheme: dailyThemeEnabled,
        signal: agentAbort.signal,
        excludeState,
        initialQueueLength,
        targetPickCount,
        startedAt,
        discoveryMode,
        emit,
        broadcastAppended,
        logger,
        setPickReason: (trackId, reason) => djPickReasonCache.set(trackId, reason),
        recordRouteOutcome: djPickNextTelemetry.recordFallbackStats,
        fallbackStatsSnapshot: () => djPickNextFallbackStats.snapshot()
      });
      const output = result.output;
      djEventContext = {
        runId: result.runId,
        selectionStartedEventId: result.selectionStartedEventId
      };
      if (signal?.aborted) return;
      if (handleLyricsAwareSafetyBlockAtRoute({
        result,
        handle: () => handleMusicAgentPickNextOutput({
          userId,
          output,
          excludeState,
          initialQueueLength,
          targetPickCount,
          startedAt,
          discoveryMode,
          emit,
          broadcastAppended,
          logger,
          setPickReason: (trackId, reason) => djPickReasonCache.set(trackId, reason),
          recordRouteOutcome: djPickNextTelemetry.recordFallbackStats,
          fallbackStatsSnapshot: () => djPickNextFallbackStats.snapshot()
        })
      })) {
        return;
      }
      if (output.status === 'aborted') {
        if (!agentAbort.timedOut()) return;
        legacyFallbackPath = 'music_agent_legacy_fallback';
        logger.warn(
          { fallbackPath: legacyFallbackPath, fallbackStats: djPickNextFallbackStats.snapshot() },
          'DJ pick-next: MusicAgent timed out, using legacy fallback'
        );
      }
      if (result.status === 'handled') {
        debugBroadcastSent = result.debugBroadcastSent;
        return;
      }
      if (result.status === 'legacy-fallback') {
        debugBroadcastSent = result.debugBroadcastSent;
        legacyFallbackPath = result.legacyFallbackPath;
      }
    } catch (err) {
      if (signal?.aborted) return;
      legacyFallbackPath = 'music_agent_legacy_fallback';
      logger.warn(
        { err, fallbackPath: legacyFallbackPath, fallbackStats: djPickNextFallbackStats.snapshot() },
        'DJ pick-next: MusicAgent failed, using legacy fallback'
      );
    } finally {
      agentAbort.cleanup();
    }
  }

  if (signal?.aborted) return;

  // Refresh full liked-song ID list at most once per day
  const now = Date.now();
  const cached = likedIdsCache.get(userId);
  if (!cached || now - cached.fetchedAt > LIKED_IDS_CACHE_TTL_MS) {
    const freshIds = await withTimeout(
      ncmClient.getLikedSongIds().catch(() => [] as string[]),
      LIKED_IDS_TIMEOUT_MS,
      [] as string[]
    );
    if (signal?.aborted) return;
    if (freshIds.length > 0) {
      likedIdsCache.set(userId, { ids: freshIds, fetchedAt: now });
    }
  }
  const allLikedIds = likedIdsCache.get(userId)?.ids ?? [];

  if (!llmConfig) {
    logger.warn('DJ pick-next: skipping LLM pick because LLM config is missing');
  } else if (allLikedIds.length === 0) {
    logger.warn('DJ pick-next: skipping LLM pick because liked tracks are unavailable');
  }

  if (llmConfig && allLikedIds.length > 0) {
    try {
      const candidateMix = getCandidateSourceMix(discoveryMode);
      const corpus = loadUserCorpus(userId);
      const [weather] = await Promise.all([withTimeout(fetchWeather(userId), 4_000, null)]);
      if (signal?.aborted) return;
      const nowDate = new Date();
      const timeContext = buildDjTimeContext(nowDate);
      const localTime = timeContext.localTime;
      const nowIso = nowDate.toISOString();
      const recentPlays = getRecentPlays(userId, 50);
      const recentChat = getRecentMessages(userId, 20, 60);
      const recentSegues = getRecentSegues(userId, 10);
      const extractedPreferences = getPreferenceContext(userId, 3);
      const activeDirective = getActiveQueueDirective(userId);

      // ── Personal taste context (weighted into style and pick prompts) ──
      const tasteHints: string[] = [];
      if (corpus.taste && corpus.taste.trim()) {
        tasteHints.push(`该用户的音乐品味偏好：${corpus.taste.trim()}`);
      }
      if (extractedPreferences) {
        tasteHints.push(`最近聊天中提到的偏好：${extractedPreferences}`);
      }
      if (activeDirective) {
        tasteHints.unshift(`当前短期选歌指令：${activeDirective}`);
      }
      const modePrompt = buildDiscoveryModePromptParts(discoveryMode, tasteHints);
      const tasteContext = modePrompt.tasteContext;

      const excludeState = getTodayAndQueueDedupeState(userId);
      const excludeIds = excludeState.ids;

      // ── Phase 1: sample IDs from full liked list, then fetch details ──
      const likedSampleResult = await loadLegacyLikedSample({
        allLikedIds,
        excludeIds,
        excludeDedupeKeys: excludeState.dedupeKeys,
        likedSampleSize: candidateMix.likedSampleSize,
        sampleIds: sampleN,
        fetchSongDetails: (ids) => withTimeout(
          ncmClient.getSongDetails(ids).catch(() => []),
          LIKED_DETAILS_TIMEOUT_MS,
          []
        ),
        buildTrackDedupeKey,
        isTrackDedupeKeyExcluded
      });
      const likedSample = likedSampleResult.likedSample;

      logger.info(
        {
          totalLikedIds: allLikedIds.length,
          candidateCount: likedSampleResult.candidateCount,
          likedSampleTarget: likedSampleResult.likedSampleTarget,
          sampledCount: likedSample.length
        },
        'DJ pick-next: sampled liked tracks from full list'
      );

      // ── Phase 2: LLM suggests styles + artists → Wikipedia enrichment → NCM search queries ─
      const recentPlayNames = recentPlays
        .slice(0, 10)
        .map((p) => `${p.song_name ?? '?'} — ${p.artist_name ?? '?'}`)
        .join('\n');
      const weatherText = weather ? `${weather.tempC}°C，${weather.desc}` : '未知';
      // Resolve daily theme — either cached or freshly generated
      const dailyTheme = await dailyThemePromise;
      if (signal?.aborted) return;
      const stylePrompt = buildLegacyStylePrompt({
        localTime,
        timeContextInstruction: timeContext.contextInstruction,
        weatherText,
        recentPlayNames,
        dailyTheme,
        tasteContext,
        styleInstruction: modePrompt.styleInstruction
      });

      let llmArtists: string[] = [];
      let styleConcepts: string[] = [];
      let sqRawSay = '';
      const styleAbort = createAbortTimeoutSignal(signal, SEARCH_QUERY_LLM_TIMEOUT_MS);
      try {
        const sqResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: corpus.djPersona || 'You are a DJ.' },
            { role: 'user', content: stylePrompt }
          ],
          { signal: styleAbort.signal }
        );
        sqRawSay = sqResp.content;
        const parsedStyleArtists = parseLegacyStyleArtistResponse(sqResp.content);
        styleConcepts = parsedStyleArtists.styleConcepts;
        llmArtists = parsedStyleArtists.llmArtists;
        if (llmArtists.length === 0) {
          logger.warn({ raw: sqResp.content.slice(0, 200) }, 'DJ pick-next: failed to parse style+artists from LLM response');
        }
      } catch (err) {
        if (signal?.aborted) return;
        logger.warn({ err }, 'DJ pick-next: style + artist generation failed');
      } finally {
        styleAbort.cleanup();
      }
      if (signal?.aborted) return;

      logger.info({ styleConcepts, llmArtistCount: llmArtists.length }, 'DJ pick-next: LLM suggested styles and artists');

      // Web search (Wikipedia) each style concept to find additional artists
      const webArtists = await discoverLegacyWebArtists(styleConcepts, searchArtistsForStyle);
      if (styleConcepts.length > 0) {
        logger.info({ webArtistCount: webArtists.length }, 'DJ pick-next: Wikipedia found additional artists');
      }

      const searchQueryPlan = buildLegacySearchQueries({
        llmArtists,
        webArtists,
        styleConcepts,
        dailyTheme,
        directiveQueries: activeDirective ? buildDirectiveSearchQueries(activeDirective) : []
      });
      const searchQueries = searchQueryPlan.searchQueries;
      if (searchQueryPlan.themeKeywordsAdded > 0) {
        logger.info({ themeKeywordsAdded: searchQueryPlan.themeKeywordsAdded }, 'DJ pick-next: mixed daily theme keywords into search queries');
      }
      if (searchQueryPlan.usedStyleFallback) {
        logger.warn(
          { searchQueries: searchQueryPlan.styleFallbackSourceQueries ?? searchQueries, styleConcepts },
          'DJ pick-next: too few artist names, falling back to style keywords'
        );
      }

      logger.info({ searchQueries, llmCount: llmArtists.length, webCount: webArtists.length }, 'DJ pick-next: final search queries for NCM');

      // ── Phase 3: search NCM, collect up to SEARCH_RESULT_SIZE candidates ─
      const searchedTracks = await searchCandidates(
        searchQueries,
        ncmClient,
        excludeIds,
        candidateMix.searchResultSize,
        signal,
        excludeState.dedupeKeys
      );
      if (signal?.aborted) return;

      const { allCandidates, phase3Debug } = createLegacyCandidatePool({
        likedSample,
        searchedTracks,
        preferSearchCandidates: candidateMix.preferSearchCandidates,
        sqRawSay,
        searchQueries,
        excludeState
      });

      logger.info(
        {
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedSampleCount: likedSample.length,
          searchedCount: searchedTracks.length,
          totalCandidates: allCandidates.length,
          currentQueueCount: getQueue(userId).length,
          recentPlayCount: recentPlays.length
        },
        'DJ pick-next: requesting LLM song pick'
      );

      // ── Phase 4: LLM picks 2 from combined candidates (raw call, no schema) ──
      const candidateList = allCandidates
        .map((t, i) => `${i + 1}. id=${t.id} ${t.name ?? t.id} — ${t.artist ?? '未知艺人'}`)
        .join('\n');
      const { systemPrompt: pickSystemPrompt, userPrompt: pickUserPrompt } = buildLegacyPickPrompt({
        djPersona: corpus.djPersona,
        dailyTheme,
        activeDirective,
        tasteHints,
        discoveryMode,
        modePrompt,
        timeContext,
        localTime,
        weatherText,
        candidateList,
        candidateCount: allCandidates.length,
        targetPickCount
      });

      let pickSay = '';
      let pickedTracks: Track[] = [];
      let pickReasonsById: Record<string, string> = {};
      const pickAbort = createAbortTimeoutSignal(signal, PICK_LLM_TIMEOUT_MS);
      try {
        const pickResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: pickSystemPrompt },
            { role: 'user', content: pickUserPrompt }
          ],
          { signal: pickAbort.signal }
        );
        const parsedPicks = parseDjCandidatePicks(pickResp.content, allCandidates, targetPickCount);
        pickSay = parsedPicks.say;
        pickedTracks = parsedPicks.tracks;
        pickReasonsById = parsedPicks.reasonsById;
        if (pickedTracks.length === 0) {
          logger.warn({ raw: pickResp.content.slice(0, 300) }, 'DJ pick-next: failed to extract whitelisted picks from LLM response');
        }
      } catch (err) {
        if (signal?.aborted) return;
        logger.warn(
          { err, fallbackPath: 'legacy_random_fallback', fallbackStats: djPickNextFallbackStats.snapshot() },
          'DJ pick-next: LLM pick failed, using random fallback'
        );
      } finally {
        pickAbort.cleanup();
      }
      if (signal?.aborted) return;

      if (pickedTracks.length > 0) {
        logger.info(
          { pickedIds: pickedTracks.map((track) => track.id), say: pickSay.slice(0, 80) },
          'DJ pick-next: LLM returned whitelisted candidate picks'
        );
        const pickedDetailMap = new Map(
          (await withTimeout(
            ncmClient.getSongDetails(pickedTracks.map((track) => track.id)).catch(() => []),
            LIKED_DETAILS_TIMEOUT_MS,
            []
        )).map((track) => [String(track.id), track])
        );
        if (signal?.aborted) return;
        const excludeState = getTodayAndQueueDedupeState(userId);
        const legacyPickResult = handleLegacyPickNextOutput({
          userId,
          pickedTracks,
          pickedDetailMap,
          pickSay,
          pickReasonsById,
          phase3Debug,
          excludeState,
          initialQueueLength,
          targetPickCount,
          startedAt,
          discoveryMode,
          legacyFallbackPath,
          djEventContext,
          emit,
          broadcastAppended,
          logger,
          markDebugBroadcastSent: () => {
            debugBroadcastSent = true;
          },
          setPickReason: (trackId, reason) => djPickReasonCache.set(trackId, reason),
          fallbackStatsSnapshot: () => djPickNextFallbackStats.snapshot(),
          searchedCount: searchedTracks.length,
          totalCandidates: allCandidates.length,
          searchQueries
        });
        debugBroadcastSent = legacyPickResult.debugBroadcastSent;
        if (legacyPickResult.status === 'handled') {
          return;
        }
      } else {
        logger.warn(
          { fallbackPath: 'legacy_random_fallback', fallbackStats: djPickNextFallbackStats.snapshot() },
          'DJ pick-next: LLM returned no usable whitelisted picks, using random fallback'
        );
      }

      // Phase 4 failed — still broadcast Phase 3 data so the debug panel reflects what was searched
      emit({ type: 'dj.debug', ...phase3Debug, selectedSay: '选歌失败，使用随机降级' });
      debugBroadcastSent = true;
    } catch (err) {
      logger.warn(
        {
          err: serializeDjPickNextErrorForLog(err),
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedIdCount: allLikedIds.length,
          currentQueueCount: getQueue(userId).length,
          fallbackPath: 'legacy_random_fallback',
          fallbackStats: djPickNextFallbackStats.snapshot()
        },
        'DJ pick-next: LLM pipeline failed, using random fallback'
      );
    }
  }

  await handleLegacyRandomFallback({
    userId,
    allLikedIds,
    excludeState: getTodayAndQueueDedupeState(userId),
    initialQueueLength,
    targetPickCount,
    startedAt,
    discoveryMode,
    debugBroadcastSent,
    djEventContext,
    emit,
    broadcastAppended,
    logger,
    recordFallbackStats: djPickNextTelemetry.recordFallbackStats,
    sampleIds: sampleN,
    fetchSongDetails: (ids) => withTimeout(
      ncmClient.getSongDetails(ids).catch(() => []),
      LIKED_DETAILS_TIMEOUT_MS,
      []
    ),
    signal
  });
}

export function serializeDjPickNextErrorForLog(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const payload: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  const errorWithDetails = error as Error & {
    status?: unknown;
    statusText?: unknown;
    responseBody?: unknown;
    cause?: unknown;
  };

  if (typeof errorWithDetails.status === 'number') {
    payload.status = errorWithDetails.status;
  }
  if (typeof errorWithDetails.statusText === 'string' && errorWithDetails.statusText.length > 0) {
    payload.statusText = errorWithDetails.statusText;
  }
  if (typeof errorWithDetails.responseBody === 'string' && errorWithDetails.responseBody.length > 0) {
    payload.responseBody = errorWithDetails.responseBody;
  }
  if (errorWithDetails.cause instanceof Error) {
    payload.cause = {
      name: errorWithDetails.cause.name,
      message: errorWithDetails.cause.message
    };
  } else if (errorWithDetails.cause !== undefined) {
    payload.cause = String(errorWithDetails.cause);
  }

  return payload;
}

function getTodayAndQueueDedupeState(userId: string): DedupeState {
  const temporaryBans = getActiveTemporaryQueueBanDedupeState(userId);
  const ids = new Set([...getTodayPlayedSongIds(userId), ...temporaryBans.ids]);
  const dedupeKeys = new Set<string>();
  for (const key of temporaryBans.dedupeKeys) {
    dedupeKeys.add(key);
  }

  for (const play of getTodayPlays(userId)) {
    const key = buildTrackDedupeKey({
      id: play.song_id,
      name: play.song_name,
      artist: play.artist_name
    });
    if (key) dedupeKeys.add(key);
  }

  for (const track of getQueue(userId)) {
    ids.add(track.ncmId);
    const key = buildTrackDedupeKey({
      id: track.ncmId,
      name: track.name,
      artists: track.artists
    });
    if (key) dedupeKeys.add(key);
  }

  return { ids, dedupeKeys };
}

function getActiveQueueDirective(userId: string, now = new Date()): string {
  const directive = getPref<QueueActiveDirective>(userId, 'queue.activeDirective');
  if (!directive || typeof directive.text !== 'string' || typeof directive.expiresAt !== 'string') {
    return '';
  }
  const expiresAtMs = Date.parse(directive.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return '';
  }
  return directive.text.trim();
}

function buildDirectiveSearchQueries(directive: string): string[] {
  if (/女声|女歌手|女性|女vocal|female/i.test(directive)) {
    return ['女声', '女歌手', '粤语 女声', 'female vocalist'];
  }
  return [];
}
