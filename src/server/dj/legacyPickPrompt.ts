import type { DiscoveryMode } from '../../shared/dj.js';

type LegacyPickModePrompt = {
  pickInstruction: string;
  userContextLabel: string;
};

type LegacyPickTimeContext = {
  sayInstruction: string;
};

export type LegacyPickPromptInput = {
  djPersona?: string | null;
  dailyTheme?: { theme: string } | null;
  activeDirective: string;
  tasteHints: string[];
  discoveryMode: DiscoveryMode;
  modePrompt: LegacyPickModePrompt;
  timeContext: LegacyPickTimeContext;
  localTime: string;
  weatherText: string;
  candidateList: string;
  candidateCount: number;
  targetPickCount: number;
};

export type LegacyPickPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

export function buildLegacyPickPrompt(input: LegacyPickPromptInput): LegacyPickPrompt {
  const themePickNote = input.dailyTheme
    ? `\n## 今日主题\n${input.dailyTheme.theme}\n\n选曲时可以优先考虑契合今日主题氛围的歌曲，但不必强求。主题只是参考方向。\n`
    : '';

  const systemPrompt = `${input.djPersona || 'You are a DJ.'}

## 当前任务：DJ 自动选曲
${themePickNote}
${input.activeDirective ? `## 必须优先遵循的短期选歌指令\n${input.activeDirective}\n\n如果候选池里有符合该指令的歌曲，应优先选择；只有候选池明显不足时才放宽。\n\n` : ''}${input.tasteHints.length > 0 ? `## ${getDiscoveryModeTasteHeading(input.discoveryMode)}\n${input.tasteHints.join('\n')}\n\n${input.modePrompt.pickInstruction}\n\n` : ''}${input.tasteHints.length === 0 ? input.modePrompt.pickInstruction : ''}
不要重复最近刚播过的歌曲。say 字段用一句话中文说明选曲理由。
${input.timeContext.sayInstruction}
优先选择艺人名像真实人名或乐队的歌曲，避开艺人名明显是厂牌、合集、影视原声、或自动生成的选项（如"群星""Various Artists""佚名""原声带"等）。
只能返回候选歌曲列表中真实存在的 id，不要编造 id，不要返回歌名搜索词。

输出格式：严格 JSON，不要包裹 markdown 代码块。
{
  "say": "选曲理由（一句话中文）",
  "picks": [
    { "id": "候选歌曲id1", "reason": "为什么这首歌适合当前时段/主题/用户品味（一句话中文）" },
    { "id": "候选歌曲id2", "reason": "为什么这首歌适合当前时段/主题/用户品味（一句话中文）" }
  ]
}`;

  const themeContextUser = input.dailyTheme
    ? `今日主题：${input.dailyTheme.theme}\n`
    : '';
  const directiveUserContext = input.activeDirective
    ? `短期选歌指令：${input.activeDirective}\n`
    : '';

  const userPrompt = `<context>
当前时间：${input.localTime}
天气：${input.weatherText}
模式：${getDiscoveryModeLabel(input.discoveryMode)}
${themeContextUser}${directiveUserContext}${input.modePrompt.userContextLabel}</context>

<候选歌曲列表>
${input.candidateList}
</候选歌曲列表>

从以上 ${input.candidateCount} 首候选歌曲中挑选最多 ${input.targetPickCount} 首；如果高质量候选不足，可以少选，不要为了凑数选择明显不适合的歌曲。`;

  return { systemPrompt, userPrompt };
}

function getDiscoveryModeTasteHeading(mode: DiscoveryMode): string {
  if (mode === 'comfort') return '用户品味偏好';
  if (mode === 'legacy') return 'Legacy LLM 参考';
  return '探索外延参考';
}

function getDiscoveryModeLabel(mode: DiscoveryMode): string {
  if (mode === 'comfort') return '舒适区模式';
  if (mode === 'legacy') return 'Legacy LLM 模式';
  return '探索模式';
}
