import { describe, expect, it } from 'vitest';
import {
  candidateSourceSchema,
  musicAgentLoopOutputSchema,
  musicAgentToolNameSchema,
  musicCandidateSchema,
  musicAgentFinalOutputSchema
} from '../../src/server/music-agent/schema';

describe('music-agent schema', () => {
  it('accepts all first-version tool names', () => {
    expect(musicAgentToolNameSchema.parse('get_context_summary')).toBe('get_context_summary');
    expect(musicAgentToolNameSchema.parse('get_music_knowledge')).toBe('get_music_knowledge');
    expect(musicAgentToolNameSchema.parse('get_trend_context')).toBe('get_trend_context');
    expect(musicAgentToolNameSchema.parse('expand_queries')).toBe('expand_queries');
    expect(musicAgentToolNameSchema.parse('recall_from_liked')).toBe('recall_from_liked');
    expect(musicAgentToolNameSchema.parse('recall_from_playlists')).toBe('recall_from_playlists');
    expect(musicAgentToolNameSchema.parse('recall_from_plan_segment')).toBe('recall_from_plan_segment');
    expect(musicAgentToolNameSchema.parse('recall_from_ncm_search')).toBe('recall_from_ncm_search');
    expect(musicAgentToolNameSchema.parse('recall_from_trending')).toBe('recall_from_trending');
    expect(musicAgentToolNameSchema.parse('recall_from_style_expansion')).toBe('recall_from_style_expansion');
    expect(musicAgentToolNameSchema.parse('rank_candidates')).toBe('rank_candidates');
    expect(musicAgentToolNameSchema.parse('diversify_candidates')).toBe('diversify_candidates');
    expect(musicAgentToolNameSchema.parse('finalize_pick')).toBe('finalize_pick');
  });

  it('rejects unknown tools', () => {
    expect(() => musicAgentToolNameSchema.parse('write_database')).toThrow();
  });

  it('accepts trend as a candidate source', () => {
    expect(candidateSourceSchema.parse('trend')).toBe('trend');
  });

  it('validates a candidate with sources, evidence, and scores', () => {
    const candidate = musicCandidateSchema.parse({
      id: '101',
      name: 'Soft Song',
      artist: 'Singer',
      sources: ['liked', 'trend'],
      evidence: ['用户红心歌曲', '近期热搜关联'],
      scores: {
        intentMatch: 0.8,
        tasteMatch: 0.7,
        timeFit: 0.6,
        planFit: 0.5,
        novelty: 0.4,
        recentPenalty: 0,
        skipPenalty: 0,
        sourceConfidence: 0.7
      }
    });

    expect(candidate.id).toBe('101');
    expect(candidate.sources).toContain('trend');
  });

  it('validates tool_call and final loop outputs', () => {
    expect(musicAgentLoopOutputSchema.parse({
      type: 'tool_call',
      tool: 'rank_candidates',
      input: { limit: 20 }
    }).type).toBe('tool_call');

    const output = musicAgentLoopOutputSchema.parse({
      type: 'final',
      say: '这两首更适合现在的下午状态。',
      picks: [{ id: '101', reason: '女声且能量适中', source: 'trend' }],
      rejected: [{ id: '202', reason: '最近刚播过同艺人' }]
    });

    expect(output.type).toBe('final');
  });

  it('validates final MusicAgent output', () => {
    const finalOutput = musicAgentFinalOutputSchema.parse({
      mode: 'pick_next',
      say: '补两首轻一点的。',
      picks: [{ id: '101', name: 'Soft Song', artist: 'Singer', reason: '符合下午低能量', source: 'liked' }],
      rejected: [],
      trace: [{ step: 1, thoughtSummary: '需要女声候选', candidateCount: 1, elapsedMs: 20 }]
    });

    expect(finalOutput.mode).toBe('pick_next');
    expect(finalOutput.picks[0].source).toBe('liked');
  });
});
