import { describe, expect, it } from 'vitest';
import { buildLegacyStylePrompt } from '../../src/server/dj/legacyStylePrompt';

describe('Legacy DJ style prompt builder', () => {
  it('keeps time, weather, recent plays, theme, taste, and style instructions', () => {
    const prompt = buildLegacyStylePrompt({
      localTime: '2026-06-26 15:30（下午）',
      timeContextInstruction: '当前时间段是“下午”，所有时间判断都必须以这个时间段为准。',
      weatherText: '26°C，小雨',
      recentPlayNames: 'Song A — Artist A\nSong B — Artist B',
      dailyTheme: {
        theme: '雨后城市漫步',
        keywords: ['city pop', '雨天']
      },
      tasteContext: '\n## 个人品味锚点\n喜欢 City Pop\n',
      styleInstruction: '请根据以上信息，推荐 2-3 个适合当下情境的音乐风格方向。'
    });

    expect(prompt).toContain('当前时间：2026-06-26 15:30（下午）');
    expect(prompt).toContain('时间约束：当前时间段是“下午”，所有时间判断都必须以这个时间段为准。');
    expect(prompt).toContain('天气：26°C，小雨');
    expect(prompt).toContain('最近播放：\nSong A — Artist A\nSong B — Artist B');
    expect(prompt).toContain('今日主题：雨后城市漫步');
    expect(prompt).toContain('主题关键词：city pop、雨天');
    expect(prompt).toContain('## 个人品味锚点\n喜欢 City Pop');
    expect(prompt).toContain('请根据以上信息，推荐 2-3 个适合当下情境的音乐风格方向。');
    expect(prompt).toContain('对每个风格，列出 3-5 位可以在网易云音乐搜到的代表艺人');
    expect(prompt).toContain('"styles":[{"style":"indie folk"');
  });

  it('omits theme context when daily theme is unavailable', () => {
    const prompt = buildLegacyStylePrompt({
      localTime: '2026-06-26 09:05（上午）',
      timeContextInstruction: '当前时间段是“上午”。',
      weatherText: '未知',
      recentPlayNames: '',
      dailyTheme: null,
      tasteContext: '',
      styleInstruction: '请根据今日主题、时间、天气、最近播放和 DJ 偏好，推荐 2-3 个适合当下情境的音乐风格方向。'
    });

    expect(prompt).not.toContain('今日主题：');
    expect(prompt).not.toContain('主题关键词：');
    expect(prompt).toContain('天气：未知');
    expect(prompt).toContain('最近播放：\n');
    expect(prompt).toContain('请根据今日主题、时间、天气、最近播放和 DJ 偏好，推荐 2-3 个适合当下情境的音乐风格方向。');
  });
});
