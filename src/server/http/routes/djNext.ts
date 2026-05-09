import type { Request, RequestHandler } from 'express';
import type { Track } from '../../agent/schema.js';
import { LlmClient } from '../../llm/client.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { getRecentSegues } from '../../store/segues.js';
import { getPreferenceContext } from '../../store/chat-preferences.js';
import { fetchWeather } from '../../weather.js';
import { searchArtistsForStyle } from '../../web-search.js';
import { getQueue, addToQueue } from '../../store/queue.js';
import { broadcastToUser } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { getOrGenerateDailyThemeWithin } from '../../daily-theme.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

type DjNextOptions = {
  secrets: any;
  ncmClient?: NcmClient;
};

const JOB_TIMEOUT_MS = 180_000;
const SEARCH_QUERY_LLM_TIMEOUT_MS = 120_000;
const PICK_LLM_TIMEOUT_MS = 120_000;
const LIKED_IDS_TIMEOUT_MS = 8_000;
const LIKED_DETAILS_TIMEOUT_MS = 8_000;
const LIKED_IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const LIKED_SAMPLE_SIZE = 20;
const SEARCH_RESULT_SIZE = 40;
const DAILY_THEME_CONTEXT_TIMEOUT_MS = 1_500;

const isRunning = new Map<string, boolean>();

type LikedIdsCache = { ids: string[]; fetchedAt: number };
const likedIdsCache = new Map<string, LikedIdsCache>();

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
  limit: number,
  signal?: AbortSignal
): Promise<Track[]> {
  if (queries.length === 0) return [];
  if (signal?.aborted) return [];
  const perQuery = Math.max(3, Math.ceil((limit + 5) / queries.length));
  const results = await Promise.all(
    queries.map((q) => signal?.aborted ? [] : ncmClient.searchSongs(q, perQuery).catch(() => []))
  );
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const songs of results) {
    for (const song of songs) {
      const id = String(song.id);
      if (!seen.has(id) && !excludeIds.has(id) && song.artists.length > 0) {
        seen.add(id);
        tracks.push({ id, name: song.name, artist: song.artists.join(' / ') });
        if (tracks.length >= limit) return tracks;
      }
    }
  }
  return tracks;
}

export type ParsedDjCandidatePicks = {
  say: string;
  tracks: Track[];
};

export function parseDjCandidatePicks(raw: string, candidates: Track[]): ParsedDjCandidatePicks {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { say: '', tracks: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { say: '', tracks: [] };
  }

  if (!parsed || typeof parsed !== 'object') return { say: '', tracks: [] };

  const obj = parsed as Record<string, unknown>;
  const say = typeof obj.say === 'string' ? obj.say : '';
  const byId = new Map(candidates.map((track) => [track.id, track]));
  const seen = new Set<string>();
  const tracks: Track[] = [];

  const addById = (value: unknown): void => {
    const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    const track = id ? byId.get(id) : undefined;
    if (track && !seen.has(track.id)) {
      seen.add(track.id);
      tracks.push(track);
    }
  };

  const addByIndex = (value: unknown): void => {
    const index = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
    if (!Number.isInteger(index)) return;
    const track = candidates[index - 1];
    if (track && !seen.has(track.id)) {
      seen.add(track.id);
      tracks.push(track);
    }
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
          addById(pick.id);
          addByIndex(pick.index);
        } else {
          addByIndex(value);
        }
      }
    }
  }

  return { say, tracks: tracks.slice(0, 2) };
}

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);
    res.json({ ok: true, running: isRunning.get(userId) ?? false });
    if (!(isRunning.get(userId) ?? false)) {
      void runPickNextJob(userId, ncmClient);
    }
  };
}

async function runPickNextJob(userId: string, ncmClient: NcmClient): Promise<void> {
  if (isRunning.get(userId)) return;
  isRunning.set(userId, true);
  const logger = getLogger();

  const jobTimer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), JOB_TIMEOUT_MS)
  );

  const jobResult = await Promise.race([doPickNext(userId, ncmClient).then(() => 'done' as const), jobTimer]);

  if (jobResult === 'timeout') {
    logger.warn('DJ pick-next job timed out after %dms', JOB_TIMEOUT_MS);
    broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'timeout' });
  }

  isRunning.set(userId, false);
}

