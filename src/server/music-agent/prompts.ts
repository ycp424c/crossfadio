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
const MAX_OBSERVATION_CHARS = 4_000;

export const FINAL_PICK_RESPONSE_FORMAT: LlmResponseFormat = { type: 'json_object' };

export function buildLoopMessages(input: BuildLoopMessagesInput): LlmMessage[] {
  const context = compactJson(input.context, MAX_CONTEXT_CHARS);
  const candidatePool = truncate(input.candidateSummary || '[]', MAX_CANDIDATE_CHARS);
  const targetPickCount = input.targetPickCount ?? 2;
  const observations = compactJson(input.observations.map((item) => ({
    tool: item.tool,
    summary: item.summary,
    candidateCount: item.candidateCount,
    problems: item.problems ?? [],
    data: item.data
  })), MAX_OBSERVATION_CHARS);

  return [
    {
      role: 'system',
      content: [
        '你是 Crossfadio 的 bounded music-agent tool-loop 控制器。',
        '只输出严格 JSON，不要 Markdown、不要解释、不要额外文本。',
        `可调用工具白名单：${TOOL_WHITELIST}。`,
        '输出 tool_call 时格式为 {"type":"tool_call","tool":"工具名","input":{...}}。',
        '输出 final 时格式为 {"type":"final","say":"...","picks":[{"id":"候选池ID","reason":"...","source":"liked|playlist|search|style_expansion|trend"}],"rejected":[]}。',
        'final picks 的 id 必须来自候选池；不能选择候选池外的歌曲。',
        'activeDirective/current chat 必须优先于趋势、榜单、泛化流行度。',
        'recentArtistPenalties 中 penalty 较高的歌手需要先在 expand_queries 阶段放入 avoidArtists，并用相邻风格、不同艺人或具体曲目实体扩展召回。',
        'recentTrackPenalties 是同一首歌的长周期重复惩罚；penalty 高的候选除非明显最贴合，否则应优先让位给相邻风格的新候选。',
        'NCM song search 只适合精确召回：recall_from_ncm_search 只能使用具体歌名+艺人、榜单曲目或高置信曲目实体；不要把 mood、场景、风格、人声、能量词直接作为 song search query。',
        'expand_queries 应把具体曲目实体放入 exactTrackQueries，把具体艺人放入 artistAnchors，把具体专辑放入 albumAnchors，把风格/语言/场景适合的歌单搜索入口放入 playlistQueries；不要把这些实体混成一条 song search query。',
        '风格、地区、年代、人声、能量、编曲质感应放入 styleHints/listeningConstraints；这些语义线索用于实体发现和排序，不是直接搜索词。',
        '当你已经有具体 track/artist/album/playlist 实体假设时，调用 recall_from_entities 让服务端先用 NCM 校验再入池；不要把未经校验的实体直接写进 final。',
        '探索模式且本地召回仍稀疏时，可以调用 web_music_discovery 获取带来源的 Music Entity Hints；它不会产生候选，下一步必须把高置信 hints 交给 recall_from_entities 校验后才能入池。',
        '探索模式下，recall_from_liked 只能在 recall_auto_fill_mix / recall_from_entities / recall_from_ncm_search 等外部召回已经尝试后用于补尾；不要把红心作为第一召回来源。',
        '知识库和 sourceStyleSeeds 只是参考，不是固定模板；不要逐字照抄整组模板去搜 NCM，候选不足时优先找具体曲目/艺人/榜单/歌单线索。',
        '如果 observations 提示查询被历史重排或重复惩罚，优先换 fresh query，不要继续围绕同一个低质查询变体搜索。',
        '不要编造 NCM id；如果候选池不足，先调用白名单工具补候选。',
        `final picks 最多选择 ${targetPickCount} 首；候选池数量达到或超过目标数量时，必须尽量返回 ${targetPickCount} 首。`,
        `如果少于 ${targetPickCount} 首，必须在 rejected 里为每个缺口说明原因；不要为了凑数选择明显不合适的歌。`,
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
  const selectionNotes = compactJson(input.observations.map((item) => ({
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
              '这是一次强制最终选歌重试；上一轮输出不是 final，已经被服务端拒绝。',
              '服务端只接受顶层 type 为 final 的对象；不要输出请求下一步动作的字段。'
            ]
          : []),
        '这次调用只能输出 {"type":"final","say":"...","picks":[{"id":"候选池ID","reason":"...","source":"liked|playlist|search|style_expansion|trend"}],"rejected":[]}。',
        `picks 必须从候选池里选择 1 到 ${targetPickCount} 首；id 必须完全来自候选池；source 必须是对应候选的来源之一。`,
        `候选池数量达到或超过目标数量时，必须尽量返回 ${targetPickCount} 首。`,
        `如果少于 ${targetPickCount} 首，必须在 rejected 里为每个缺口说明原因；不要为了凑数选择明显不适合当前队列的歌曲。`,
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
        'selection_notes:',
        selectionNotes
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
