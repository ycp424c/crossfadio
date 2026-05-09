import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { resolveUserDir } from '../../app-paths.js';
import { resolveLlmConfig } from '../../llm/config.js';
import { LlmClient, type LlmMessage } from '../../llm/client.js';
import type { NcmClient } from '../../ncm/client.js';
import { getLogger } from '../../logger.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const LIKED_SAMPLE_LIMIT = 200;

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

export function createAnalyzeTasteHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, ncmClient } = req as AuthedRequest;

    // 1. Fetch liked song IDs
    let ids: string[];
    try {
      ids = await ncmClient.getLikedSongIds();
    } catch (err) {
      getLogger().error({ err, userId }, 'Failed to fetch liked song IDs');
      res.status(502).json({ ok: false, error: '无法获取红心歌单，请确认网易云已登录' });
      return;
    }

    if (ids.length === 0) {
      res.json({ ok: true, taste: '', message: '红心歌单为空，无法分析' });
      return;
    }

    // 2. Sample up to LIKED_SAMPLE_LIMIT songs
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
      getLogger().error({ err, userId }, 'Failed to fetch song details');
      res.status(502).json({ ok: false, error: '无法获取歌曲详情' });
      return;
    }

    if (songs.length === 0) {
      res.json({ ok: true, taste: '', message: '无法获取歌曲信息' });
      return;
    }

    // 4. Build LLM prompt
    const songListText = songs
      .map((s, i) => `${i + 1}. ${s.name} - ${s.artists.join(' / ') || '未知艺人'}`)
      .join('\n');

    const userMessage = `以下用户收藏了 ${ids.length} 首歌曲（以下是前 ${songs.length} 首样本）：\n\n${songListText}\n\n请分析该用户的音乐品味。`;

    // 5. Call LLM
    const llmConfig = resolveLlmConfig();
    if (!llmConfig) {
      res.status(503).json({ ok: false, error: 'LLM 未配置，无法分析' });
      return;
    }

    const client = new LlmClient(llmConfig);
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ];

    try {
      const result = await client.complete(messages, { temperature: 0.7, maxTokens: 1000 });
      const taste = result.content.trim();

      // 6. Save to user corpus taste.md
      const userDir = resolveUserDir(userId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
      const tastePath = path.join(userDir, 'taste.md');
      fs.writeFileSync(tastePath, taste, 'utf-8');

      getLogger().info({ userId, likedCount: ids.length, sampledCount: songs.length }, 'Taste analysis saved');

      res.json({ ok: true, taste });
    } catch (err) {
      getLogger().error({ err, userId }, 'LLM taste analysis failed');
      res.status(502).json({ ok: false, error: '品味分析失败，请稍后重试' });
    }
  };
}
