import type { RequestHandler } from 'express';
import type { Action, Track } from '../../agent/schema.js';
import { LlmClient } from '../../llm/client.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { getRecentSegues } from '../../store/segues.js';
import { getPreferenceContext } from '../../store/chat-preferences.js';
import { fetchWeather } from '../../weather.js';
import { executeActions } from '../../agent/actions.js';
import { getQueue, addToQueue } from '../../store/queue.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

type DjNextOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

const JOB_TIMEOUT_MS = 180_000;
const SEARCH_QUERY_LLM_TIMEOUT_MS = 120_000;
const PICK_LLM_TIMEOUT_MS = 120_000;
const LIKED_IDS_TIMEOUT_MS = 8_000;
const LIKED_DETAILS_TIMEOUT_MS = 8_000;
const LIKED_IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const LIKED_SAMPLE_SIZE = 20;
const SEARCH_RESULT_SIZE = 20;

let isRunning = false;

type LikedIdsCache = { ids: string[]; fetchedAt: number };
let likedIdsCache: LikedIdsCache | null = null;

// trackId → short DJ selection reason, populated on each successful LLM pick
const djPickReasonCache = new Map<string, string>();

export function getDjPickReason(trackId: string): string | null {
  return djPickReasonCache.get(trackId) ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
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
  limit: number
): Promise<Track[]> {
  if (queries.length === 0) return [];
  const perQuery = Math.ceil((limit + 5) / queries.length);
  const results = await Promise.all(
    queries.map((q) => ncmClient.searchSongs(q, perQuery).catch(() => []))
  );
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const songs of results) {
    for (const song of songs) {
      const id = String(song.id);
      if (!seen.has(id) && !excludeIds.has(id)) {
        seen.add(id);
        tracks.push({ id, name: song.name, artist: song.artists.join(' / ') });
        if (tracks.length >= limit) return tracks;
      }
    }
  }
  return tracks;
}

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    res.json({ ok: true, running: isRunning });
    if (!isRunning) {
      void runPickNextJob(opts);
    }
  };
}

async function runPickNextJob(opts: DjNextOptions): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  const logger = getLogger();

  const jobTimer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), JOB_TIMEOUT_MS)
  );

  const jobResult = await Promise.race([doPickNext(opts).then(() => 'done' as const), jobTimer]);

  if (jobResult === 'timeout') {
    logger.warn('DJ pick-next job timed out after %dms', JOB_TIMEOUT_MS);
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'timeout' });
  }

  isRunning = false;
}

