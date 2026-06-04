import { musicKnowledgeZhCN } from './data/music-knowledge.zh-CN.js';
import type { MusicKnowledgeSlice } from './schema.js';

export type KnowledgeRequest = {
  text: string;
  daypart: string;
};

const STYLE_ADJACENCY_LIMIT = 6;
const QUERY_TEMPLATE_LIMIT = 10;
const NEGATIVE_MAPPING_LIMIT = 6;
const DIVERSITY_RULE_LIMIT = 4;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesAny(text: string, aliases: string[]): boolean {
  return aliases.some((alias) => text.includes(normalize(alias)));
}

function uniqueLimited(items: string[], limit: number): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0))).slice(0, limit);
}

export function getMusicKnowledgeSlice(request: KnowledgeRequest): MusicKnowledgeSlice {
  const text = normalize(`${request.text} ${request.daypart}`);
  const styleAdjacency: string[] = [];
  const sceneRules: string[] = [];
  const queryTemplates: string[] = [];
  const negativeMappings: string[] = [];

  for (const entry of musicKnowledgeZhCN.styleGraph) {
    if (includesAny(text, [entry.style, ...entry.aliases])) {
      styleAdjacency.push(...entry.adjacent);
    }
  }

  for (const scene of musicKnowledgeZhCN.sceneProfiles) {
    if (includesAny(text, [scene.scene, ...scene.aliases])) {
      sceneRules.push(...scene.rules);
      queryTemplates.push(...scene.queryTemplates);
    }
  }

  for (const group of musicKnowledgeZhCN.queryTemplates) {
    if (includesAny(text, group.aliases)) {
      queryTemplates.push(...group.templates);
    }
  }

  for (const mapping of musicKnowledgeZhCN.negativeMappings) {
    if (includesAny(text, mapping.aliases)) {
      negativeMappings.push(...mapping.mappings);
    }
  }

  return {
    styleAdjacency: uniqueLimited(styleAdjacency, STYLE_ADJACENCY_LIMIT),
    sceneRules: uniqueLimited(sceneRules, 4),
    queryTemplates: uniqueLimited(queryTemplates, QUERY_TEMPLATE_LIMIT),
    diversityRules: uniqueLimited(musicKnowledgeZhCN.diversityRules, DIVERSITY_RULE_LIMIT),
    negativeMappings: uniqueLimited(negativeMappings, NEGATIVE_MAPPING_LIMIT)
  };
}
