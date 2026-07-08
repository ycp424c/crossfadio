import { describe, expect, it } from 'vitest';
import { assembleMessages } from '../../src/server/agent/fragments';
import type { Fragments } from '../../src/server/agent/schema';

const base: Fragments = {
  mode: 'plan',
  system: 'You are a DJ.',
  corpus: {
    taste: 'Indie Pop / Dream Pop',
    routines: '9am: 上班通勤',
    moodRules: '深夜要安静',
    playlists: [
      { id: 'p1', name: '晨间清醒', provider: 'ncm', segments: ['morning'], tags: ['indie'], energyRange: [30, 60], priority: 1 }
    ],
    likedTracks: [
      { id: '101', name: 'Sweet Disposition', artist: 'The Temper Trap' }
    ]
  },
  env: {
    nowIso: '2026-04-24T09:00:00Z',
    localTime: '周四 09:00',
    weather: { tempC: 18, desc: '晴' },
    nowPlaying: { id: '123', name: 'Holocene', artist: 'Bon Iver', durationMs: 300000 }
  },
  memory: {
    recentPlays: [
      { id: 1, song_id: '1', song_name: 'Yesterday', artist_name: 'Beatles', started_at: '2026-04-23T20:00:00Z', ended_at: null, end_reason: null }
    ],
    recentChat: [{ role: 'user', content: '来一首安静的' }]
  },
  input: { kind: 'planRequest', date: '2026-04-24' },
  trace: { triggeredBy: 'scheduler', lastDecision: null }
};

describe('assembleMessages', () => {
  it('returns exactly 4 messages', () => {
    const msgs = assembleMessages(base);
    expect(msgs).toHaveLength(4);
  });

  it('first message is system role with system prompt', () => {
    const msgs = assembleMessages(base);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe('You are a DJ.');
  });

  it('second message contains corpus and env tags', () => {
    const msgs = assembleMessages(base);
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('<corpus>');
    expect(msgs[1].content).toContain('<env>');
    expect(msgs[1].content).toContain('18°C');
    expect(msgs[1].content).toContain('Holocene — Bon Iver');
    expect(msgs[1].content).toContain('晨间清醒');
    expect(msgs[1].content).toContain('<liked_tracks>');
    expect(msgs[1].content).toContain('Sweet Disposition — The Temper Trap');
  });

  it('third message contains memory tags with recent plays and chat', () => {
    const msgs = assembleMessages(base);
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toContain('<memory>');
    expect(msgs[2].content).toContain('Yesterday');
    expect(msgs[2].content).toContain('来一首安静的');
  });

  it('fourth message contains input and trace', () => {
    const msgs = assembleMessages(base);
    expect(msgs[3].role).toBe('user');
    expect(msgs[3].content).toContain('2026-04-24');
    expect(msgs[3].content).toContain('triggeredBy=scheduler');
  });

  it('handles chat input kind', () => {
    const f: Fragments = { ...base, mode: 'chat', input: { kind: 'chat', text: '换首安静的' } };
    const msgs = assembleMessages(f);
    expect(msgs[3].content).toContain('换首安静的');
  });

  it('handles segueTrigger input kind', () => {
    const f: Fragments = {
      ...base,
      mode: 'segue',
      input: { kind: 'segueTrigger', from: { id: 'a', name: 'Song A' }, to: { id: 'b', name: 'Song B' } }
    };
    const msgs = assembleMessages(f);
    expect(msgs[3].content).toContain('Song A');
    expect(msgs[3].content).toContain('Song B');
  });

  it('injects segue context details (lyrics and tags) when provided', () => {
    const f: Fragments = {
      ...base,
      mode: 'segue',
      input: {
        kind: 'segueTrigger',
        from: { id: 'a', name: 'Song A', artist: 'Artist A' },
        to: { id: 'b', name: 'Song B', artist: 'Artist B' },
        context: {
          from: {
            id: 'a',
            name: 'Song A',
            artist: 'Artist A',
            lyricExcerpt: '雨滴落在窗沿上',
            lyricKeywords: ['雨滴', '窗沿'],
            tags: ['流行', '伤感']
          },
          to: {
            id: 'b',
            name: 'Song B',
            artist: 'Artist B',
            lyricExcerpt: '太阳在地平线上升起',
            lyricKeywords: ['太阳', '地平线'],
            tags: ['电子', '治愈']
          }
        }
      }
    };

    const msgs = assembleMessages(f);
    expect(msgs[3].content).toContain('<segue_context>');
    expect(msgs[3].content).toContain('雨滴落在窗沿上');
    expect(msgs[3].content).toContain('电子 / 治愈');
  });

  it('renders selection rationale and personal segue guidance without source refs', () => {
    const f: Fragments = {
      ...base,
      mode: 'segue',
      input: {
        kind: 'segueTrigger',
        from: { id: 'a', name: 'Song A', artist: 'Artist A' },
        to: { id: 'b', name: 'Song B', artist: 'Artist B' },
        context: {
          from: {
            id: 'a',
            name: 'Song A',
            artist: 'Artist A',
            lyricExcerpt: '',
            lyricKeywords: [],
            tags: []
          },
          to: {
            id: 'b',
            name: 'Song B',
            artist: 'Artist B',
            lyricExcerpt: '',
            lyricKeywords: [],
            tags: []
          },
          selectionRationale: '这首歌承接刚才的低干扰节奏。',
          personalSegueGuidance: {
            summary: '当前在专注写代码。',
            tone: '克制、熟悉',
            privacyRule: '只说宽泛状态，不暴露原始记录。'
          }
        }
      }
    };

    const content = assembleMessages(f)[3].content;
    expect(content).toContain('<selection_rationale>这首歌承接刚才的低干扰节奏。</selection_rationale>');
    expect(content).toContain('<personal_segue_guidance>');
    expect(content).toContain('当前状态摘要：当前在专注写代码。');
    expect(content).toContain('口吻：克制、熟悉');
    expect(content).toContain('隐私规则：只说宽泛状态，不暴露原始记录。');
    expect(content).not.toContain('sliceRefs');
    expect(content).not.toContain('citationLabel');
  });

  it('renders weather as unknown when null', () => {
    const f: Fragments = { ...base, env: { ...base.env, weather: null } };
    const msgs = assembleMessages(f);
    expect(msgs[1].content).toContain('未知');
  });

  it('renders nowPlaying as 无 when null', () => {
    const f: Fragments = { ...base, env: { ...base.env, nowPlaying: null } };
    const msgs = assembleMessages(f);
    expect(msgs[1].content).toContain('无');
  });

  it('renders empty playlists gracefully', () => {
    const f: Fragments = { ...base, corpus: { ...base.corpus, playlists: [] } };
    const msgs = assembleMessages(f);
    expect(msgs[1].content).toContain('（无歌单）');
  });

  it('renders empty liked tracks gracefully', () => {
    const f: Fragments = { ...base, corpus: { ...base.corpus, likedTracks: [] } };
    const msgs = assembleMessages(f);
    expect(msgs[1].content).toContain('（暂无红心歌曲）');
  });

  it('renders extracted preferences in memory slice when provided', () => {
    const f: Fragments = { ...base, memory: { ...base.memory, extractedPreferences: '用户喜欢安静的indie风格' } };
    const msgs = assembleMessages(f);
    expect(msgs[2].content).toContain('<extracted_preferences>');
    expect(msgs[2].content).toContain('用户喜欢安静的indie风格');
  });

  it('renders fallback text when extracted preferences absent', () => {
    const msgs = assembleMessages(base);
    expect(msgs[2].content).toContain('（暂无提取的偏好记忆）');
  });
});