async function doPickNext(opts: DjNextOptions): Promise<void> {
  const logger = getLogger();
  let debugBroadcastSent = false;

  // Refresh full liked-song ID list at most once per day
  const now = Date.now();
  if (!likedIdsCache || now - likedIdsCache.fetchedAt > LIKED_IDS_CACHE_TTL_MS) {
    const freshIds = await withTimeout(
      opts.ncmClient.getLikedSongIds().catch(() => [] as string[]),
      LIKED_IDS_TIMEOUT_MS,
      [] as string[]
    );
    if (freshIds.length > 0) {
      likedIdsCache = { ids: freshIds, fetchedAt: now };
    }
  }
  const allLikedIds = likedIdsCache?.ids ?? [];

  const llmConfig = resolveLlmConfig(opts.secrets);
  if (!llmConfig) {
    logger.warn('DJ pick-next: skipping LLM pick because LLM config is missing');
  } else if (allLikedIds.length === 0) {
    logger.warn('DJ pick-next: skipping LLM pick because liked tracks are unavailable');
  }

  if (llmConfig && allLikedIds.length > 0) {
    try {
      const corpus = loadUserCorpus();
      const [weather] = await Promise.all([withTimeout(fetchWeather(), 4_000, null)]);
      const nowDate = new Date();
      const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
      const day = weekdays[nowDate.getDay()];
      const hh = String(nowDate.getHours()).padStart(2, '0');
      const mm = String(nowDate.getMinutes()).padStart(2, '0');
      const localTime = `周${day} ${hh}:${mm}`;
      const nowIso = nowDate.toISOString();
      const recentPlays = getRecentPlays(50);
      const recentChat = getRecentMessages(20, 60);
      const recentSegues = getRecentSegues(10);
      const extractedPreferences = getPreferenceContext(3);

      const recentIds = new Set(
        getRecentPlays(30)
          .map((p) => p.song_id)
          .filter((id): id is string => id !== null)
      );
      const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
      const excludeIds = new Set([...recentIds, ...currentQueueIds]);

      // ── Phase 1: sample 20 IDs from full liked list, then fetch details ──
      const candidateIds = allLikedIds.filter((id) => !excludeIds.has(id));
      const sampledIds = sampleN(candidateIds, LIKED_SAMPLE_SIZE);
      const sampledDetails = await withTimeout(
        opts.ncmClient.getSongDetails(sampledIds).catch(() => []),
        LIKED_DETAILS_TIMEOUT_MS,
        []
      );
      const likedSample: Track[] = sampledDetails.map((t) => ({
        id: String(t.id),
        name: t.name,
        artist: t.artists.join(' / ') || undefined
      }));

      logger.info(
        { totalLikedIds: allLikedIds.length, candidateCount: candidateIds.length, sampledCount: likedSample.length },
        'DJ pick-next: sampled liked tracks from full list'
      );

      // ── Phase 2: LLM generates search queries (raw call, no schema) ─────
      const recentPlayNames = recentPlays
        .slice(0, 10)
        .map((p) => `${p.song_name ?? '?'} — ${p.artist_name ?? '?'}`)
        .join('\n');
      const weatherStr = weather ? `${weather.tempC}°C，${weather.desc}` : '未知';
      const searchQueryPrompt =
        `当前时间：${localTime}\n天气：${weatherStr}\n最近播放：\n${recentPlayNames}\n\n` +
        `请根据以上信息，生成 2-3 个适合当前情境的网易云音乐搜索词（艺人名、风格关键词等）。` +
        `直接返回 JSON 数组，例如：["赵雷","民谣 安静","爵士 夜晚"]`;

      let searchQueries: string[] = [];
      let sqRawSay = '';
      try {
        const sqResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: corpus.djPersona || 'You are a DJ.' },
            { role: 'user', content: searchQueryPrompt }
          ],
          { signal: AbortSignal.timeout(SEARCH_QUERY_LLM_TIMEOUT_MS) }
        );
        sqRawSay = sqResp.content;
        const cleaned = sqResp.content
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim();
        const match = cleaned.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed: unknown = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            searchQueries = parsed
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .slice(0, 3);
          }
        }
        if (searchQueries.length === 0) {
          logger.warn({ raw: sqResp.content.slice(0, 200) }, 'DJ pick-next: failed to parse search queries from LLM response');
        }
      } catch (err) {
        logger.warn({ err }, 'DJ pick-next: search query generation failed');
      }

      logger.info({ searchQueries }, 'DJ pick-next: generated search queries');

      // ── Phase 3: search NCM, collect up to 20 candidates ─────────────────
      const searchedTracks = await searchCandidates(
        searchQueries,
        opts.ncmClient,
        excludeIds,
        SEARCH_RESULT_SIZE
      );

      // Combine 40 candidates, deduplicate by ID
      const likedSampleIds = new Set(likedSample.map((t) => t.id));
      const allCandidates = [
        ...likedSample,
        ...searchedTracks.filter((t) => !likedSampleIds.has(t.id))
      ];

      // Snapshot Phase 3 data for the debug broadcast — always emitted regardless of Phase 4 outcome
      const phase3Debug = {
        likedSample: likedSample.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
        sqRaw: sqRawSay,
        searchQueries,
        searchedTracks: searchedTracks.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
        totalCandidates: allCandidates.length
      };

      logger.info(
        {
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedSampleCount: likedSample.length,
          searchedCount: searchedTracks.length,
          totalCandidates: allCandidates.length,
          currentQueueCount: getQueue().length,
          recentPlayCount: recentPlays.length
        },
        'DJ pick-next: requesting LLM song pick'
      );

      // ── Phase 4: LLM picks 2 from combined candidates (raw call, no schema) ──
      const candidateList = allCandidates
        .map((t, i) => `${i + 1}. ${t.name ?? t.id} — ${t.artist ?? '未知艺人'}`)
        .join('\n');
      const weatherStr2 = weather ? `${weather.tempC}°C，${weather.desc}` : '未知';

      const pickSystemPrompt = `${corpus.djPersona || 'You are a DJ.'}

## 当前任务：DJ 自动选曲

从候选歌曲列表中挑选最适合当前情境的 2 首，用 add_to_queue 动作添加到队列末尾。
不要重复最近刚播过的歌曲。say 字段用一句话中文说明选曲理由。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "say": "选曲理由（一句话中文）",
  "actions": [
    { "type": "add_to_queue", "pick": { "query": "歌曲名 — 艺人名" }, "position": "end" }
  ]
}`;

      const pickUserPrompt = `<context>
当前时间：${localTime}
天气：${weatherStr2}
</context>

<候选歌曲列表>
${candidateList}
</候选歌曲列表>

从以上 ${allCandidates.length} 首候选歌曲中挑选 2 首。`;

      let pickSay = '';
      let pickActions: Action[] = [];
      try {
        const pickResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: pickSystemPrompt },
            { role: 'user', content: pickUserPrompt }
          ],
          { signal: AbortSignal.timeout(PICK_LLM_TIMEOUT_MS) }
        );
        const cleaned = pickResp.content
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed: unknown = JSON.parse(match[0]);
            if (parsed && typeof parsed === 'object') {
              const obj = parsed as Record<string, unknown>;
              if (typeof obj.say === 'string') pickSay = obj.say;
              if (Array.isArray(obj.actions)) {
                pickActions = obj.actions.filter(
                  (a): a is Action =>
                    typeof a === 'object' && a !== null &&
                    typeof (a as Record<string, unknown>).type === 'string' &&
                    (a as Record<string, unknown>).type === 'add_to_queue' &&
                    typeof (a as Record<string, unknown>).pick === 'object'
                );
              }
            }
          } catch {
            logger.warn({ jsonSnippet: match[0].slice(0, 200) }, 'DJ pick-next: JSON parse failed for LLM pick response');
          }
        }
        if (pickActions.length === 0) {
          logger.warn({ raw: pickResp.content.slice(0, 300) }, 'DJ pick-next: failed to extract actions from LLM pick response');
        }
      } catch (err) {
        logger.warn({ err }, 'DJ pick-next: LLM pick failed, using random fallback');
      }

      if (pickActions.length > 0) {
        logger.info(
          { actionCount: pickActions.length, say: pickSay.slice(0, 80) },
          'DJ pick-next: LLM returned candidate actions'
        );
        const prevQueueLength = getQueue().length;
        const result = await executeActions(pickActions, { ncmClient: opts.ncmClient });
        if (result.queueChanged) {
          const newTracks = getQueue().slice(prevQueueLength);
          if (pickSay.trim()) {
            for (const track of newTracks) {
              djPickReasonCache.set(track.ncmId, pickSay.trim());
            }
          }
          broadcast({ type: 'dj.debug', ...phase3Debug, selectedSay: pickSay });
          debugBroadcastSent = true;
          broadcastAppended(prevQueueLength);
          return;
        }
        logger.warn('DJ pick-next: LLM actions did not change queue, using random fallback');
      } else {
        logger.warn('DJ pick-next: LLM returned no usable actions, using random fallback');
      }

      // Phase 4 failed — still broadcast Phase 3 data so the debug panel reflects what was searched
      broadcast({ type: 'dj.debug', ...phase3Debug, selectedSay: '选歌失败，使用随机降级' });
      debugBroadcastSent = true;
    } catch (err) {
      logger.warn(
        {
          err: serializeDjPickNextErrorForLog(err),
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedIdCount: allLikedIds.length,
          currentQueueCount: getQueue().length
        },
        'DJ pick-next: LLM pipeline failed, using random fallback'
      );
    }
  }

  // Random fallback: sample 2 IDs from full liked list, then fetch details
  const recentIds = new Set(
    getRecentPlays(30)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
  const fallbackIds = allLikedIds.filter((id) => !recentIds.has(id) && !currentQueueIds.has(id));

  if (fallbackIds.length === 0) {
    logger.warn('DJ pick-next fallback: no candidates');
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  if (!debugBroadcastSent) {
    broadcast({
      type: 'dj.debug',
      likedSample: [],
      sqRaw: '',
      searchQueries: [],
      searchedTracks: [],
      totalCandidates: fallbackIds.length,
      selectedSay: '随机 fallback（LLM 未配置或选歌失败）'
    });
  }

  const pickedIds = sampleN(fallbackIds, Math.min(2, fallbackIds.length));
  const pickedDetails = await withTimeout(
    opts.ncmClient.getSongDetails(pickedIds).catch(() => []),
    LIKED_DETAILS_TIMEOUT_MS,
    []
  );

  if (pickedDetails.length === 0) {
    logger.warn('DJ pick-next fallback: failed to fetch track details');
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  const prevQueueLength = getQueue().length;
  for (const pick of pickedDetails) {
    addToQueue({ ncmId: String(pick.id), name: pick.name, artists: pick.artists }, 'end');
  }
  broadcastAppended(prevQueueLength);
}

function broadcastAppended(prevQueueLength: number): void {
  const q = getQueue();
  const newTracks = q.slice(prevQueueLength);
  for (const track of newTracks) {
    broadcast({ type: 'queue-appended', track });
  }
  const names = newTracks.map((t) => t.name).filter((n): n is string => Boolean(n));
  broadcast({
    type: 'dj.pick-next.done',
    added: newTracks.length > 0,
    trackName: names.join('、') || undefined
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
