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

const LIKED_SAMPLE_LIMIT = 200;
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

  // 2. Sample up to LIKED_SAMPLE_LIMIT
  const sampledIds = ids.slice(0, LIKED_SAMPLE_LIMIT);

  // 3. Fetch song details
  let songs: Array<{ name: string; artists: string[] }>;
  try {
    const details = await ncmClient.getSongDetails(sampledIds);
    songs = details.map((t) => ({
      name: t.name,
      artists: (t as { name: string; artists: string[] }).artists ?? []
    }));
  } catch (err) {
    logger.error({ err, userId }, 'Failed to fetch song details for taste analysis');
    return null;
  }

  if (songs.length === 0) {
    logger.warn({ userId }, 'Taste analysis: no song details available');
    return null;
  }

  // 4. Build LLM prompt
  const songListText = songs
    .map((s, i) => `${i + 1}. ${s.name} - ${s.artists.join(' / ') || '未知艺人'}`)
    .join('\n');

  const userMessage = `以下用户收藏了 ${ids.length} 首歌曲（以下是前 ${songs.length} 首样本）：\n\n${songListText}\n\n请分析该用户的音乐品味。`;

  // 5. Call LLM
  const llmConfig = resolveLlmConfig();
  if (!llmConfig) {
    logger.warn({ userId }, 'Taste analysis skipped: LLM not configured');
    return null;
  }

  const client = new LlmClient(llmConfig);
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];

  try {
    const result = await client.complete(messages, {
      temperature: 0.7,
      maxTokens: 1000,
      signal: AbortSignal.timeout(getTasteAnalysisTimeoutMs())
    });
    const taste = result.content.trim();

    // 6. Save to user corpus taste.md
    const userDir = resolveUserDir(userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    fs.writeFileSync(path.join(userDir, 'taste.md'), taste, 'utf-8');

    logger.info({ userId, likedCount: ids.length, sampledCount: songs.length }, 'Taste analysis completed and saved');
    return taste;
  } catch (err) {
    // Throw abort/timeout errors so callers can distinguish (504 vs 502)
    if (isAbortError(err)) throw err;
    logger.error({ err, userId }, 'Taste analysis failed');
    return null;
  }
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
