import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import type { Track } from '../../agent/schema.js';
import { LlmClient } from '../../llm/client.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { getRecentPlays, getTodayPlayedSongIds, getTodayPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { getRecentSegues } from '../../store/segues.js';
import { getPreferenceContext } from '../../store/chat-preferences.js';
import { fetchWeather } from '../../weather.js';
import { searchArtistsForStyle } from '../../web-search.js';
import { getQueue, addToQueue, setQueueState } from '../../store/queue.js';
import { getPref } from '../../store/prefs.js';
import { getActiveTemporaryQueueBanDedupeState } from '../../store/temporary-bans.js';
import { broadcastToUser } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { initSseRes, writeSseEvent, endSse } from '../sse.js';
import { getOrGenerateDailyThemeWithin } from '../../daily-theme.js';
import { MusicAgent } from '../../music-agent/index.js';
import type { MusicAgentRunOutput } from '../../music-agent/schema.js';
import { buildMusicTrackDedupeKey, isMusicTrackDedupeKeyExcluded } from '../../music-agent/dedupe.js';
import { formatShanghaiLocalTime, getDaypart, getShanghaiTimeParts } from '../../timezone.js';
import { parseAutoFillBatchSize } from '../../../shared/dj.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };
export type DiscoveryMode = 'explore' | 'comfort';

export type DjPickNextFallbackPath =
  | 'music_agent_success'
  | 'music_agent_ranked_fallback'
  | 'music_agent_legacy_fallback'
  | 'legacy_llm_success'
  | 'legacy_random_fallback'
  | 'no_candidates';

export type DjPickNextFallbackStats = {
  totalRuns: number;
  fallbackRuns: number;
  fallbackRate: number;
  fallbackPaths: Partial<Record<DjPickNextFallbackPath, number>>;
};

export type DjPickNextFallbackStatsTracker = {
  record(event: { path: DjPickNextFallbackPath }): DjPickNextFallbackStats;
  snapshot(): DjPickNextFallbackStats;
};

type DjNextOptions = {
  secrets: any;
  ncmClient?: NcmClient;
};

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

const isRunning = new Map<string, boolean>();
const djPickNextFallbackStats = createDjPickNextFallbackStatsTracker();
type DjEventSink = (payload: Record<string, unknown>) => void;

type DjPickNextRunMetrics = {
  agentPickCount?: number;
  rankedBackfillCount?: number;
  finalPickDiagnostics?: MusicAgentRunOutput['finalPickDiagnostics'];
  queryFunnel?: MusicAgentRunOutput['queryFunnel'];
  candidateCount?: number;
  nonLikedCandidateCount?: number;
  candidateSourceCounts?: Record<string, number>;
  elapsedMs?: number;
  fallbackPath?: DjPickNextFallbackPath;
  discoveryMode?: DiscoveryMode;
};

type LikedIdsCache = { ids: string[]; fetchedAt: number };
const likedIdsCache = new Map<string, LikedIdsCache>();

type QueueActiveDirective = {
  text: string;
  expiresAt: string;
};

const pickNextBodySchema = z.object({
  queue: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      artists: z.array(z.string()).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      coverImgUrl: z.string().nullable().optional()
    })
  ).optional(),
  currentIndex: z.number().int().nonnegative().optional()
}).optional();

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
  return getPref<DiscoveryMode>(userId, 'discovery.mode') === 'comfort' ? 'comfort' : 'explore';
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
  return mode === 'comfort'
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

function getAddedTrackCount(userId: string, initialQueueLength: number): number {
  return Math.max(0, getQueue(userId).length - initialQueueLength);
}

function getRemainingPickSlots(userId: string, initialQueueLength: number, targetPickCount: number): number {
  return Math.max(0, targetPickCount - getAddedTrackCount(userId, initialQueueLength));
}

function hasReachedPickTarget(userId: string, initialQueueLength: number, targetPickCount: number): boolean {
  return getAddedTrackCount(userId, initialQueueLength) >= targetPickCount;
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

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    if (isRunning.get(userId)) {
      res.json({ ok: true, running: true });
      return;
    }
    applyClientQueueSnapshot(req, userId);
    res.json({ ok: true, running: false });
    void runPickNextJob(userId, ncmClient);
  };
}

async function runPickNextJob(userId: string, ncmClient: NcmClient): Promise<void> {
  if (isRunning.get(userId)) return;
  isRunning.set(userId, true);
  const logger = getLogger();
  const controller = new AbortController();
  const targetPickCount = getAutoFillBatchSize(userId);
  const jobTimeoutMs = getJobTimeoutMs(targetPickCount);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const jobTimer = new Promise<'timeout'>((resolve) =>
    timeoutId = setTimeout(() => {
      controller.abort(new Error('job-timeout'));
      resolve('timeout');
    }, jobTimeoutMs)
  );

  try {
    const jobResult = await Promise.race([doPickNext(userId, ncmClient, undefined, controller.signal).then(() => 'done' as const), jobTimer]);

    if (jobResult === 'timeout') {
      logger.warn('DJ pick-next job timed out after %dms', jobTimeoutMs);
      broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'timeout' });
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    isRunning.set(userId, false);
  }
}