async function doPickNext(userId: string, ncmClient: NcmClient): Promise<void> {
  const logger = getLogger();
  let debugBroadcastSent = false;
  const dailyThemePromise = getOrGenerateDailyThemeWithin(DAILY_THEME_CONTEXT_TIMEOUT_MS);


  // Refresh full liked-song ID list at most once per day
  const now = Date.now();
  const cached = likedIdsCache.get(userId);
  if (!cached || now - cached.fetchedAt > LIKED_IDS_CACHE_TTL_MS) {
    const freshIds = await withTimeout(
      ncmClient.getLikedSongIds().catch(() => [] as string[]),
      LIKED_IDS_TIMEOUT_MS,
      [] as string[]
    );
    if (freshIds.length > 0) {
      likedIdsCache.set(userId, { ids: freshIds, fetchedAt: now });
    }
  }
  const allLikedIds = likedIdsCache.get(userId)?.ids ?? [];

  const llmConfig = resolveLlmConfig();
  if (!llmConfig) {
    logger.warn('DJ pick-next: skipping LLM pick because LLM config is missing');
  } else if (allLikedIds.length === 0) {
    logger.warn('DJ pick-next: skipping LLM pick because liked tracks are unavailable');
  }

  if (llmConfig && allLikedIds.length > 0) {
    try {
      const corpus = loadUserCorpus(userId);
      const [weather] = await Promise.all([withTimeout(fetchWeather(userId), 4_000, null)]);
      const nowDate = new Date();
      const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
      const day = weekdays[nowDate.getDay()];
      const hh = String(nowDate.getHours()).padStart(2, '0');
      const mm = String(nowDate.getMinutes()).padStart(2, '0');
      const localTime = `周${day} ${hh}:${mm}`;
      const nowIso = nowDate.toISOString();
      const recentPlays = getRecentPlays(userId, 50);
      const recentChat = getRecentMessages(userId, 20, 60);
      const recentSegues = getRecentSegues(userId, 10);
      const extractedPreferences = getPreferenceContext(userId, 3);

      const recentIds = new Set(
        getRecentPlays(userId, 30)
          .map((p) => p.song_id)
          .filter((id): id is string => id !== null)
      );
      const currentQueueIds = new Set(getQueue(userId).map((t) => t.ncmId));
      const excludeIds = new Set([...recentIds, ...currentQueueIds]);

      // ── Phase 1: sample 20 IDs from full liked list, then fetch details ──
      const candidateIds = allLikedIds.filter((id) => !excludeIds.has(id));
      const sampledIds = sampleN(candidateIds, LIKED_SAMPLE_SIZE);
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
        }));

      logger.info(
        { totalLikedIds: allLikedIds.length, candidateCount: candidateIds.length, sampledCount: likedSample.length },
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
      const themeContext = dailyTheme
        ? `\n今日主题：${dailyTheme.theme}\n主题关键词：${dailyTheme.keywords.join('、')}\n`
        : '';

      const stylePrompt =
        `当前时间：${localTime}\n天气：${weatherStr}\n最近播放：\n${recentPlayNames}\n` +
        themeContext +
        `\n请根据以上信息（包括今日主题），推荐 2-3 个适合当下情境的音乐风格方向。` +
        `对每个风格，列出 3-5 位可以在网易云音乐搜到的代表艺人（华人艺人和海外艺人各半，保证多样性）。` +
        `style 字段用英文关键词方便检索，artists 里同时包含中外艺人。` +
        `直接返回 JSON 对象，格式如下：\n` +
        `{"styles":[{"style":"indie folk","artists":["万能青年旅店","Bon Iver","张玮玮","Sufjan Stevens"]},` +
        `{"style":"jazz piano","artists":["Bill Evans","上原广美","Keith Jarrett","罗宁"]}]}`;

      let llmArtists: string[] = [];
      let styleConcepts: string[] = [];
      let sqRawSay = '';
      try {
        const sqResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: corpus.djPersona || 'You are a DJ.' },
            { role: 'user', content: stylePrompt }
          ],
          { signal: AbortSignal.timeout(SEARCH_QUERY_LLM_TIMEOUT_MS) }
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
        logger.warn({ err }, 'DJ pick-next: style + artist generation failed');
      }

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
从候选歌曲列表中挑选最适合当前情境的 2 首，返回它们的候选歌曲 id。
不要重复最近刚播过的歌曲。say 字段用一句话中文说明选曲理由。
优先选择艺人名像真实人名或乐队的歌曲，避开艺人名明显是厂牌、合集、影视原声、或自动生成的选项（如"群星""Various Artists""佚名""原声带"等）。
只能返回候选歌曲列表中真实存在的 id，不要编造 id，不要返回歌名搜索词。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "say": "选曲理由（一句话中文）",
  "pickIds": ["候选歌曲id1", "候选歌曲id2"]
}`;

      const themeContextUser = dailyTheme
        ? `今日主题：${dailyTheme.theme}\n`
        : '';

      const pickUserPrompt = `<context>
当前时间：${localTime}
天气：${weatherStr2}
${themeContextUser}</context>

<候选歌曲列表>
${candidateList}
</候选歌曲列表>

