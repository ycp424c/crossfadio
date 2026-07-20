import { describe, expect, it } from 'vitest';
import { assembleMessages } from '../../src/server/agent/fragments';
import { fragmentsSchema, type Fragments } from '../../src/server/agent/schema';

const base: Fragments = {
  mode: 'chat',
  system: 'You are a DJ.',
  djMemory: {
    schemaVersion: 1,
    snapshotId: 'snapshot-1',
    assembledAt: '2026-07-17T04:00:00.000Z',
    sources: [],
    purpose: 'chat',
    facts: [
      { key: 'current_track', value: ['Holocene', 'Bon Iver'], sourceId: 'queue' },
      { key: 'weather', value: '18°C 晴', sourceId: 'weather' },
      { key: 'taste_profile', value: 'Indie Pop / Dream Pop', sourceId: 'taste-1' }
    ]
  },
  input: { kind: 'chat', text: '今天来点清新的' },
  trace: { triggeredBy: 'user', lastDecision: null }
};

describe('assembleMessages', () => {
  it('accepts only one purpose-scoped shared DJ Memory projection', () => {
    const msgs = assembleMessages(base);

    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are a DJ.' });
    expect(msgs[1]?.content).toContain('<dj_memory purpose="chat">');
    expect(msgs[1]?.content).toContain('snapshot-1');
    expect(msgs[1]?.content).toContain('Holocene');
    expect(msgs[1]?.content).not.toContain('<corpus>');
    expect(msgs[1]?.content).not.toContain('<env>');
    expect(msgs[1]?.content).not.toContain('<memory>');
    expect(msgs[2]?.content).toContain('今天来点清新的');
    expect(msgs[2]?.content).toContain('triggeredBy=user');
  });

  it('rejects old free-text corpus/env/memory inputs and mismatched purpose', () => {
    expect(fragmentsSchema.safeParse({
      ...base,
      corpus: { taste: 'legacy' },
      env: { localTime: 'legacy' },
      memory: { recentChat: [] }
    }).success).toBe(false);
    expect(fragmentsSchema.safeParse({
      ...base,
      djMemory: { ...base.djMemory, purpose: 'segue' }
    }).success).toBe(false);
  });

  it('keeps track evidence in segue input while memory guidance comes from the segue projection', () => {
    const fragments: Fragments = {
      mode: 'segue',
      system: 'You are a discreet DJ.',
      djMemory: {
        schemaVersion: 1,
        snapshotId: 'snapshot-2',
        assembledAt: '2026-07-17T04:00:00.000Z',
        sources: [],
        purpose: 'segue',
        facts: [
          { key: 'segue_tone', value: '克制、熟悉', sourceId: 'pdc-1' },
          { key: 'segue_privacy_rule', value: '只说宽泛状态', sourceId: 'pdc-1' },
          { key: 'session_continuity', value: '承接低干扰节奏', sourceId: 'selection-1' }
        ]
      },
      input: {
        kind: 'segueTrigger',
        from: { id: 'a', name: 'Song A', artist: 'Artist A' },
        to: { id: 'b', name: 'Song B', artist: 'Artist B' },
        context: {
          from: {
            id: 'a', name: 'Song A', artist: 'Artist A',
            lyricExcerpt: '雨滴落在窗沿上', lyricKeywords: ['雨滴'], tags: ['伤感']
          },
          to: {
            id: 'b', name: 'Song B', artist: 'Artist B',
            lyricExcerpt: '太阳升起', lyricKeywords: ['太阳'], tags: ['治愈']
          },
          selectionRationale: '承接低干扰节奏。'
        }
      },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    const msgs = assembleMessages(fragments);
    expect(msgs[1]?.content).toContain('segue_privacy_rule');
    expect(msgs[2]?.content).toContain('<segue_context>');
    expect(msgs[2]?.content).toContain('雨滴落在窗沿上');
    expect(msgs[2]?.content).toContain('<selection_rationale>承接低干扰节奏。</selection_rationale>');
    expect(msgs[2]?.content).not.toContain('<personal_segue_guidance>');
  });
});
