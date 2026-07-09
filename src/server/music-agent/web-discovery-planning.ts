import {
  defaultWebDiscoveryFreshness,
  defaultWebDiscoveryLocale,
  webDiscoveryIntentText
} from './web-discovery-hints.js';
import {
  webMusicDiscoveryInputSchema,
  type MusicAgentContextSummary,
  type QueryPlan,
  type WebMusicDiscoveryInput
} from './schema.js';

export const DEFAULT_WEB_DISCOVERY_HINT_LIMIT = 6;
export const AUTO_FILL_WEB_DISCOVERY_HINT_LIMIT = 8;
export const WEB_DISCOVERY_INTENT_MAX_CHARS = 360;
export const WEB_DISCOVERY_MAX_HINT_LIMIT = 12;

const WEB_DISCOVERY_STYLE_PATTERNS: Array<{ pattern: RegExp; style: string; priority: number }> = [
  { pattern: /janice\s*vidal|卫兰|my\s*cookie\s*can|就算世界无童话|cantopop|粤语流行|粤语|港乐|香港流行|广东歌/i, style: 'cantopop', priority: 40 },
  { pattern: /tanya\s*chua|蔡健雅|红色高跟鞋|mandopop|c[-\s]*pop|华语|中文|国语|mandarin/i, style: 'c-pop', priority: 30 },
  { pattern: /city\s*pop|城市流行/i, style: 'city pop', priority: 22 },
  { pattern: /indie\s*folk|独立民谣/i, style: 'indie folk', priority: 21 },
  { pattern: /folk|民谣/i, style: 'folk', priority: 18 },
  { pattern: /singer[-\s]*songwriter|唱作/i, style: 'singer-songwriter', priority: 17 },
  { pattern: /indie\s*pop|独立流行/i, style: 'indie pop', priority: 16 },
  { pattern: /dream\s*pop|梦幻流行/i, style: 'dream pop', priority: 15 },
  { pattern: /synth[-\s]*pop|合成器流行/i, style: 'synth pop', priority: 14 },
  { pattern: /neo\s*soul|新灵魂/i, style: 'neo soul', priority: 13 },
  { pattern: /r\s*&?\s*b|节奏布鲁斯/i, style: 'r&b', priority: 12 },
  { pattern: /jazz|爵士/i, style: 'jazz', priority: 11 },
  { pattern: /ambient|氛围/i, style: 'ambient', priority: 10 },
  { pattern: /downtempo|缓拍/i, style: 'downtempo', priority: 9 },
  { pattern: /alternative\s*rock|另类摇滚/i, style: 'alternative rock', priority: 8 },
  { pattern: /indie\s*rock|独立摇滚/i, style: 'indie rock', priority: 7 },
  { pattern: /j[-\s]*pop|日语|日系/i, style: 'j-pop', priority: 6 },
  { pattern: /k[-\s]*pop|韩语|韩系/i, style: 'k-pop', priority: 5 }
];

export function parseWebMusicDiscoveryInput(
  toolInput: Record<string, unknown>,
  input: { context: MusicAgentContextSummary; maxWebDiscoveryHints?: number }
): WebMusicDiscoveryInput {
  const intent = stringValue(toolInput.intent) || webDiscoveryIntentText(input.context) || 'music exploration';
  return webMusicDiscoveryInputSchema.parse({
    intent,
    focus: parseWebDiscoveryFocus(toolInput.focus, intent),
    anchors: objectArrayValue(toolInput.anchors),
    locale: stringValue(toolInput.locale) || defaultWebDiscoveryLocale(input.context),
    freshness: stringValue(toolInput.freshness) || defaultWebDiscoveryFreshness(intent),
    maxHints: boundedPositiveInt(
      toolInput.maxHints,
      input.maxWebDiscoveryHints ?? DEFAULT_WEB_DISCOVERY_HINT_LIMIT,
      WEB_DISCOVERY_MAX_HINT_LIMIT
    )
  });
}

export function parseWebDiscoveryFocus(value: unknown, intent: string): WebMusicDiscoveryInput['focus'] {
  const raw = stringValue(value);
  const allowed = new Set<WebMusicDiscoveryInput['focus']>([
    'style_artists',
    'style_tracks',
    'similar_artists',
    'similar_tracks',
    'new_releases',
    'scene_overview'
  ]);
  if (allowed.has(raw as WebMusicDiscoveryInput['focus'])) return raw as WebMusicDiscoveryInput['focus'];
  if (/新歌|新音乐|recent|new release|fresh/i.test(intent)) return 'new_releases';
  if (/类似|相似|similar|like/i.test(intent)) return 'similar_tracks';
  if (/歌手|artist|艺人/i.test(intent)) return 'style_artists';
  return 'scene_overview';
}

