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
});
