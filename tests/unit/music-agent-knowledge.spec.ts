import { describe, expect, it } from 'vitest';
import { getMusicKnowledgeSlice } from '../../src/server/music-agent/knowledge.js';
import { musicKnowledgeSliceSchema } from '../../src/server/music-agent/schema.js';

describe('music-agent knowledge slice', () => {
  it('returns afternoon female-vocal quiet guidance for a soft afternoon request', () => {
    const slice = getMusicKnowledgeSlice({
      text: '下午想听女歌手，别太吵',
      daypart: '下午'
    });

    expect(slice.sceneRules.some((rule) => rule.includes('下午'))).toBe(true);
    expect(slice.queryTemplates.some((template) => template.includes('女声'))).toBe(true);
    expect(slice.negativeMappings.some((mapping) => mapping.includes('高能量'))).toBe(true);
  });

  it('expands City Pop female-vocal requests with nearby styles and Cantonese anchors', () => {
    const slice = getMusicKnowledgeSlice({
      text: 'City Pop 女声',
      daypart: '晚上'
    });
    const adjacency = slice.styleAdjacency.map((item) => item.toLowerCase());

    expect(adjacency.some((item) => item.includes('synth pop'))).toBe(true);
    expect(slice.styleAdjacency.some((item) => item.includes('粤语'))).toBe(true);
  });

  it('keeps generic recommendations compact', () => {
    const slice = getMusicKnowledgeSlice({
      text: '随便推荐几首',
      daypart: '下午'
    });

    expect(JSON.stringify(slice).length).toBeLessThan(3000);
  });

  it('returns evening scene guidance for generic evening requests and matches schema', () => {
    const slice = getMusicKnowledgeSlice({
      text: '随便推荐几首',
      daypart: '晚上'
    });

    expect(slice.sceneRules.length).toBeGreaterThan(0);
    expect(slice.queryTemplates.length).toBeGreaterThan(0);
    expect(musicKnowledgeSliceSchema.parse(slice)).toEqual(slice);
  });

  it('deduplicates arrays and always includes a small diversity rule set', () => {
    const slice = getMusicKnowledgeSlice({
      text: '下午 下午 city pop city pop 女声 女歌手 不要太吵 别太吵',
      daypart: '下午'
    });

    expect(new Set(slice.styleAdjacency).size).toBe(slice.styleAdjacency.length);
    expect(new Set(slice.queryTemplates).size).toBe(slice.queryTemplates.length);
    expect(new Set(slice.negativeMappings).size).toBe(slice.negativeMappings.length);
    expect(slice.diversityRules.length).toBeGreaterThan(0);
    expect(slice.diversityRules.length).toBeLessThanOrEqual(4);
  });

  it('uses imagery query templates instead of low-quality generic time terms', () => {
    const afternoon = getMusicKnowledgeSlice({
      text: '午后想听几首',
      daypart: '下午'
    });
    const lateNight = getMusicKnowledgeSlice({
      text: '深夜想听几首',
      daypart: '深夜'
    });
    const templates = [...afternoon.queryTemplates, ...lateNight.queryTemplates].join(' ');

    expect(templates).not.toMatch(/午后|深夜|夜里|凌晨/);
    expect(templates).toMatch(/天空|海洋|城市|星空|海面/);
  });
});