从以上 ${allCandidates.length} 首候选歌曲中挑选 2 首。`;

      let pickSay = '';
      let pickedTracks: Track[] = [];
      try {
        const pickResp = await new LlmClient(llmConfig).complete(
          [
            { role: 'system', content: pickSystemPrompt },
            { role: 'user', content: pickUserPrompt }
          ],
          { signal: AbortSignal.timeout(PICK_LLM_TIMEOUT_MS) }
        );
        const parsedPicks = parseDjCandidatePicks(pickResp.content, allCandidates);
        pickSay = parsedPicks.say;
        pickedTracks = parsedPicks.tracks;
        if (pickedTracks.length === 0) {
          logger.warn({ raw: pickResp.content.slice(0, 300) }, 'DJ pick-next: failed to extract whitelisted picks from LLM response');
        }
      } catch (err) {
        logger.warn({ err }, 'DJ pick-next: LLM pick failed, using random fallback');
      }

      if (pickedTracks.length > 0) {
        logger.info(
          { pickedIds: pickedTracks.map((track) => track.id), say: pickSay.slice(0, 80) },
          'DJ pick-next: LLM returned whitelisted candidate picks'
        );
        const prevQueueLength = getQueue(userId).length;
        const recentPlayIds = new Set(
          getRecentPlays(userId, 50)
            .map((p) => p.song_id)
            .filter((id): id is string => id !== null)
        );
        const currentQueueIds = new Set(getQueue(userId).map((t) => t.ncmId));
        for (const track of pickedTracks) {
          if (recentPlayIds.has(track.id) || currentQueueIds.has(track.id)) continue;
          addToQueue(userId, {
            ncmId: track.id,
            name: track.name,
            artists: track.artist ? track.artist.split(' / ').filter(Boolean) : []
          }, 'end');
          currentQueueIds.add(track.id);
        }
        if (getQueue(userId).length > prevQueueLength) {
          const newTracks = getQueue(userId).slice(prevQueueLength);
          if (pickSay.trim()) {
            for (const track of newTracks) {
              djPickReasonCache.set(track.ncmId, pickSay.trim());
            }
          }
          broadcastToUser(userId, { type: 'dj.debug', ...phase3Debug, selectedSay: pickSay });
          debugBroadcastSent = true;
          broadcastAppended(userId, prevQueueLength);
          return;
        }
        logger.warn('DJ pick-next: whitelisted picks did not change queue, using random fallback');
      } else {
        logger.warn('DJ pick-next: LLM returned no usable whitelisted picks, using random fallback');
      }

      // Phase 4 failed — still broadcast Phase 3 data so the debug panel reflects what was searched
      broadcastToUser(userId, { type: 'dj.debug', ...phase3Debug, selectedSay: '选歌失败，使用随机降级' });
      debugBroadcastSent = true;
    } catch (err) {
      logger.warn(
        {
          err: serializeDjPickNextErrorForLog(err),
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedIdCount: allLikedIds.length,
          currentQueueCount: getQueue(userId).length
        },
        'DJ pick-next: LLM pipeline failed, using random fallback'
      );
    }
  }

  // Random fallback: sample 2 IDs from full liked list, then fetch details
  const recentIds = new Set(
    getRecentPlays(userId, 30)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue(userId).map((t) => t.ncmId));
  const fallbackIds = allLikedIds.filter((id) => !recentIds.has(id) && !currentQueueIds.has(id));

  if (fallbackIds.length === 0) {
    logger.warn('DJ pick-next fallback: no candidates');
    broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  if (!debugBroadcastSent) {
    broadcastToUser(userId, {
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
  const pickedDetails = (await withTimeout(
    ncmClient.getSongDetails(pickedIds).catch(() => []),
    LIKED_DETAILS_TIMEOUT_MS,
    []
  )).filter((t) => t.artists.length > 0);

  if (pickedDetails.length === 0) {
    logger.warn('DJ pick-next fallback: failed to fetch track details');
    broadcastToUser(userId, { type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  const prevQueueLength = getQueue(userId).length;
  for (const pick of pickedDetails) {
    addToQueue(userId, { ncmId: String(pick.id), name: pick.name, artists: pick.artists }, 'end');
  }
  broadcastAppended(userId, prevQueueLength);
}

function broadcastAppended(userId: string, prevQueueLength: number): void {
  const q = getQueue(userId);
  const newTracks = q.slice(prevQueueLength);
  for (const track of newTracks) {
    broadcastToUser(userId, { type: 'queue-appended', track });
  }
  const names = newTracks.map((t) => t.name).filter((n): n is string => Boolean(n));
  broadcastToUser(userId, {
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

function getScopedNcmClient(req: Request, fallback?: NcmClient): NcmClient {
  const ncmClient = (req as Partial<AuthedRequest>).ncmClient ?? fallback;
  if (!ncmClient) {
    throw new Error('NCM client missing from request scope');
  }
  return ncmClient;
}
