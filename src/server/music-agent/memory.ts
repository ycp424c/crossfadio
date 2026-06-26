import { z } from 'zod';
import type { MusicAgentLlmClient } from './schema.js';
import { getUnextractedMessages, markMessagesExtracted, type StoredMessage } from '../store/messages.js';
import { saveChatPreference } from '../store/chat-preferences.js';

const EXTRACTION_THRESHOLD = 4;
const MAX_BATCH_MESSAGES = 20;
const MAX_MESSAGE_CONTENT_LENGTH = 300;
const MAX_SAVED_SUMMARY_LENGTH = 160;

const inFlightByUser = new Map<string, Promise<MemoryExtractionResult>>();

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

export function extractChatPreferencesIfDue(
  userId: string,
  llmClient: MusicAgentLlmClient,
  signal?: AbortSignal
): Promise<MemoryExtractionResult> {
  const existing = inFlightByUser.get(userId);
  if (existing) return existing;

  const promise = extractChatPreferencesIfDueInner(userId, llmClient, signal).finally(() => {
    if (inFlightByUser.get(userId) === promise) {
      inFlightByUser.delete(userId);
    }
  });
  inFlightByUser.set(userId, promise);
  return promise;
}

async function extractChatPreferencesIfDueInner(
  userId: string,
  llmClient: MusicAgentLlmClient,
  signal?: AbortSignal
): Promise<MemoryExtractionResult> {
  const messages = getUnextractedMessages(userId).slice(0, MAX_BATCH_MESSAGES);
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
  const summary = parsed.musicRelated ? sanitizeMusicPreferenceSummary(parsed.summary) : '';
  markMessagesExtracted(userId, messageIds);

  if (summary) {
    saveChatPreference(userId, summary, messageIds);
  }

  return {
    extracted: true,
    messageIds,
    summary
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

export function sanitizeMusicPreferenceSummary(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (!hasMusicSignal(compact)) return '';
  if (hasSensitivePersonalFact(compact)) return '';

  const withPrefix = compact.startsWith('近期偏好：') ? compact : `近期偏好：${compact}`;
  if (withPrefix.length <= MAX_SAVED_SUMMARY_LENGTH) return withPrefix;
  return `${withPrefix.slice(0, MAX_SAVED_SUMMARY_LENGTH - 1)}…`;
}

function buildExtractionPrompt(messages: StoredMessage[]): string {
  const transcript = messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      return `[${message.id}] ${role}: ${truncateForPrompt(message.content)}`;
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

function truncateForPrompt(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_MESSAGE_CONTENT_LENGTH) return compact;
  return `${compact.slice(0, MAX_MESSAGE_CONTENT_LENGTH - 1)}…`;
}

function hasMusicSignal(summary: string): boolean {
  return /音乐|歌|歌曲|选歌|播放|队列|风格|艺人|歌手|女声|男声|人声|流行|摇滚|爵士|电子|粤语|华语|日系|能量|节奏|旋律|安静|吵|通勤|跑步|city\s*pop|indie|dream\s*pop|hip\s*hop|rap|r&b/i.test(summary);
}

function hasSensitivePersonalFact(summary: string): boolean {
  return /住址|地址|定位|经纬度|身份证|手机号|电话|公司|项目|会议|工资|家庭|真实姓名/i.test(summary);
}
