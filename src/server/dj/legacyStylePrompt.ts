import type { DailyTheme } from '../daily-theme.js';

export type LegacyStylePromptInput = {
  localTime: string;
  timeContextInstruction: string;
  weatherText: string;
  recentPlayNames: string;
  dailyTheme?: Pick<DailyTheme, 'theme' | 'keywords'> | null;
  tasteContext: string;
  styleInstruction: string;
};

export function buildLegacyStylePrompt(input: LegacyStylePromptInput): string {
  const themeContext = input.dailyTheme
    ? `\n今日主题：${input.dailyTheme.theme}\n主题关键词：${input.dailyTheme.keywords.join('、')}\n`
    : '';

  return (
    `当前时间：${input.localTime}\n时间约束：${input.timeContextInstruction}\n天气：${input.weatherText}\n最近播放：\n${input.recentPlayNames}\n` +
    themeContext +
    input.tasteContext +
    `\n${input.styleInstruction}` +
    `对每个风格，列出 3-5 位可以在网易云音乐搜到的代表艺人（华人艺人和海外艺人各半，保证多样性）。` +
    `style 字段用英文关键词方便检索，artists 里同时包含中外艺人。` +
    `直接返回 JSON 对象，格式如下：\n` +
    `{"styles":[{"style":"indie folk","artists":["万能青年旅店","Bon Iver","张玮玮","Sufjan Stevens"]},` +
    `{"style":"jazz piano","artists":["Bill Evans","上原广美","Keith Jarrett","罗宁"]}]}`
  );
}
