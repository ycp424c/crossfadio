import { describe, expect, it } from 'vitest';
import {
  fragmentsSchema,
  agentOutputSchema,
  actionSchema,
  planOutputSchema,
  segueOutputSchema,
  chatOutputSchema
} from '../../src/server/agent/schema';

const baseFragments = {
  mode: 'plan' as const,
  system: 'You are a DJ.',
  corpus: { taste: 'indie', routines: 'morning work', moodRules: 'chill', playlists: [] },
  env: { nowIso: '2026-04-24T09:00:00Z', localTime: '周四 09:00', weather: null, nowPlaying: null },
  memory: { recentPlays: [], recentChat: [] },
  input: { kind: 'planRequest' as const, date: '2026-04-24' },
  trace: { triggeredBy: 'scheduler' as const, lastDecision: null }
};

describe('fragmentsSchema', () => {
  it('accepts a valid plan fragments object', () => {
    expect(fragmentsSchema.safeParse(baseFragments).success).toBe(true);
  });

  it('accepts chat input kind', () => {
    const f = { ...baseFragments, mode: 'chat' as const, input: { kind: 'chat' as const, text: 'Hello' } };
    expect(fragmentsSchema.safeParse(f).success).toBe(true);
  });

  it('accepts segueTrigger input kind', () => {
    const f = {
      ...baseFragments,
      mode: 'segue' as const,
      input: { kind: 'segueTrigger' as const, from: { id: '1' }, to: { id: '2' } }
    };
    expect(fragmentsSchema.safeParse(f).success).toBe(true);
  });

  it('rejects unknown mode', () => {
    expect(fragmentsSchema.safeParse({ ...baseFragments, mode: 'invalid' }).success).toBe(false);
  });

  it('rejects missing system field', () => {
    const { system: _, ...noSystem } = baseFragments;
    expect(fragmentsSchema.safeParse(noSystem).success).toBe(false);
  });
});

describe('planOutputSchema', () => {
  const validPlan = {
    mode: 'plan' as const,
    date: '2026-04-24',
    segments: [{
      id: 'morning' as const,
      label: '早晨',
      timeRange: '07:00-09:00',
      mood: '清醒',
      energyPct: 40,
      tracks: [{ query: 'Here Comes The Sun — The Beatles', reason: '清新开场' }]
    }],
    narrative: '今日电台以清醒开始'
  };

  it('accepts a valid plan output', () => {
    expect(planOutputSchema.safeParse(validPlan).success).toBe(true);
  });

  it('rejects energyPct > 100', () => {
    const bad = { ...validPlan, segments: [{ ...validPlan.segments[0], energyPct: 150 }] };
    expect(planOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects invalid segment id', () => {
    const bad = { ...validPlan, segments: [{ ...validPlan.segments[0], id: 'afternoon' }] };
    expect(planOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('segueOutputSchema', () => {
  const validSegue = {
    mode: 'segue' as const,
    say: '下一首来自 Bon Iver，像雪落下',
    duckingHintSec: 8,
    filterSweep: true,
    emotionTag: 'calm'
  };

  it('accepts a valid segue output', () => {
    expect(segueOutputSchema.safeParse(validSegue).success).toBe(true);
  });

  it('applies defaults for duckingHintSec and filterSweep', () => {
    const minimal = { mode: 'segue' as const, say: 'hi', emotionTag: 'upbeat' };
    const result = segueOutputSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duckingHintSec).toBe(8);
      expect(result.data.filterSweep).toBe(true);
    }
  });

  it('accepts longer segue script when context is rich', () => {
    const longSay =
      '前一首把雨夜的低频情绪铺得很满，下一首从副歌开始把光线推开，鼓点更稳、呼吸更近，像是从窗边走到街口，情绪并不突兀，而是顺着同一个心事慢慢抬升。';
    const result = segueOutputSchema.safeParse({
      ...validSegue,
      say: longSay
    });
    expect(result.success).toBe(true);
  });
});

describe('chatOutputSchema', () => {
  it('accepts a valid chat output with actions', () => {
    const valid = {
      mode: 'chat' as const,
      intent: 'adjust_queue' as const,
      say: '好的，已换上 Kendrick',
      actions: [{ type: 'skip' as const }]
    };
    expect(chatOutputSchema.safeParse(valid).success).toBe(true);
  });

  it('defaults actions to empty array', () => {
    const minimal = { mode: 'chat' as const, intent: 'chitchat' as const, say: 'Hi' };
    const result = chatOutputSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.actions).toEqual([]);
  });

  it('rejects unknown intent', () => {
    const bad = { mode: 'chat' as const, intent: 'unknown', say: 'hi' };
    expect(chatOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('actionSchema', () => {
  it('accepts swap_next', () => {
    expect(actionSchema.safeParse({ type: 'swap_next', pick: { query: 'Nils Frahm' } }).success).toBe(true);
  });

  it('accepts ban_artist', () => {
    expect(actionSchema.safeParse({ type: 'ban_artist', artist: 'Bad Artist' }).success).toBe(true);
  });

  it('accepts replan_segment with full hint', () => {
    const action = {
      type: 'replan_segment' as const,
      hint: { mood: 'energetic', bpmMin: 120, durationMin: 30, count: 5 }
    };
    expect(actionSchema.safeParse(action).success).toBe(true);
  });

  it('rejects unknown action type', () => {
    expect(actionSchema.safeParse({ type: 'teleport' }).success).toBe(false);
  });
});

describe('agentOutputSchema (discriminated union)', () => {
  it('routes plan mode', () => {
    const plan = {
      mode: 'plan' as const,
      date: '2026-04-24',
      segments: [],
      narrative: 'test'
    };
    const result = agentOutputSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('routes segue mode', () => {
    const segue = { mode: 'segue' as const, say: 'hi', emotionTag: 'calm' };
    expect(agentOutputSchema.safeParse(segue).success).toBe(true);
  });

  it('rejects object with no mode', () => {
    expect(agentOutputSchema.safeParse({ say: 'hi' }).success).toBe(false);
  });
});
