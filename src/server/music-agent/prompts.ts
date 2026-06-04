import type { LlmMessage } from '../llm/client.js';
import { musicAgentToolNameSchema, type MusicAgentContextSummary } from './schema.js';
import type { ToolObservation } from './tools.js';

type LoopObservation = ToolObservation & {
  tool?: string;
};

export type BuildLoopMessagesInput = {
  context: MusicAgentContextSummary;
  observations: LoopObservation[];
  candidateSummary: string;
};

const TOOL_WHITELIST = musicAgentToolNameSchema.options.join(', ');
const MAX_CONTEXT_CHARS = 1_800;
const MAX_CANDIDATE_CHARS = 2_400;
const MAX_OBSERVATION_CHARS = 2_000;

export function buildLoopMessages(input: BuildLoopMessagesInput): LlmMessage[] {
  const context = compactJson(input.context, MAX_CONTEXT_CHARS);
  const candidatePool = truncate(input.candidateSummary || '[]', MAX_CANDIDATE_CHARS);
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
        '不要编造 NCM id；如果候选池不足，先调用白名单工具补候选。'
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
