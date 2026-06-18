import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { resolveUserDir } from '../../app-paths.js';
import { resolveLlmConfig } from '../../llm/config.js';
import { LlmClient, type LlmMessage } from '../../llm/client.js';
import type { NcmClient } from '../../ncm/client.js';
import { getLogger } from '../../logger.js';
import { getPref, setPref } from '../../store/prefs.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const LIKED_DETAIL_BATCH_SIZE = 200;
const TASTE_ANALYSIS_CHUNK_SIZE = 200;
const DEFAULT_TASTE_ANALYSIS_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `你是一个音乐品味分析师。根据用户的红心（收藏）歌曲列表，分析用户音乐偏好并输出一份结构化的品味档案。

请从以下维度分析：
- **偏好风格/流派**：用户喜欢哪些音乐风格（如流行、摇滚、电子、爵士、R&B、民谣、嘻哈、古典、独立、City Pop 等）
- **偏好艺人**：高频出现的艺人及其特点
- **年代偏好**：偏好的音乐年代（如经典老歌、90年代、2000年代、近五年新歌等）
- **语言偏好**：偏好的语言（华语、英语、日语、韩语等）
- **情绪倾向**：音乐的情绪色彩（如温暖治愈、冷静内敛、热烈奔放、忧郁深沉等）
- **不想听的**：根据用户偏好推断可能不喜欢的类型（如过于嘈杂的、低质量的、过于商业化的等）

输出格式要求：
- 使用简洁的中文
- 每个维度用1-3句话概括
- 整体控制在200字以内
- 开头用"# 我的音乐口味"作为标题
- 格式参考：
# 我的音乐口味
- 喜欢：xxx
- 不想听：xxx`;

const CHUNK_SYSTEM_PROMPT = `你是一个音乐品味分析师。你会收到用户红心歌曲列表中的一个批次。

请只根据这批歌曲提炼可观察到的偏好信号，用简洁中文输出 120-180 字摘要。
覆盖风格/流派、艺人或语言、年代、情绪倾向、可能避雷点。不要输出最终标题，不要假装看到了其他批次。`;

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
  const llmConfig = resolveLlmConfig();
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

    // 4. Save to user corpus taste.md
    const userDir = resolveUserDir(userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    fs.writeFileSync(path.join(userDir, 'taste.md'), taste, 'utf-8');

    logger.info(
      { userId, likedCount: ids.length, analyzedCount: songs.length, batchSize: LIKED_DETAIL_BATCH_SIZE },
      'Taste analysis completed and saved'
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
    const details = await ncmClient.getSongDetails(batchIds);
    songs.push(...details.map((track) => ({
      name: track.name,
      artists: (track as { name: string; artists: string[] }).artists ?? []
    })));
  }
  return songs;
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
    maxTokens: 1000,
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
