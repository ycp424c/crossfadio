import type { RequestHandler } from 'express';
import { computeSync } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import type { Fragments, Track } from '../../agent/schema.js';
import { LlmClient } from '../../llm/client.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
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

const JOB_TIMEOUT_MS = 100_000;
const SEARCH_QUERY_LLM_TIMEOUT_MS = 45_000;
const PICK_LLM_TIMEOUT_MS = 45_000;
const LIKED_TRACKS_TIMEOUT_MS = 8_000;
const LIKED_SAMPLE_SIZE = 20;
const SEARCH_RESULT_SIZE = 20;

let isRunning = false;
let likedTracksCache: Track[] = [];

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
async function searchCandidates(
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

  // Load liked tracks with a hard timeout; use cache on miss
  const fresh = await withTimeout(
    loadLikedTracksForPlanning(opts.ncmClient),
    LIKED_TRACKS_TIMEOUT_MS,
    [] as Track[]
  );
  if (fresh.length > 0) likedTracksCache = fresh;
  const likedTracks = likedTracksCache;

  const llmConfig = resolveLlmConfig(opts.secrets);
  if (!llmConfig) {
    logger.debug('DJ pick-next: skipping LLM pick because LLM config is missing');
  } else if (likedTracks.length === 0) {
    logger.warn('DJ pick-next: skipping LLM pick because liked tracks are unavailable');
  }

  if (llmConfig && likedTracks.length > 0) {
    try {
      const corpus = loadUserCorpus();
      const [weather] = await Promise.all([withTimeout(fetchWeather(), 4_000, null)]);
      const now = new Date();
      const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
      const day = weekdays[now.getDay()];
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const localTime = `周${day} ${hh}:${mm}`;
      const nowIso = now.toISOString();
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

      // ── Phase 1: random 20 from liked tracks ─────────────────────────────
      const likedSample = sampleN(
        likedTracks.filter((t) => t.id && !excludeIds.has(t.id)),
        LIKED_SAMPLE_SIZE
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
        const match = sqResp.content.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed: unknown = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            searchQueries = parsed
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .slice(0, 3);
          }
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

      // ── Phase 4: LLM picks 2 from combined candidates ────────────────────
      const pickFragments: Fragments = {
        mode: 'chat',
        system: buildSystemPrompt(corpus.djPersona || 'You are a DJ.', 'chat'),
        corpus: {
          taste: corpus.taste,
          routines: corpus.routines,
          moodRules: corpus.moodRules,
          playlists: corpus.playlists,
          likedTracks: allCandidates
        },
        env: { nowIso, localTime, weather, nowPlaying: null },
        memory: { recentPlays, recentChat, recentSegues, extractedPreferences },
        input: {
          kind: 'chat',
          text: `DJ，从上方 ${allCandidates.length} 首候选歌曲（红心歌单+搜索结果）中挑选最适合当前情境的 2 首，各用一个 add_to_queue 动作（position: end）添加至队列末尾。请勿重复最近刚播过的歌曲。say 字段用一句话说明选曲理由。`
        },
        trace: { triggeredBy: 'scheduler', lastDecision: null }
      };

      const output = await computeSync(pickFragments, {
        llmConfig,
        signal: AbortSignal.timeout(PICK_LLM_TIMEOUT_MS)
      });

      if (output.mode === 'chat' && output.actions.length > 0) {
        logger.info(
          {
            intent: output.intent,
            actionCount: output.actions.length,
            actionTypes: output.actions.map((a) => a.type)
          },
          'DJ pick-next: LLM returned candidate actions'
        );
        const prevQueueLength = getQueue().length;
        const result = await executeActions(output.actions, { ncmClient: opts.ncmClient });
        if (result.queueChanged) {
          const newTracks = getQueue().slice(prevQueueLength);
          if (typeof output.say === 'string' && output.say.trim()) {
            for (const track of newTracks) {
              djPickReasonCache.set(track.ncmId, output.say.trim());
            }
          }
          broadcast({
            type: 'dj.debug',
            likedSample: likedSample.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
            sqRaw: sqRawSay,
            searchQueries,
            searchedTracks: searchedTracks.map((t) => ({ id: t.id, name: t.name, artist: t.artist })),
            totalCandidates: allCandidates.length,
            selectedSay: output.say
          });
          broadcastAppended(prevQueueLength);
          return;
        }
        logger.warn(
          {
            intent: output.intent,
            actionCount: output.actions.length,
            actionTypes: output.actions.map((a) => a.type)
          },
          'DJ pick-next: LLM actions did not change queue, using random fallback'
        );
      }
      logger.warn(
        {
          mode: output.mode,
          intent: output.mode === 'chat' ? output.intent : undefined,
          actionCount: output.mode === 'chat' ? output.actions.length : undefined
        },
        'DJ pick-next: LLM returned no usable actions, using random fallback'
      );
    } catch (err) {
      logger.warn(
        {
          err: serializeDjPickNextErrorForLog(err),
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedTrackCount: likedTracks.length,
          currentQueueCount: getQueue().length
        },
        'DJ pick-next: LLM failed, using random fallback'
      );
    }
  }

  // Random fallback: exclude recently played and current queue, pick 2
  const recentIds = new Set(
    getRecentPlays(30)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
  const candidates = likedTracks.filter((t) => t.id && !recentIds.has(t.id) && !currentQueueIds.has(t.id));

  if (candidates.length === 0) {
    logger.warn('DJ pick-next fallback: no candidates');
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  const prevQueueLength = getQueue().length;
  const picks = sampleN(candidates, Math.min(2, candidates.length));
  for (const pick of picks) {
    addToQueue(
      { ncmId: pick.id, name: pick.name, artists: pick.artist ? pick.artist.split(' / ') : [] },
      'end'
    );
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
