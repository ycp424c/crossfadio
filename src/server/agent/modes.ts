import type { Fragments } from './schema.js';

// Mode-specific constraints appended to the system prompt.
// Each template ends with the JSON output contract the LLM must follow.

const PLAN_CONSTRAINT = `
## 当前模式：plan（今日电台计划）

你的任务是为用户生成今日的电台播放计划，覆盖 1-4 个时段（morning / work / evening / late-night）。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "mode": "plan",
  "date": "YYYY-MM-DD",
  "segments": [
    {
      "id": "morning" | "work" | "evening" | "late-night",
      "label": "时段名称",
      "timeRange": "07:00-09:00",
      "mood": "清醒/专注/...",
      "energyPct": 0-100,
      "tracks": [
        { "query": "歌曲名 — 艺人名", "reason": "推荐理由（一句话）" }
      ]
    }
  ],
  "narrative": "整体电台今日概述（1-2句）"
}
`.trim();

const SEGUE_CONSTRAINT = `
## 当前模式：segue（DJ 串场口播）

你的任务是为两首歌之间生成一段 DJ 串场口播。
必须结合输入里提供的真实信息来写：前后两首歌的歌名/艺人、歌词片段、歌曲标签（若有）。
口播长度可灵活调整：1-4 句话，通常 30-220 字；信息少时可以更短，信息丰富时可以更长。
不要生硬套模板，不要虚构不存在的歌曲信息；缺失信息可自然略过。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "mode": "segue",
  "say": "串场口播文字",
  "duckingHintSec": 8,
  "filterSweep": true,
  "emotionTag": "calm" | "energetic" | "melancholic" | "upbeat" | ...
}
`.trim();

const CHAT_CONSTRAINT = `
## 当前模式：chat（和用户聊天）

你的任务是回应用户的消息。先判断意图，再生成回复和可选的执行动作。

意图分类：
- chitchat：纯闲聊，无需改变播放
- adjust_queue：修改队列（换歌/添加/跳过）
- replan：重排当前时段或整体计划
- control：直接控制指令（静音/暂停等）
- ask_meta：询问元信息（当前播放/计划内容）

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "mode": "chat",
  "intent": "<意图分类>",
  "say": "对用户的回复（自然语言）",
  "actions": []
}

actions 数组仅在 adjust_queue / replan / control 意图时填充，chitchat / ask_meta 时为空数组。

仅允许使用以下 action.type：
- "swap_next"：立刻把一首歌换到下一首，格式：{ "type": "swap_next", "pick": { "query": "歌曲名 — 艺人名" } }
- "add_to_queue"：加入队列，格式：{ "type": "add_to_queue", "pick": { "query": "歌曲名 — 艺人名" }, "position": "end" | "after_current" }
- "skip"
- "ban_artist"
- "ban_track"
- "adjust_mood"
- "replan_segment"
- "set_pref"

不要输出未定义的动作类型，例如 "play"、"pause_music"、"queue_song"。
`.trim();

export function getModeConstraint(mode: Fragments['mode']): string {
  switch (mode) {
    case 'plan':
      return PLAN_CONSTRAINT;
    case 'segue':
      return SEGUE_CONSTRAINT;
    case 'chat':
      return CHAT_CONSTRAINT;
  }
}

export function buildSystemPrompt(basePersona: string, mode: Fragments['mode']): string {
  const constraint = getModeConstraint(mode);
  return `${basePersona.trim()}\n\n${constraint}`;
}