async function doPickNext(
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

  const llmConfig = resolveLlmConfig();
  if (llmConfig && !signal?.aborted) {
    const agentAbort = createAbortTimeoutSignal(signal, getDjAgentTimeoutMs(targetPickCount));
    try {
      const agent = new MusicAgent({ llmConfig });
      const output = await agent.pickNext({
        userId,
        ncmClient,
        signal: agentAbort.signal,
        includeDailyTheme: dailyThemeEnabled,
        excludeTrackIds: excludeState.ids,
        excludeTrackDedupeKeys: excludeState.dedupeKeys,
        targetPickCount
      });
      if (signal?.aborted) return;
      if (output.status === 'aborted') {
        if (!agentAbort.timedOut()) return;
        legacyFallbackPath = 'music_agent_legacy_fallback';
        logger.warn(
          { fallbackPath: legacyFallbackPath, fallbackStats: djPickNextFallbackStats.snapshot() },
          'DJ pick-next: MusicAgent timed out, using legacy fallback'
        );
      }
      if (output.status === 'ok') {
        const pathQueueLength = getQueue(userId).length;
        const appendedPicks: typeof output.picks = [];
        const musicAgentSkippedPicks: SkippedPickLog[] = [];
        for (const pick of output.picks) {
          if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) {
            musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'no_remaining_slots', buildTrackDedupeKey(pick)));
            break;
          }
          const dedupeKey = buildTrackDedupeKey(pick);
          if (excludeState.ids.has(pick.id)) {
            musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'id_excluded', dedupeKey));
            continue;
          }
          if (isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) {
            musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'dedupe_excluded', dedupeKey));
            continue;
          }
          addToQueue(userId, {
            ncmId: pick.id,
            name: pick.name,
            artists: pick.artist ? [pick.artist] : []
          }, 'end');
          appendedPicks.push(pick);
          excludeState.ids.add(pick.id);
          if (dedupeKey) excludeState.dedupeKeys.add(dedupeKey);
        }
        if (getQueue(userId).length > pathQueueLength) {
          const pathNewTracks = getQueue(userId).slice(pathQueueLength);
          if (output.say.trim()) {
            for (const track of pathNewTracks) {
              djPickReasonCache.set(track.ncmId, output.say.trim());
            }
          }
        }
        if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {
          emit(buildMusicAgentDebugPayload({ output, appendedPicks, excludeState }));
          debugBroadcastSent = true;
          broadcastAppended(
            userId,
            initialQueueLength,
            targetPickCount,
            emit,
            getMusicAgentRoutePath(output),
            musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)
          );
          return;
        }
        const appendedCount = getQueue(userId).length - initialQueueLength;
        if (appendedCount > 0) {
          emit(buildMusicAgentDebugPayload({
            output,
            appendedPicks,
            excludeState,
            partial: true,
            targetCount: targetPickCount,
            appendedCount,
            requestedPickCount: output.picks.length,
            skippedPicks: musicAgentSkippedPicks
          }));
          debugBroadcastSent = true;
          logger.warn(
            {
              targetCount: targetPickCount,
              appendedCount,
              requestedPickCount: output.picks.length,
              skippedPicks: musicAgentSkippedPicks,
              ...getMusicAgentShortfallDiagnostics(output, appendedPicks),
              fallbackPath: getMusicAgentRoutePath(output),
              fallbackStats: djPickNextFallbackStats.snapshot()
            },
            'DJ pick-next: MusicAgent appended fewer than target'
          );
          broadcastAppended(
            userId,
            initialQueueLength,
            targetPickCount,
            emit,
            getMusicAgentRoutePath(output),
            musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)
          );
          return;
        }
        legacyFallbackPath = 'music_agent_legacy_fallback';
        logger.warn(
          {
            targetCount: targetPickCount,
            appendedCount,
            requestedPickCount: output.picks.length,
            skippedPicks: musicAgentSkippedPicks,
            fallbackPath: legacyFallbackPath,
            fallbackStats: djPickNextFallbackStats.snapshot()
          },
          'DJ pick-next: MusicAgent picks did not change queue, using legacy fallback'
        );
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
      const candidateIds = allLikedIds.filter((id) => !excludeIds.has(id));
      const sampledIds = sampleN(candidateIds, candidateMix.likedSampleSize);
      const sampledDetails = await withTimeout(
        ncmClient.getSongDetails(sampledIds).catch(() => []),
        LIKED_DETAILS_TIMEOUT_MS,
        []
      );
      const likedSample: Track[] = sampledDetails
        .filter((t) => t.artists.length > 0)
        .map((t) => ({
          id: String(t.id),
          name: t.name,
          artist: t.artists.join(' / ') || undefined
        }))
        .filter((track) => !isTrackDedupeKeyExcluded(buildTrackDedupeKey(track), excludeState.dedupeKeys));

      logger.info(
        {
          totalLikedIds: allLikedIds.length,
          candidateCount: candidateIds.length,
          likedSampleTarget: candidateMix.likedSampleSize,
          sampledCount: likedSample.length
        },
        'DJ pick-next: sampled liked tracks from full list'
      );

      // ── Phase 2: LLM suggests styles + artists → Wikipedia enrichment → NCM search queries ─
      const recentPlayNames = recentPlays
        .slice(0, 10)
        .map((p) => `${p.song_name ?? '?'} — ${p.artist_name ?? '?'}`)
        .join('\n');
      const weatherStr = weather ? `${weather.tempC}°C，${weather.desc}` : '未知';
      // Resolve daily theme — either cached or freshly generated
      const dailyTheme = await dailyThemePromise;
      if (signal?.aborted) return;
      const themeContext = dailyTheme
        ? `\n今日主题：${dailyTheme.theme}\n主题关键词：${dailyTheme.keywords.join('、')}\n`
        : '';

      const stylePrompt =
        `当前时间：${localTime}\n时间约束：${timeContext.contextInstruction}\n天气：${weatherStr}\n最近播放：\n${recentPlayNames}\n` +
        themeContext +
        tasteContext +
        `\n${modePrompt.styleInstruction}` +
        `对每个风格，列出 3-5 位可以在网易云音乐搜到的代表艺人（华人艺人和海外艺人各半，保证多样性）。` +
        `style 字段用英文关键词方便检索，artists 里同时包含中外艺人。` +
        `直接返回 JSON 对象，格式如下：\n` +
        `{"styles":[{"style":"indie folk","artists":["万能青年旅店","Bon Iver","张玮玮","Sufjan Stevens"]},` +
        `{"style":"jazz piano","artists":["Bill Evans","上原广美","Keith Jarrett","罗宁"]}]}`;

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
        const cleaned = sqResp.content
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed: unknown = JSON.parse(match[0]);
          if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            const styles = Array.isArray(obj.styles) ? obj.styles : [];
            const seen = new Set<string>();
            for (const s of styles) {
              if (!s || typeof s !== 'object') continue;
              const style = s as Record<string, unknown>;
              if (typeof style.style === 'string' && style.style.trim()) {
                styleConcepts.push(style.style.trim());
              }
              const artists = Array.isArray(style.artists) ? style.artists : [];
              for (const a of artists) {
                if (typeof a === 'string' && a.trim() && a.trim().length < 50) {
                  const lower = a.trim().toLowerCase();
                  if (!seen.has(lower)) {
                    seen.add(lower);
                    llmArtists.push(a.trim());
                  }
                }
              }
            }
          }
        }
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
      let webArtists: string[] = [];
      if (styleConcepts.length > 0) {
        const allWebArtists = new Set<string>();
        const webResults = await Promise.all(
          styleConcepts.map((style) =>
            searchArtistsForStyle(style).catch(() => [] as string[])
          )
        );
        for (const artists of webResults) {
          for (const name of artists) {
            const lower = name.toLowerCase();
            if (!allWebArtists.has(lower)) {
              allWebArtists.add(lower);
              webArtists.push(name);
            }
          }
        }
        logger.info({ webArtistCount: webArtists.length }, 'DJ pick-next: Wikipedia found additional artists');
      }

      // Merge: LLM artists first (up to 6), then web discoveries (up to 4), cap at 10
      const QUERY_CAP = 10;
      const LLM_QUOTA = 6;
      const mergedQueries = new Set<string>();
      const searchQueries: string[] = [];
      for (const a of llmArtists) {
        const lower = a.toLowerCase();
        if (!mergedQueries.has(lower) && searchQueries.length < LLM_QUOTA) {
          mergedQueries.add(lower);
          searchQueries.push(a);
        }
      }
      for (const a of webArtists) {
        const lower = a.toLowerCase();
        if (!mergedQueries.has(lower) && searchQueries.length < QUERY_CAP) {
          mergedQueries.add(lower);
          searchQueries.push(a);
        }
      }
      // Mix 1-2 daily theme keywords into search queries (probabilistic, ~50% per keyword)
      if (dailyTheme && dailyTheme.keywords.length > 0 && searchQueries.length < QUERY_CAP) {
        const themeCandidates = dailyTheme.keywords.filter(
          (k) => !mergedQueries.has(k.toLowerCase())
        );
        let themeAdded = 0;
        const THEME_QUOTA = 2;
        for (const k of themeCandidates) {
          if (searchQueries.length >= QUERY_CAP || themeAdded >= THEME_QUOTA) break;
          if (Math.random() < 0.5) {
            mergedQueries.add(k.toLowerCase());
            searchQueries.push(k);
            themeAdded++;
          }
        }
        if (themeAdded > 0) {
          logger.info({ themeKeywordsAdded: themeAdded }, 'DJ pick-next: mixed daily theme keywords into search queries');
        }
      }

      if (activeDirective) {
        const directiveQueries = buildDirectiveSearchQueries(activeDirective);
        for (const query of [...directiveQueries].reverse()) {
          const lower = query.toLowerCase();
          if (!mergedQueries.has(lower)) {
            mergedQueries.add(lower);
            searchQueries.unshift(query);
            if (searchQueries.length > QUERY_CAP) {
              const removed = searchQueries.pop();
              if (removed) mergedQueries.delete(removed.toLowerCase());
            }
          }
        }
      }


      // Fallback: if we don't have enough search queries, use style keywords directly
      if (searchQueries.length < 2 && styleConcepts.length > 0) {
        logger.warn({ searchQueries, styleConcepts }, 'DJ pick-next: too few artist names, falling back to style keywords');
        searchQueries.length = 0;
        searchQueries.push(...styleConcepts.slice(0, 3));
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

      // Combine candidates, deduplicate by ID. Explore mode lists search results first
      // so red-heart tracks are a smaller, lower-priority part of the candidate pool.
      const likedSampleIds = new Set(likedSample.map((t) => t.id));
      const searchedOnlyTracks = searchedTracks.filter((t) => !likedSampleIds.has(t.id));
      const allCandidates = candidateMix.preferSearchCandidates
        ? [...searchedOnlyTracks, ...likedSample]
        : [...likedSample, ...searchedOnlyTracks];

      // Snapshot Phase 3 data for the debug broadcast — always emitted regardless of Phase 4 outcome
      const phase3Debug = {
        likedSample: likedSample.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
        sqRaw: sqRawSay,
        searchQueries,
        searchedTracks: searchedTracks.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
        excludedIds: Array.from(excludeState.ids),
        excludedDedupeKeys: Array.from(excludeState.dedupeKeys),
        totalCandidates: allCandidates.length,
        candidateScoreTable: createLegacyCandidateScoreTable(allCandidates, likedSampleIds)
      };

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
      const weatherStr2 = weather ? `${weather.tempC}°C，${weather.desc}` : '未知';

      const themePickNote = dailyTheme
        ? `\n## 今日主题\n${dailyTheme.theme}\n\n选曲时可以优先考虑契合今日主题氛围的歌曲，但不必强求。主题只是参考方向。\n`
        : '';

      const pickSystemPrompt = `${corpus.djPersona || 'You are a DJ.'}

## 当前任务：DJ 自动选曲
${themePickNote}
${activeDirective ? `## 必须优先遵循的短期选歌指令\n${activeDirective}\n\n如果候选池里有符合该指令的歌曲，应优先选择；只有候选池明显不足时才放宽。\n\n` : ''}${tasteHints.length > 0 ? `## ${discoveryMode === 'comfort' ? '用户品味偏好' : '探索外延参考'}\n${tasteHints.join('\n')}\n\n${modePrompt.pickInstruction}\n\n` : ''}${tasteHints.length === 0 ? modePrompt.pickInstruction : ''}
不要重复最近刚播过的歌曲。say 字段用一句话中文说明选曲理由。
${timeContext.sayInstruction}
优先选择艺人名像真实人名或乐队的歌曲，避开艺人名明显是厂牌、合集、影视原声、或自动生成的选项（如"群星""Various Artists""佚名""原声带"等）。
只能返回候选歌曲列表中真实存在的 id，不要编造 id，不要返回歌名搜索词。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "say": "选曲理由（一句话中文）",
  "picks": [
    { "id": "候选歌曲id1", "reason": "为什么这首歌适合当前时段/主题/用户品味（一句话中文）" },
    { "id": "候选歌曲id2", "reason": "为什么这首歌适合当前时段/主题/用户品味（一句话中文）" }
  ]
}`;

      const themeContextUser = dailyTheme
        ? `今日主题：${dailyTheme.theme}\n`
        : '';

      const tasteUserContext = modePrompt.userContextLabel;
      const directiveUserContext = activeDirective
        ? `短期选歌指令：${activeDirective}\n`
        : '';

      const pickUserPrompt = `<context>