export function autoFillWebDiscoveryInput(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null
): Record<string, unknown> {
  const style = selectWebDiscoveryStyle(context, queryPlan);
  const intent = compactWebDiscoveryIntent(context, queryPlan, style);
  return {
    intent,
    focus: style ? 'style_artists' : 'scene_overview',
    anchors: style ? [{ type: 'style', name: style }] : [],
    locale: /[一-鿿]/.test(intent) ? 'zh-CN' : 'global',
    freshness: hasExplicitRecentWebIntent(context) ? 'recent' : 'durable',
    maxHints: AUTO_FILL_WEB_DISCOVERY_HINT_LIMIT
  };
}

export function selectWebDiscoveryStyle(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null
): string {
  const scores = new Map<string, { score: number; priority: number }>();
  const addText = (text: string, weight: number) => {
    if (!text) return;
    for (const item of WEB_DISCOVERY_STYLE_PATTERNS) {
      if (!item.pattern.test(text)) continue;
      const existing = scores.get(item.style) ?? { score: 0, priority: item.priority };
      scores.set(item.style, {
        score: existing.score + weight + item.priority / 100,
        priority: Math.max(existing.priority, item.priority)
      });
    }
  };

  addText([context.currentUserText, ...(context.actionQueries ?? []), context.activeDirective].join(' '), 100);
  addText([...(queryPlan?.exactTrackQueries ?? [])].join(' '), 95);
  addText([...(queryPlan?.artistAnchors ?? [])].join(' '), 90);
  addText([...(queryPlan?.playlistQueries ?? [])].join(' '), 75);
  addText([
    ...(queryPlan?.tasteAnchorQueries ?? []),
    ...(queryPlan?.explorationQueries ?? [])
  ].join(' '), 55);
  addText([...(queryPlan?.styleHints ?? []), ...(queryPlan?.listeningConstraints ?? [])].join(' '), 70);
  addText(context.recentPreferenceSummary, 25);
  addText(context.tasteSummary, 15);

  return [...scores.entries()]
    .sort((left, right) => {
      const scoreDelta = right[1].score - left[1].score;
      if (scoreDelta !== 0) return scoreDelta;
      return right[1].priority - left[1].priority;
    })[0]?.[0] ?? '';
}

export function compactWebDiscoveryIntent(
  context: MusicAgentContextSummary,
  queryPlan: QueryPlan | null,
  style: string
): string {
  const parts = uniqueStrings([
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective,
    style ? `style:${style}` : '',
    ...(queryPlan?.exactTrackQueries.slice(0, 3) ?? []),
    ...(queryPlan?.artistAnchors.slice(0, 3) ?? []),
    ...(queryPlan?.playlistQueries.slice(0, 2) ?? []),
    ...(queryPlan?.tasteAnchorQueries.slice(0, 2) ?? []),
    ...(queryPlan?.explorationQueries.slice(0, 2) ?? []),
    ...(queryPlan?.styleHints.slice(0, 4) ?? []),
    ...(queryPlan?.listeningConstraints.slice(0, 4) ?? [])
  ]);
  return truncate(parts.join(' | ') || style || 'music exploration', WEB_DISCOVERY_INTENT_MAX_CHARS);
}

export function hasExplicitRecentWebIntent(context: MusicAgentContextSummary): boolean {
  const text = [
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].join(' ');
  return /新歌|近期|最近|recent|new|fresh|release/i.test(text);
}

export function isExplicitWebExploreIntent(
  discoveryInput: WebMusicDiscoveryInput,
  context: MusicAgentContextSummary
): boolean {
  const text = [
    discoveryInput.intent,
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].join(' ');
  return (
    /探索|发现|找点|新歌|新音乐|类似|相似|小众|冷门|recent|new|discover|explore|similar|fresh|novelty/i.test(text) ||
    discoveryInput.focus === 'new_releases' ||
    discoveryInput.focus === 'similar_artists' ||
    discoveryInput.focus === 'similar_tracks'
  );
}

function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveInt(value, fallback), max);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...<truncated>`;
}
