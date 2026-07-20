import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { resolveLlmConfig } from '../../llm/config.js';
import { LlmClient, type LlmMessage } from '../../llm/client.js';
import type { NcmClient } from '../../ncm/client.js';
import { getLogger } from '../../logger.js';
import { getPref, setPref } from '../../store/prefs.js';
import { NCM_ERROR_CODE } from '../../../shared/schema.js';
import { saveTasteProfile } from '../../store/taste-profiles.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const LIKED_DETAIL_BATCH_SIZE = 200;
const TASTE_ANALYSIS_CHUNK_SIZE = 200;
const DEFAULT_TASTE_ANALYSIS_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `你是一个音乐品味分析师和 AI DJ 顾问。根据用户的红心（收藏）歌曲列表，分析用户音乐偏好，并输出一份供 DJ 后续选歌使用的结构化品味档案。

分析要求：
- 只基于歌曲名、艺人和可观察到的聚类信号推断，不要编造用户未表现出的偏好。
- 不只列标签，要解释这些偏好在声音、情绪、场景和选歌策略上意味着什么。
- 兼顾“舒适区”和“探索边界”：既说明最稳定的偏好，也说明可以自然扩展到哪些相邻风格。
- 避免把单个孤立艺人当成强结论；高频或反复出现的信号优先。

输出格式要求：
- 使用中文，整体控制在600-900字。
- 开头固定为"# 我的音乐口味"。
- 必须使用以下 Markdown 二级标题，标题不要增删改名：
## 核心画像
用2-3句话概括这个用户的整体听感偏好、稳定口味和可能的审美重心。

## 常听风格与声音质感
用项目符号列出主要风格/流派、编曲质感、节奏密度、器乐或制作特征。每条都要带简短解释。

## 高频艺人、年代与语言线索
概括高频艺人或艺人群、年代偏好、语言/地域倾向；没有明显证据时写"不明显"，不要硬推断。

## 情绪与场景偏好
说明用户更可能在什么情绪、时间段或生活场景中享受这些歌，以及不宜过度强化的情绪方向。

## DJ 选歌提示
- 优先：适合直接命中的风格、艺人特征或歌曲气质。
- 可探索：可以从当前品味自然外延出去的相邻方向。
- 少放：不一定绝对讨厌，但应该降低频率或谨慎尝试的方向。
- 避免：根据证据推断明显不适合长期连续播放的方向。`;

const CHUNK_SYSTEM_PROMPT = `你是一个音乐品味分析师。你会收到用户红心歌曲列表中的一个批次。

请只根据这批歌曲提炼可观察到的偏好信号，用简洁中文输出 220-320 字摘要。
覆盖风格/流派、声音质感、艺人或语言、年代、情绪场景、可能避雷点和可探索外延。不要输出最终标题，不要假装看到了其他批次。`;

/**
 * Core taste analysis logic. Reusable by both the HTTP handler and background scheduler.
 * @returns The taste text on success, null on failure (errors are logged internally).
 */
