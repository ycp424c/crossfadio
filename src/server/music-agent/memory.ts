import { z } from 'zod';
import type { MusicAgentLlmClient } from './schema.js';
import { getUnextractedMessages, markMessagesExtracted, type StoredMessage } from '../store/messages.js';
import { saveChatPreference } from '../store/chat-preferences.js';

const EXTRACTION_THRESHOLD = 4;

const extractionSchema = z.object({
  musicRelated: z.boolean().default(false),
  summary: z.string().default('')
});

type ParsedExtraction = z.infer<typeof extractionSchema>;

export type MemoryExtractionResult = {
  extracted: boolean;
  messageIds: number[];
  summary: string;
};

export async function extractChatPreferencesIfDue(
  userId: string,
  llmClient: MusicAgentLlmClient,
  signal?: AbortSignal
): Promise<MemoryExtractionResult> {
  const messages = getUnextractedMessages(userId);
  if (messages.length < EXTRACTION_THRESHOLD) {
    return { extracted: false, messageIds: [], summary: '' };
  }

  const messageIds = messages.map((message) => message.id);
  const response = await llmClient.complete(
    [
      {
        role: 'system',
        content:
          '你负责从聊天记录中抽取音乐选择偏好。只抽取音乐、选歌、播放队列、风格、艺人、情绪、场景、避雷相关偏好；不要保存身份、位置、工作、生活琐事或任何非音乐聊天。严格输出 JSON：{"musicRelated": boolean, "summary": string}，不要输出其他字段。'
      },
      {
        role: 'user',
        content: buildExtractionPrompt(messages)
      }
    ],
    { temperature: 0, maxTokens: 400, signal }
  );

  const parsed = parseExtraction(response.content);
  const summary = parsed.summary.trim();
  markMessagesExtracted(userId, messageIds);

  if (parsed.musicRelated && summary) {
    saveChatPreference(userId, summary, messageIds);
  }

  return {
    extracted: true,
    messageIds,
    summary: parsed.musicRelated ? summary : ''
  };
}

export function parseExtraction(raw: string): ParsedExtraction {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return { musicRelated: false, summary: '' };

  try {
    const parsed = extractionSchema.safeParse(JSON.parse(jsonText));
    if (!parsed.success) return { musicRelated: false, summary: '' };
    return {
      musicRelated: parsed.data.musicRelated,
      summary: parsed.data.summary.trim()
    };
  } catch {
    return { musicRelated: false, summary: '' };
  }
}

function buildExtractionPrompt(messages: StoredMessage[]): string {
  const transcript = messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      return `[${message.id}] ${role}: ${message.content}`;
    })
    .join('\n');

  return `请判断以下聊天是否包含可长期复用的音乐/选歌偏好，并抽取为一句紧凑中文摘要。

规则：
- 只提取音乐偏好：风格、歌手、语言、年代、情绪、场景、能量、避雷、队列调整偏好。
- 不保存身份、地理位置、工作信息、隐私、普通闲聊或非音乐事实。
- 如果没有音乐相关偏好，返回 {"musicRelated": false, "summary": ""}。
- 如果有音乐偏好，summary 以“近期偏好：”开头，控制在 120 字以内。
- 严格返回 JSON 对象：{"musicRelated": boolean, "summary": string}

聊天记录：
${transcript}`;
}

function extractJsonObject(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match?.[0] ?? null;
}