当前时间：${localTime}
天气：${weatherStr2}
模式：${discoveryMode === 'comfort' ? '舒适区模式' : '探索模式'}
${themeContextUser}${directiveUserContext}${tasteUserContext}</context>

<候选歌曲列表>
${candidateList}
</候选歌曲列表>

从以上 ${allCandidates.length} 首候选歌曲中挑选最多 ${targetPickCount} 首；如果高质量候选不足，可以少选，不要为了凑数选择明显不适合的歌曲。`;

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
        const pathQueueLength = getQueue(userId).length;
        const excludeState = getTodayAndQueueDedupeState(userId);
        const whitelistedSkippedPicks: SkippedPickLog[] = [];
        const appendedWhitelistedTracks: Track[] = [];
        for (const track of pickedTracks) {
          if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) {
            whitelistedSkippedPicks.push(createSkippedPickLog(track, 'no_remaining_slots', buildTrackDedupeKey(track)));
            break;
          }
          const dedupeKey = buildTrackDedupeKey(track);
          if (excludeState.ids.has(track.id)) {
            whitelistedSkippedPicks.push(createSkippedPickLog(track, 'id_excluded', dedupeKey));
            continue;
          }
          if (isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) {
            whitelistedSkippedPicks.push(createSkippedPickLog(track, 'dedupe_excluded', dedupeKey));
            continue;
          }
          const detail = pickedDetailMap.get(track.id);
          const appendedTrack = {
            id: track.id,
            name: detail?.name ?? track.name,
            artist: detail?.artists?.join(' / ') || track.artist
          };
          addToQueue(userId, {
            ncmId: appendedTrack.id,
            name: appendedTrack.name,
            artists: detail?.artists ?? (track.artist ? track.artist.split(' / ').filter(Boolean) : []),
            coverImgUrl: detail?.coverImgUrl
          }, 'end');
          appendedWhitelistedTracks.push(appendedTrack);
          excludeState.ids.add(track.id);
          excludeState.dedupeKeys.add(dedupeKey);
        }
        if (getQueue(userId).length > pathQueueLength) {
          const pathNewTracks = getQueue(userId).slice(pathQueueLength);
          for (const track of pathNewTracks) {
            const trackReason = pickReasonsById[track.ncmId]?.trim() || pickSay.trim();
            if (trackReason) djPickReasonCache.set(track.ncmId, trackReason);
          }
        }
        if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {
          emit(buildLegacyDebugPayload({
            phase3Debug,
            selectedTracks: createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById),
            selectedSay: pickSay,
            targetCount: targetPickCount,
            appendedCount: getQueue(userId).length - initialQueueLength,
            pickedCount: pickedTracks.length,
            skippedPicks: whitelistedSkippedPicks
          }));
          debugBroadcastSent = true;
          broadcastAppended(
            userId,
            initialQueueLength,
            targetPickCount,
            emit,
            legacyFallbackPath ?? 'legacy_llm_success',
            {
              agentPickCount: pickedTracks.length,
              rankedBackfillCount: 0,
              candidateCount: allCandidates.length,
              elapsedMs: Date.now() - startedAt,
              discoveryMode
            }
          );
          return;
        }
        const appendedCount = getQueue(userId).length - initialQueueLength;
        if (appendedCount > 0) {
          emit(buildLegacyDebugPayload({
            phase3Debug,
            selectedTracks: createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById),
            selectedSay: pickSay,
            partial: true,
            targetCount: targetPickCount,
            appendedCount,
            pickedCount: pickedTracks.length,
            skippedPicks: whitelistedSkippedPicks
          }));
          debugBroadcastSent = true;
          logger.warn(
            {
              targetCount: targetPickCount,
              appendedCount,
              pickedCount: pickedTracks.length,
              skippedPicks: whitelistedSkippedPicks,
              selectedTracks: createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById),
              selectedSay: pickSay,
              searchedCount: searchedTracks.length,
              totalCandidates: allCandidates.length,
              searchQueries,
              fallbackPath: 'legacy_llm_success',
              fallbackStats: djPickNextFallbackStats.snapshot()
            },
            'DJ pick-next: whitelisted picks appended fewer than target'
          );
          broadcastAppended(
            userId,
            initialQueueLength,
            targetPickCount,
            emit,
            legacyFallbackPath ?? 'legacy_llm_success',
            {
              agentPickCount: pickedTracks.length,
              rankedBackfillCount: 0,
              candidateCount: allCandidates.length,
              elapsedMs: Date.now() - startedAt,
              discoveryMode
            }
          );
          return;
        }
        logger.warn(
          {
            targetCount: targetPickCount,
            appendedCount,
            pickedCount: pickedTracks.length,
            skippedPicks: whitelistedSkippedPicks,
            fallbackPath: 'legacy_random_fallback',
            fallbackStats: djPickNextFallbackStats.snapshot()
          },
          'DJ pick-next: whitelisted picks did not change queue, using random fallback'
        );
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

  // Random fallback: sample 2 IDs from full liked list, then fetch details
  const fallbackExcludeState = getTodayAndQueueDedupeState(userId);
  const fallbackIds = allLikedIds.filter((id) => !fallbackExcludeState.ids.has(id));

  if (fallbackIds.length === 0) {
    const appendedCount = getAddedTrackCount(userId, initialQueueLength);
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        fallbackStats: recordDjPickNextFallbackStats('no_candidates')
      },
      'DJ pick-next fallback: no candidates'
    );
    if (appendedCount > 0) {
      broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: fallbackIds.length,
        elapsedMs: Date.now() - startedAt,
        fallbackPath: 'no_candidates',
        discoveryMode
      });
    } else {
      emit({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    }
    return;
  }

  if (!debugBroadcastSent) {
    emit({
      type: 'dj.debug',
      likedSample: [],
      sqRaw: '',
      searchQueries: [],
      searchedTracks: [],
      excludedIds: Array.from(fallbackExcludeState.ids),
      excludedDedupeKeys: Array.from(fallbackExcludeState.dedupeKeys),
      totalCandidates: fallbackIds.length,
      selectedSay: '随机 fallback（LLM 未配置或选歌失败）'
    });
  }

  const fallbackSampleSize = Math.min(
    Math.max(targetPickCount, getRemainingPickSlots(userId, initialQueueLength, targetPickCount) * 4),
    fallbackIds.length
  );
  const pickedIds = sampleN(fallbackIds, fallbackSampleSize);
  const pickedDetails = (await withTimeout(
    ncmClient.getSongDetails(pickedIds).catch(() => []),
    LIKED_DETAILS_TIMEOUT_MS,
    []
  )).filter((t) => {
    if (t.artists.length === 0) return false;
    return !isTrackDedupeKeyExcluded(buildTrackDedupeKey({
      id: String(t.id),
      name: t.name,
      artist: t.artists.join(' / ')
    }), fallbackExcludeState.dedupeKeys);
  });
  if (signal?.aborted) return;

  if (pickedDetails.length === 0) {
    const appendedCount = getQueue(userId).length - initialQueueLength;
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        fallbackStats: recordDjPickNextFallbackStats('legacy_random_fallback')
      },
      'DJ pick-next fallback: failed to fetch track details'
    );
    if (appendedCount > 0) {
      broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: fallbackIds.length,
        elapsedMs: Date.now() - startedAt,
        fallbackPath: 'legacy_random_fallback',
        discoveryMode
      });
    } else {
      emit({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    }
    return;
  }

  const pathQueueLength = getQueue(userId).length;
  for (const pick of pickedDetails) {
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) break;
    const dedupeKey = buildTrackDedupeKey({
      id: String(pick.id),
      name: pick.name,
      artists: pick.artists
    });
    if (isTrackDedupeKeyExcluded(dedupeKey, fallbackExcludeState.dedupeKeys)) continue;
    addToQueue(userId, {
      ncmId: String(pick.id),
      name: pick.name,
      artists: pick.artists,
      coverImgUrl: pick.coverImgUrl
    }, 'end');
    fallbackExcludeState.ids.add(String(pick.id));
    if (dedupeKey) fallbackExcludeState.dedupeKeys.add(dedupeKey);
  }
  logger.info(
    {
      targetCount: targetPickCount,
      appendedCount: getQueue(userId).length - initialQueueLength,
      fallbackAppendedCount: getQueue(userId).length - pathQueueLength,
      sampledCount: pickedIds.length,
      fallbackStats: recordDjPickNextFallbackStats('legacy_random_fallback')
    },
    'DJ pick-next fallback: appended tracks'
  );
  broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
    agentPickCount: 0,
    rankedBackfillCount: 0,
    candidateCount: fallbackIds.length,
    elapsedMs: Date.now() - startedAt,
    fallbackPath: 'legacy_random_fallback',
    discoveryMode
  });
}

function getMusicAgentDebugCandidateCount(output: MusicAgentRunOutput): number {
  return Math.max(output.picks.length, ...output.trace.map((step) => step.candidateCount));
}

export function getMusicAgentCandidateSourceDiagnostics(
  output: Pick<MusicAgentRunOutput, 'candidateScoreTable'>
): { nonLikedCandidateCount: number; candidateSourceCounts: Record<string, number> } {
  const candidateSourceCounts: Record<string, number> = {};
  let nonLikedCandidateCount = 0;

  for (const row of output.candidateScoreTable) {
    const sources = row.sources
      .split(',')
      .map((source) => source.trim())
      .filter(Boolean);
    if (sources.some((source) => source !== 'liked')) {
      nonLikedCandidateCount += 1;
    }
    for (const source of sources) {
      candidateSourceCounts[source] = (candidateSourceCounts[source] ?? 0) + 1;
    }
  }

  return { nonLikedCandidateCount, candidateSourceCounts };
}

function buildMusicAgentDebugPayload(input: {
  output: MusicAgentRunOutput;
  appendedPicks: MusicAgentRunOutput['picks'];
  excludeState: DedupeState;
  partial?: boolean;
  targetCount?: number;
  appendedCount?: number;
  requestedPickCount?: number;
  skippedPicks?: SkippedPickLog[];
}): Record<string, unknown> {
  const { output, appendedPicks, excludeState } = input;
  const candidateSourceDiagnostics = getMusicAgentCandidateSourceDiagnostics(output);

  return {
    type: 'dj.debug',
    likedSample: [],
    sqRaw: JSON.stringify(output.trace),
    searchQueries: output.queryFunnel.map((entry) => entry.query),
    queryFunnel: output.queryFunnel,
    searchedTracks: output.picks.map((pick) => ({
      id: pick.id,
      name: pick.name,
      artist: pick.artist
    })),
    selectedTracks: createMusicAgentSelectedTrackDebug(appendedPicks),
    excludedIds: Array.from(excludeState.ids),
    excludedDedupeKeys: Array.from(excludeState.dedupeKeys),
    totalCandidates: getMusicAgentDebugCandidateCount(output),
    ...candidateSourceDiagnostics,
    candidateScoreTable: output.candidateScoreTable,
    selectedSay: output.say,
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
    ...(input.appendedCount !== undefined ? { appendedCount: input.appendedCount } : {}),
    ...(input.requestedPickCount !== undefined ? { requestedPickCount: input.requestedPickCount } : {}),
    ...(input.skippedPicks !== undefined ? { skippedPicks: input.skippedPicks } : {})
  };
}

function createMusicAgentSelectedTrackDebug(
  picks: MusicAgentRunOutput['picks']
): Array<{ id: string; name: string; artist: string; reason: string; source: string }> {
  return picks.map((pick) => ({
    id: pick.id,
    name: pick.name ?? pick.id,
    artist: pick.artist ?? '未知艺人',
    reason: pick.reason,
    source: pick.source
  }));
}

function getMusicAgentShortfallDiagnostics(
  output: MusicAgentRunOutput,
  appendedPicks: MusicAgentRunOutput['picks']
): Record<string, unknown> {
  return {
    selectedTracks: createMusicAgentSelectedTrackDebug(appendedPicks),
    selectedSay: output.say,
    rejected: output.rejected,
    finalPickDiagnostics: output.finalPickDiagnostics,
    queryFunnel: output.queryFunnel,
    traceLastSteps: output.trace.slice(-3),
    candidateScoreTableCount: output.candidateScoreTable.length,
    candidateScoreTablePreview: output.candidateScoreTable.slice(0, 20),
    ...getMusicAgentCandidateSourceDiagnostics(output)
  };
}

function buildLegacyDebugPayload(input: {
  phase3Debug: Record<string, unknown>;
  selectedTracks: Array<{ id: string; name: string; artist: string; reason: string; source: string }>;
  selectedSay: string;
  partial?: boolean;
  targetCount?: number;
  appendedCount?: number;
  pickedCount?: number;
  skippedPicks?: SkippedPickLog[];
}): Record<string, unknown> {
  return {
    type: 'dj.debug',
    ...input.phase3Debug,
    selectedTracks: input.selectedTracks,
    selectedSay: input.selectedSay,
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
    ...(input.appendedCount !== undefined ? { appendedCount: input.appendedCount } : {}),
    ...(input.pickedCount !== undefined ? { pickedCount: input.pickedCount } : {}),
    ...(input.skippedPicks !== undefined ? { skippedPicks: input.skippedPicks } : {})
  };
}

function createLegacyCandidateScoreTable(candidates: Track[], likedSampleIds: Set<string>): Array<{
  rank: number;
  id: string;
  song: string;
  artist: string;
  sources: string;
  baseScore: number;
  artistPenalty: number;
  trackPenalty: number;
  repeatPenalty: number;
  qualityPenalty: number;
  titlePollutionPenalty: number;
  adjustedScore: number;
}> {
  const denominator = Math.max(1, candidates.length - 1);
  return candidates.map((track, index) => {
    const rankScore = candidates.length === 1 ? 1 : 1 - (index / denominator);
    const score = Number(rankScore.toFixed(4));
    return {
      rank: index + 1,
      id: track.id,
      song: track.name ?? track.id,
      artist: track.artist ?? '未知艺人',
      sources: likedSampleIds.has(track.id) ? 'liked' : 'search',
      baseScore: score,
      artistPenalty: 0,
      trackPenalty: 0,
      repeatPenalty: 0,
      qualityPenalty: 0,
      titlePollutionPenalty: 0,
      adjustedScore: score
    };
  });
}

function createLegacySelectedTrackDebug(
  tracks: Track[],
  pickSay: string,
  reasonsById: Record<string, string> = {}
): Array<{ id: string; name: string; artist: string; reason: string; source: string }> {
  const reason = pickSay.trim() || 'legacy LLM pick';
  return tracks.map((track) => ({
    id: track.id,
    name: track.name ?? track.id,
    artist: track.artist ?? '未知艺人',
    reason: reasonsById[track.id]?.trim() || reason,
    source: 'legacy_llm'
  }));
}

function getMusicAgentRoutePath(output: MusicAgentRunOutput): DjPickNextFallbackPath {
  return output.picks.some((pick) => pick.reason === 'ranked fallback')
    ? 'music_agent_ranked_fallback'
    : 'music_agent_success';
}

export function createDjPickNextFallbackStatsTracker(): DjPickNextFallbackStatsTracker {
  const stats: DjPickNextFallbackStats = {
    totalRuns: 0,
    fallbackRuns: 0,
    fallbackRate: 0,
    fallbackPaths: {}
  };

  return {
    record(event) {
      stats.totalRuns += 1;
      if (isDjPickNextFallbackPath(event.path)) {
        stats.fallbackRuns += 1;
        stats.fallbackPaths[event.path] = (stats.fallbackPaths[event.path] ?? 0) + 1;
      }
      stats.fallbackRate = roundRate(stats.fallbackRuns / stats.totalRuns);
      return cloneDjPickNextFallbackStats(stats);
    },
    snapshot() {
      return cloneDjPickNextFallbackStats(stats);
    }
  };
}

function recordDjPickNextFallbackStats(path: DjPickNextFallbackPath): DjPickNextFallbackStats {
  return djPickNextFallbackStats.record({ path });
}

function cloneDjPickNextFallbackStats(stats: DjPickNextFallbackStats): DjPickNextFallbackStats {
  return {
    ...stats,
    fallbackPaths: { ...stats.fallbackPaths }
  };
}

function isDjPickNextFallbackPath(path: DjPickNextFallbackPath): boolean {
  return path !== 'music_agent_success' && path !== 'legacy_llm_success';
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function broadcastAppended(
  userId: string,
  prevQueueLength: number,
  targetPickCount: number,
  emit: DjEventSink,
  path?: DjPickNextFallbackPath,
  metrics: DjPickNextRunMetrics = {}
): void {
  const q = getQueue(userId);
  const newTracks = q.slice(prevQueueLength);
  for (const track of newTracks) {
    emit({ type: 'queue-appended', track });
  }
  const names = newTracks.map((t) => t.name).filter((n): n is string => Boolean(n));
  const fallbackStats = path ? recordDjPickNextFallbackStats(path) : djPickNextFallbackStats.snapshot();
  getLogger().info(
    {
      targetCount: targetPickCount,
      appendedCount: newTracks.length,
      agentPickCount: metrics.agentPickCount,
      rankedBackfillCount: metrics.rankedBackfillCount,
      finalPickDiagnostics: metrics.finalPickDiagnostics,
      queryFunnel: metrics.queryFunnel,
      candidateCount: metrics.candidateCount,
      nonLikedCandidateCount: metrics.nonLikedCandidateCount,
      candidateSourceCounts: metrics.candidateSourceCounts,
      elapsedMs: metrics.elapsedMs,
      fallbackPath: path ?? metrics.fallbackPath,
      discoveryMode: metrics.discoveryMode,
      trackIds: newTracks.map((track) => track.ncmId),
      trackNames: names,
      fallbackStats
    },
    'DJ pick-next: broadcast appended tracks'
  );
  emit({
    type: 'dj.pick-next.done',
    added: newTracks.length > 0,
    addedCount: newTracks.length,
    targetCount: targetPickCount,
    trackIds: newTracks.map((track) => track.ncmId),
    trackNames: names,
    trackName: names.join('、') || undefined
  });
}

function musicAgentRunMetrics(
  output: MusicAgentRunOutput,
  appendedPicks: MusicAgentRunOutput['picks'],
  startedAt: number,
  discoveryMode: DiscoveryMode
): DjPickNextRunMetrics {
  return {
    agentPickCount: appendedPicks.filter((pick) => pick.reason !== 'ranked backfill').length,
    rankedBackfillCount: appendedPicks.filter((pick) => pick.reason === 'ranked backfill').length,
    finalPickDiagnostics: output.finalPickDiagnostics,
    queryFunnel: output.queryFunnel,
    candidateCount: getMusicAgentDebugCandidateCount(output),
    ...getMusicAgentCandidateSourceDiagnostics(output),
    elapsedMs: Date.now() - startedAt,
    discoveryMode
  };
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

type TrackDedupeInput = {
  id?: string | null;
  name?: string | null;
  artist?: string | null;
  artists?: string[] | null;
};

type SkippedPickReason = 'id_excluded' | 'dedupe_excluded' | 'no_remaining_slots';

type SkippedPickLog = {
  id?: string;
  name?: string;
  artist?: string;
  reason: SkippedPickReason;
  dedupeKey?: string;
};

type DedupeState = {
  ids: Set<string>;
  dedupeKeys: Set<string>;
};

export function buildTrackDedupeKey(track: TrackDedupeInput): string {
  return buildMusicTrackDedupeKey(track);
}

export function isTrackDedupeKeyExcluded(dedupeKey: string, excludedKeys: Set<string>): boolean {
  return isMusicTrackDedupeKeyExcluded(dedupeKey, excludedKeys);
}

function createSkippedPickLog(
  track: TrackDedupeInput,
  reason: SkippedPickReason,
  dedupeKey: string
): SkippedPickLog {
  const artists = track.artist ?? track.artists?.filter(Boolean).join(' / ') ?? undefined;
  return {
    id: track.id ? String(track.id) : undefined,
    name: track.name ?? undefined,
    artist: artists || undefined,
    reason,
    dedupeKey: dedupeKey || undefined
  };
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

function applyClientQueueSnapshot(req: Request, userId: string): void {
  const parsed = pickNextBodySchema.safeParse(req.body);
  if (!parsed.success || !parsed.data?.queue) return;

  setQueueState(
    userId,
    parsed.data.queue.map((track) => ({
      ncmId: track.id,
      name: track.name,
      artists: track.artists,
      durationMs: track.durationMs,
      coverImgUrl: track.coverImgUrl
    })),
    parsed.data.currentIndex ?? 0
  );
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

export function createSseDjPickNextHandler(opts: DjNextOptions) {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    initSseRes(res);
    if (isRunning.get(userId)) {
      endSse(res, 'dj.pick-next.done', { added: false, running: true, reason: 'already-running' });
      return;
    }
    applyClientQueueSnapshot(req, userId);
    const emit = (payload: Record<string, unknown>): void => {
      const type = typeof payload.type === 'string' ? payload.type : 'message';
      broadcastToUser(userId, payload);
      try { writeSseEvent(res, type, payload); } catch { /* disconnect */ }
    };
    isRunning.set(userId, true);
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));
    const targetPickCount = getAutoFillBatchSize(userId);
    const jobTimeoutMs = getJobTimeoutMs(targetPickCount);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const jobTimer = new Promise<'timeout'>((resolve) =>
      timeoutId = setTimeout(() => {
        controller.abort(new Error('job-timeout'));
        resolve('timeout');
      }, jobTimeoutMs)
    );
    void Promise.race([doPickNext(userId, ncmClient, emit, controller.signal).then(() => 'done' as const), jobTimer]).then((result) => {
      if (result === 'timeout' && !res.writableEnded) {
        endSse(res, 'dj.pick-next.done', { added: false, reason: 'timeout' });
        return;
      }
      if (!res.writableEnded) res.end();
    }).catch((err: Error) => {
      if (!res.writableEnded) endSse(res, 'dj.pick-next.done', { added: false, reason: 'error' });
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      isRunning.set(userId, false);
    });
    req.on('close', () => { if (!res.writableEnded) res.end(); });
  };
}
function getScopedNcmClient(req: Request, fallback?: NcmClient): NcmClient {
  const ncmClient = (req as Partial<AuthedRequest>).ncmClient ?? fallback;
  if (!ncmClient) {
    throw new Error('NCM client missing from request scope');
  }
  return ncmClient;
}