export async function runTasteAnalysis(userId: string, ncmClient: NcmClient): Promise<string | null> {
  const logger = getLogger();

  // 1. Fetch liked song IDs
  let ids: string[];
  try {
    ids = await ncmClient.getLikedSongIds();
  } catch (err) {
    logger.error({ err, userId }, 'Failed to fetch liked song IDs for taste analysis');
    return null;
  }

  if (ids.length === 0) {
    logger.info({ userId }, 'Taste analysis skipped: no liked songs');
    return null;
  }

  // 2. Fetch all liked song details in batches.
  let songs: Array<{ name: string; artists: string[] }>;
  try {
    songs = await fetchAllLikedSongDetails(ncmClient, ids);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to fetch song details for taste analysis');
    return null;
  }

  if (songs.length === 0) {
    logger.warn({ userId }, 'Taste analysis: no song details available');
    return null;
  }

  // 3. Call LLM. Large libraries are summarized chunk-by-chunk first so every
  // liked song can participate without building an oversized prompt.
  const llmConfig = resolveLlmConfig(userId);
  if (!llmConfig) {
    logger.warn({ userId }, 'Taste analysis skipped: LLM not configured');
    return null;
  }

  const client = new LlmClient(llmConfig);

  try {
    const result = songs.length <= TASTE_ANALYSIS_CHUNK_SIZE
      ? await client.complete(buildFinalTasteMessages(ids.length, songs), buildTasteCompleteOptions())
      : await analyzeLargeTasteLibrary(client, ids.length, songs);
    const taste = result.content.trim();

    saveTasteProfile({
      userId,
      profile: {
        summary: taste,
        likedCount: ids.length,
        analyzedCount: songs.length
      },
      sourceKind: 'liked_library',
      sourceLibraryHash: createHash('sha256')
        .update([...ids].sort().join('\n'))
        .digest('hex')
    });

    logger.info(
      { userId, likedCount: ids.length, analyzedCount: songs.length, batchSize: LIKED_DETAIL_BATCH_SIZE },
      'Taste analysis completed and saved as Taste Profile'
    );
    return taste;
  } catch (err) {
    // Throw abort/timeout errors so callers can distinguish (504 vs 502)
    if (isAbortError(err)) throw err;
    logger.error({ err, userId }, 'Taste analysis failed');
    return null;
  }
}

async function fetchAllLikedSongDetails(
  ncmClient: NcmClient,
  ids: string[]
): Promise<Array<{ name: string; artists: string[] }>> {
  const songs: Array<{ name: string; artists: string[] }> = [];
  for (const batchIds of chunkArray(ids, LIKED_DETAIL_BATCH_SIZE)) {
    const details = await fetchLikedSongDetailsBatch(ncmClient, batchIds);
    songs.push(...details.map((track) => ({
      name: track.name,
      artists: (track as { name: string; artists: string[] }).artists ?? []
    })));
  }
  return songs;
}

async function fetchLikedSongDetailsBatch(
  ncmClient: NcmClient,
  batchIds: string[]
): ReturnType<NcmClient['getSongDetails']> {
  try {
    return await ncmClient.getSongDetails(batchIds);
  } catch (err) {
    if (!isNcmBadResponseError(err)) {
      throw err;
    }

    const logger = getLogger();
    logger.warn(
      { err, batchSize: batchIds.length },
      'Taste analysis retrying liked song details individually after malformed batch'
    );

    const recovered: Awaited<ReturnType<NcmClient['getSongDetails']>> = [];
    for (const id of batchIds) {
      try {
        recovered.push(...await ncmClient.getSongDetails([id]));
      } catch (singleErr) {
        if (!isNcmBadResponseError(singleErr)) {
          throw singleErr;
        }
        logger.warn({ err: singleErr, songId: id }, 'Taste analysis skipped malformed liked song detail');
      }
    }
    return recovered;
  }
}

function isNcmBadResponseError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === NCM_ERROR_CODE.BAD_RESPONSE;
}

async function analyzeLargeTasteLibrary(
  client: LlmClient,
  likedCount: number,
  songs: Array<{ name: string; artists: string[] }>
): Promise<{ content: string }> {
  const chunks = chunkArray(songs, TASTE_ANALYSIS_CHUNK_SIZE);
  const chunkSummaries: string[] = [];

  for (const [chunkIndex, chunkSongs] of chunks.entries()) {
    const startIndex = chunkIndex * TASTE_ANALYSIS_CHUNK_SIZE;
    const result = await client.complete(
      buildChunkTasteMessages(likedCount, chunkSongs, startIndex),
      buildTasteCompleteOptions()
    );
    const summary = result.content.trim();
    if (summary) {
      chunkSummaries.push(summary);
    }
  }

  return client.complete(buildMergedTasteMessages(likedCount, songs.length, chunkSummaries), buildTasteCompleteOptions());
}

function buildFinalTasteMessages(
  likedCount: number,
  songs: Array<{ name: string; artists: string[] }>
): LlmMessage[] {
  const songListText = formatSongList(songs, 0);
  const userMessage = `以下用户收藏了 ${likedCount} 首歌曲（以下是全部 ${songs.length} 首）：\n\n${songListText}\n\n请分析该用户的音乐品味。`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];
}

