import { getMusicKnowledgeSlice } from './knowledge.js';
import { normalizeSearchQuery } from './query-stats.js';
import type { MusicAgentContextSummary, QueryPlan } from './schema.js';

const EXPLORE_AUTO_FILL_MAX_EXACT_SEARCH_QUERIES = 2;

export function autoFillSearchQueries(context: MusicAgentContextSummary, queryPlan: QueryPlan): string[] {
  const exactTrackQueries = isExploreAutoFillContext(context)
    ? queryPlan.exactTrackQueries.slice(0, EXPLORE_AUTO_FILL_MAX_EXACT_SEARCH_QUERIES)
    : queryPlan.exactTrackQueries;
  return uniqueStrings([
    ...(context.actionQueries ?? []),
    ...exactTrackQueries,
    ...queryPlan.intentQueries,
    ...queryPlan.tasteAnchorQueries,
    ...queryPlan.planQueries,
    ...queryPlan.explorationQueries
  ]).slice(0, 8);
}

export function isExploreAutoFillContext(context: MusicAgentContextSummary): boolean {
  return context.request === 'auto-fill' && context.discoveryMode !== 'comfort';
}

export function styleExpansionQueries(context: MusicAgentContextSummary, toolInput: Record<string, unknown>): string[] {
  const explicitQueries = stringArrayValue(toolInput.queries);
  const excludedQueries = new Set(stringArrayValue(toolInput.excludeQueries).map(normalizeSearchQuery));
  const text = [
    stringValue(toolInput.text),
    stringValue(toolInput.userText),
    ...explicitQueries,
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].filter(Boolean).join(' ');
  const knowledge = getMusicKnowledgeSlice({
    text,
    daypart: context.currentMoment.daypart
  });
  const seedQueries = sourceStyleSeedQueries(knowledge.sourceStyleSeeds, text);
  const fallbackQueries = explicitQueries.length > 0
    ? [...seedQueries, ...knowledge.styleAdjacency]
    : [...seedQueries, ...knowledge.styleAdjacency, ...knowledge.queryTemplates.slice(0, 2)];
  return uniqueStrings([
    ...explicitQueries,
    ...fallbackQueries
  ])
    .filter((query) => !excludedQueries.has(normalizeSearchQuery(query)))
    .slice(0, 8);
}

export function sourceStyleSeedQueries(styleSeeds: string[], text: string): string[] {
  const modifiers = styleSeedQueryModifiers(text);
  return uniqueStrings(styleSeeds.flatMap((style) => modifiers.map((modifier) => `${style} ${modifier}`)));
}

export function styleSeedQueryModifiers(text: string): string[] {
  const normalized = text.toLowerCase();
  const modifiers: string[] = [];
  if (/rock|摇滚|乐队|guitar|吉他/.test(normalized)) modifiers.push('乐队');
  if (/电子|electronic|synth|合成器/.test(normalized)) modifiers.push('synth');
  if (/女声|女歌手|女生唱|female vocal|female-vocal/.test(normalized)) modifiers.push('女声');
  if (/粤语|港乐|广东歌|cantonese/.test(normalized)) modifiers.push('粤语');
  if (/华语|中文|mandarin/.test(normalized)) modifiers.push('华语');
  if (/别太吵|不要太吵|不吵|安静|轻一点|轻松|quiet|chill/.test(normalized)) modifiers.push('不吵');
  if (/专注|工作|学习|focus|少人声|低人声/.test(normalized)) modifiers.push('低人声');
  if (/跑步|运动|running|workout|高能量|提神/.test(normalized)) modifiers.push('律动');
  return uniqueStrings(modifiers.length > 0 ? modifiers : ['中低能量']);
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
