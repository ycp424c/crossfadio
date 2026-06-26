import { describe, expect, it } from 'vitest';
import { buildLegacyPickPrompt } from '../../src/server/dj/legacyPickPrompt';

describe('Legacy DJ pick prompt builder', () => {
  it('keeps comfort mode theme, directive, taste, time, and target count context', () => {
    const { systemPrompt, userPrompt } = buildLegacyPickPrompt({
      djPersona: '你是 Crossfadio 的夜间 DJ。',
      dailyTheme: { theme: '雨后城市漫步' },
      activeDirective: '多放一些 City Pop，不要太吵。',
      tasteHints: ['喜欢 Tatsuro Yamashita', '偏好轻快合成器'],
      discoveryMode: 'comfort',
      modePrompt: {
        pickInstruction: '优先选择符合用户品味偏好的歌曲，同时兼顾当前时间。',
        userContextLabel: '用户品味偏好：喜欢 Tatsuro Yamashita；偏好轻快合成器\n'
      },
      timeContext: {
        sayInstruction: 'say 字段必须与当前时间一致：当前时间段是“下午”。'
      },
      localTime: '2026-06-26 15:30（下午）',
      weatherText: '26°C，小雨',
      candidateList: '1. id=101 Ride on Time — Tatsuro Yamashita',
      candidateCount: 12,
      targetPickCount: 3
    });

    expect(systemPrompt).toContain('你是 Crossfadio 的夜间 DJ。');
    expect(systemPrompt).toContain('## 今日主题\n雨后城市漫步');
    expect(systemPrompt).toContain('## 必须优先遵循的短期选歌指令\n多放一些 City Pop，不要太吵。');
    expect(systemPrompt).toContain('## 用户品味偏好\n喜欢 Tatsuro Yamashita\n偏好轻快合成器');
    expect(systemPrompt).toContain('优先选择符合用户品味偏好的歌曲，同时兼顾当前时间。');
    expect(systemPrompt).toContain('say 字段必须与当前时间一致：当前时间段是“下午”。');

    expect(userPrompt).toContain('当前时间：2026-06-26 15:30（下午）');
    expect(userPrompt).toContain('天气：26°C，小雨');
    expect(userPrompt).toContain('模式：舒适区模式');
    expect(userPrompt).toContain('今日主题：雨后城市漫步');
    expect(userPrompt).toContain('短期选歌指令：多放一些 City Pop，不要太吵。');
    expect(userPrompt).toContain('用户品味偏好：喜欢 Tatsuro Yamashita；偏好轻快合成器');
    expect(userPrompt).toContain('<候选歌曲列表>\n1. id=101 Ride on Time — Tatsuro Yamashita\n</候选歌曲列表>');
    expect(userPrompt).toContain('从以上 12 首候选歌曲中挑选最多 3 首');
  });

  it('uses the default persona and no taste header when explore mode has no taste hints', () => {
    const { systemPrompt, userPrompt } = buildLegacyPickPrompt({
      dailyTheme: null,
      activeDirective: '',
      tasteHints: [],
      discoveryMode: 'explore',
      modePrompt: {
        pickInstruction: '从候选歌曲列表中挑选最适合当前情境的 2 首，返回它们的候选歌曲 id。',
        userContextLabel: ''
      },
      timeContext: {
        sayInstruction: 'say 字段必须与当前时间一致：当前时间段是“上午”。'
      },
      localTime: '2026-06-26 09:05（上午）',
      weatherText: '未知',
      candidateList: '1. id=202 Unknown Song — Fresh Artist',
      candidateCount: 4,
      targetPickCount: 2
    });

    expect(systemPrompt).toContain('You are a DJ.');
    expect(systemPrompt).toContain('从候选歌曲列表中挑选最适合当前情境的 2 首，返回它们的候选歌曲 id。');
    expect(systemPrompt).not.toContain('## 用户品味偏好');
    expect(systemPrompt).not.toContain('## 探索外延参考');
    expect(userPrompt).toContain('模式：探索模式');
    expect(userPrompt).not.toContain('今日主题：');
    expect(userPrompt).not.toContain('短期选歌指令：');
    expect(userPrompt).toContain('从以上 4 首候选歌曲中挑选最多 2 首');
  });
});