function buildChunkTasteMessages(
  likedCount: number,
  songs: Array<{ name: string; artists: string[] }>,
  startIndex: number
): LlmMessage[] {
  const endIndex = startIndex + songs.length;
  const songListText = formatSongList(songs, startIndex);
  const userMessage = `用户一共收藏了 ${likedCount} 首红心歌曲。以下是第 ${startIndex + 1}-${endIndex} 首：\n\n${songListText}\n\n请分析这一批歌曲透露出的音乐偏好信号。`;

  return [
    { role: 'system', content: CHUNK_SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];
}

function buildMergedTasteMessages(
  likedCount: number,
  analyzedCount: number,
  chunkSummaries: string[]
): LlmMessage[] {
  const summaryText = chunkSummaries.map((summary, index) => `批次 ${index + 1}: ${summary}`).join('\n\n');
  const userMessage = `用户一共收藏了 ${likedCount} 首红心歌曲，已分析到 ${analyzedCount} 首详情。以下是所有批次的偏好摘要：\n\n${summaryText}\n\n请综合所有批次，输出最终音乐品味档案。不要提及批次或分析过程。`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];
}

function buildTasteCompleteOptions(): {
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
} {
  return {
    temperature: 0.7,
    maxTokens: 1600,
    signal: AbortSignal.timeout(getTasteAnalysisTimeoutMs())
  };
}

function formatSongList(
  songs: Array<{ name: string; artists: string[] }>,
  startIndex: number
): string {
  return songs
    .map((song, index) => `${startIndex + index + 1}. ${song.name} - ${song.artists.join(' / ') || '未知艺人'}`)
    .join('\n');
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createAnalyzeTasteHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, ncmClient } = req as AuthedRequest;

    try {
      const taste = await runTasteAnalysis(userId, ncmClient);

      if (taste === null) {
        res.status(502).json({ ok: false, message: '品味分析失败，请稍后重试' });
        return;
      }

      if (taste === '') {
        res.json({ ok: true, taste: '', message: '红心歌单为空，无法分析' });
        return;
      }

      res.json({ ok: true, taste });
    } catch (err) {
      if (isAbortError(err)) {
        getLogger().warn({ err, userId }, 'Taste analysis timed out');
        res.status(504).json({ ok: false, message: '品味分析超时，请稍后重试' });
      } else {
        throw err;
      }
    }
  };
}

function getTasteAnalysisTimeoutMs(): number {
  const raw = Number(process.env.CROSSFADIO_TASTE_ANALYSIS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASTE_ANALYSIS_TIMEOUT_MS;
}

// ── Scheduled taste analysis ──────────────────────────────────────────────────

/** Per-user in-flight task set to prevent duplicate concurrent analyses. */
const inFlightTaste = new Set<string>();

const TASTE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Fire-and-forget: if taste analysis hasn't been run for this user, or was
 * last run > 7 days ago, spawn an async analysis. Does not block or throw.
 */
export function scheduleTasteAnalysisIfDue(userId: string, ncmClient: NcmClient): void {
  // Prevent duplicate concurrent runs for the same user
  if (inFlightTaste.has(userId)) return;

  const lastRunStr = getPref<string>(userId, 'tasteAnalysis.lastRun');
  if (lastRunStr) {
    const lastRun = new Date(lastRunStr).getTime();
    if (Number.isFinite(lastRun) && (Date.now() - lastRun) < TASTE_REFRESH_INTERVAL_MS) {
      return; // not due yet
    }
  }

  inFlightTaste.add(userId);
  getLogger().info({ userId, lastRun: lastRunStr ?? 'never' }, 'Scheduling background taste analysis');

  runTasteAnalysis(userId, ncmClient)
    .then((taste) => {
      // Only record timestamp if analysis actually produced a result
      if (taste !== null) {
        setPref(userId, 'tasteAnalysis.lastRun', new Date().toISOString());
      }
    })
    .catch((err) => {
      getLogger().error({ err, userId }, 'Background taste analysis crashed');
    })
    .finally(() => {
      inFlightTaste.delete(userId);
    });
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  return false;
}
