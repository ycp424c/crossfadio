import type { LlmMessage, LlmResponseFormat } from '../llm/client.js';
import { musicAgentToolNameSchema, type MusicAgentContextSummary } from './schema.js';
import type { ToolObservation } from './tools.js';

type LoopObservation = ToolObservation & {
  tool?: string;
};

export type BuildLoopMessagesInput = {
  context: MusicAgentContextSummary;
  observations: LoopObservation[];
  candidateSummary: string;
  targetPickCount?: number;
  hardFinalOnlyRetry?: boolean;
};

const TOOL_WHITELIST = musicAgentToolNameSchema.options.join(', ');
const MAX_CONTEXT_CHARS = 1_800;
const MAX_CANDIDATE_CHARS = 2_400;
const MAX_OBSERVATION_CHARS = 2_000;

export const FINAL_PICK_RESPONSE_FORMAT: LlmResponseFormat = { type: 'json_object' };

export function buildLoopMessages(input: BuildLoopMessagesInput): LlmMessage[] {
  const context = compactJson(input.context, MAX_CONTEXT_CHARS);
  const candidatePool = truncate(input.candidateSummary || '[]', MAX_CANDIDATE_CHARS);
  const targetPickCount = input.targetPickCount ?? 2;
  const observations = compactJson(input.observations.map((item) => ({
    tool: item.tool,
    summary: item.summary,
    candidateCount: item.candidateCount,
    problems: item.problems ?? []
  })), MAX_OBSERVATION_CHARS);

  return [
    {
      role: 'system',
      content: [
        '你是 Crossfadio 的 bounded music-agent tool-loop 控制器。',
        '只输出严格 JSON，不要 Markdown、不要解释、不要额外文本。',
        `可调用工具白名单：${TOOL_WHITELIST}。`,
        '输出 tool_call 时格式为 {"type":"tool_call","tool":"工具名","input":{...}}。',
        '输出 final 时格式为 {"type":"final","say":"...","picks":[{"id":"候选池ID","reason":"...","source":"liked|playlist|plan|search|style_expansion|trend"}],"rejected":[]}。',
        'final picks 的 id 必须来自候选池；不能选择候选池外的歌曲。',
        'activeDirective/current chat 必须优先于趋势、榜单、泛化流行度。',
        'recentArtistPenalties 中 penalty 较高的歌手需要先在 expand_queries 阶段放入 avoidArtists，并用相邻风格或不同歌手扩展召回。',
        'recentTrackPenalties 是同一首歌的长周期重复惩罚；penalty 高的候选除非明显最贴合，否则应优先让位给相邻风格的新候选。',
        '不要编造 NCM id；如果候选池不足，先调用白名单工具补候选。',
        `final picks 最多选择 ${targetPickCount} 首；高质量候选不足时可以少选，不要为了凑数选择明显不合适的歌。`,
        `候选池已有 ${targetPickCount} 首以上且已经调用 rank_candidates/diversify_candidates/finalize_pick 后，下一步必须输出 final，不要继续调用工具。`
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'compact_context:',
        context,
        '',
        'candidate_pool:',
        candidatePool,
        '',
        'observations:',
        observations
      ].join('\n')
    }
  ];
}

export function buildFinalPickMessages(input: BuildLoopMessagesInput): LlmMessage[] {
  const context = compactJson(input.context, MAX_CONTEXT_CHARS);
  const candidatePool = truncate(input.candidateSummary || '[]', MAX_CANDIDATE_CHARS);
  const targetPickCount = input.targetPickCount ?? 2;
  const observations = compactJson(input.observations.map((item) => ({
    tool: item.tool,
    summary: item.summary,
    candidateCount: item.candidateCount,
    problems: item.problems ?? []
  })), MAX_OBSERVATION_CHARS);

  return [
    {
      role: 'system',
      content: [
        '你是 Crossfadio 的最终选歌器。',
        '只输出严格 JSON，不要 Markdown、不要解释、不要额外文本。',
        ...(input.hardFinalOnlyRetry
          ? [
              '这是一次强制 final-only 重试；上一次 extra final 返回了 tool_call，已经被服务端拒绝。',
              '禁止输出 tool_call、tool、input 或任何非 final 字段；服务端只接受 type 为 final 的对象。'
            ]
          : []),
        '这次调用只能输出 {"type":"final","say":"...","picks":[{"id":"候选池ID","reason":"...","source":"liked|playlist|plan|search|style_expansion|trend"}],"rejected":[]}。',
        `picks 必须从候选池里选择 1 到 ${targetPickCount} 首；id 必须完全来自候选池；source 必须是对应候选的来源之一。`,
        '如果高质量候选不足，可以少选；不要为了凑数选择明显不适合当前队列的歌曲。',
        'reason 要说明为什么这首适合当前时刻、用户偏好或当前队列。',
        '不要请求更多信息，不要继续规划，不要输出候选池外的歌曲。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'compact_context:',
        context,
        '',
        'candidate_pool:',
        candidatePool,
        '',
        'observations:',
        observations
      ].join('\n')
    }
  ];
}

function compactJson(value: unknown, maxChars: number): string {
  return truncate(JSON.stringify(value), maxChars);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...<truncated>`;
}
