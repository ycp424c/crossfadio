import type { NcmLyric } from '../../shared/schema.js';
import { cleanLyricLines } from '../music-agent/lyric-evidence.js';
import type { SegueTrackContext, Track } from './schema.js';

type SongDetailLike = {
  id: number | string;
  name: string;
  artists: string[];
};

type BuildSegueTrackContextInput = {
  track: Track;
  detail?: SongDetailLike | null;
  lyric?: NcmLyric | null;
  wikiSummary?: unknown;
};

const TAG_HINT_RE = /(tag|style|genre|label|标签|曲风|风格|流派|分类)/i;
const TAG_PATTERN_MAP: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: '说唱', patterns: [/\bhip[\s-]?hop\b/i, /\brap\b/i, /说唱|嘻哈/u] },
  { tag: '摇滚', patterns: [/\brock\b/i, /\bmetal\b/i, /摇滚|朋克/u] },
  { tag: '电子', patterns: [/\belectronic\b/i, /\bedm\b/i, /\btechno\b/i, /\bhouse\b/i, /电子|电音/u] },
  { tag: '流行', patterns: [/\bpop\b/i, /流行/u] },
  { tag: '民谣', patterns: [/\bfolk\b/i, /民谣/u] },
  { tag: 'R&B', patterns: [/\br&b\b/i, /\brnb\b/i, /灵魂乐/u] },
  { tag: '爵士', patterns: [/\bjazz\b/i, /爵士/u] },
  { tag: '古典', patterns: [/\bclassical\b/i, /古典|交响/u] },
  { tag: '舞曲', patterns: [/\bdance\b/i, /\bparty\b/i, /\bclub\b/i, /舞动|蹦迪/u] },
  { tag: '氛围', patterns: [/\bambient\b/i, /\batmosphere\b/i, /氛围|梦境|星空|夜色/u] },
  { tag: '伤感', patterns: [/\bsad\b/i, /\blonely\b/i, /\btears?\b/i, /孤独|离别|心碎|落泪/u] },
  { tag: '治愈', patterns: [/\bwarm\b/i, /\bhope\b/i, /\bsun\b/i, /治愈|温柔|微光|拥抱/u] }
];
const EN_STOPWORDS = new Set([
  'the',
  'and',
  'you',
  'your',
  'with',
  'that',
  'this',
  'from',
  'into',
  'over',
  'under',
  'when',
  'where',
  'what',
  'will',
  'just',
  'dont',
  'cant',
  'wont',
  'yeah',
  'baby',
  'love'
]);
const ZH_STOPWORDS = new Set([
  '我们',
  '你们',
  '他们',
  '自己',
  '不是',
  '没有',
  '如果',
  '然后',
  '只是',
  '还是',
  '一个',
  '时候',
  '已经',
  '因为',
  '所以',
  '这里',
  '那里'
]);

export function buildSegueTrackContext(input: BuildSegueTrackContextInput): SegueTrackContext {
  const id = input.track.id;
  const name = normalizeText(input.detail?.name) || normalizeText(input.track.name) || id;
  const artist =
    normalizeText(input.detail?.artists?.filter(Boolean).join(' / ')) || normalizeText(input.track.artist) || '未知艺人';
  const lyricExcerpt = extractLyricExcerpt(input.lyric);
  const lyricKeywords = extractLyricKeywords(input.lyric);

  const wikiTags = extractTagsFromWikiSummary(input.wikiSummary);
  const inferredTags = inferTagsFromText({
    name,
    artist,
    lyric: input.lyric?.lyric ?? '',
    translation: input.lyric?.translation ?? ''
  });
  const tags = uniqueStrings([...wikiTags, ...inferredTags]).slice(0, 8);

  return {
    id,
    name,
    artist,
    lyricExcerpt,
    lyricKeywords,
    tags
  };
}

export function extractTagsFromWikiSummary(wikiSummary: unknown): string[] {
  const tags = new Set<string>();

  walkWikiNode(wikiSummary, false, tags);

  return [...tags].slice(0, 8);
}

function walkWikiNode(node: unknown, tagHint: boolean, output: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkWikiNode(item, tagHint, output);
    }
    return;
  }

  if (typeof node === 'string') {
    if (tagHint) {
      maybeAddTag(output, node);
    }
    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  for (const [rawKey, value] of Object.entries(node)) {
    const key = rawKey.trim();
    const nextHint = tagHint || TAG_HINT_RE.test(key);

    if (typeof value === 'string') {
      if (nextHint || (tagHint && /^(name|title)$/i.test(key))) {
        maybeAddTag(output, value);
      }
      continue;
    }

    walkWikiNode(value, nextHint, output);
  }
}

function inferTagsFromText(input: {
  name: string;
  artist: string;
  lyric: string;
  translation: string;
}): string[] {
  const source = `${input.name}\n${input.artist}\n${normalizeLyric(input.lyric)}\n${normalizeLyric(input.translation)}`;
  const tags: string[] = [];

  for (const candidate of TAG_PATTERN_MAP) {
    if (candidate.patterns.some((pattern) => pattern.test(source))) {
      tags.push(candidate.tag);
    }
  }

  return uniqueStrings(tags).slice(0, 6);
}

function extractLyricExcerpt(lyric: NcmLyric | null | undefined): string {
  if (!lyric?.lyric) {
    return '';
  }

  const lines = cleanLyricLines(lyric.lyric, { preserveFiller: true });
  if (lines.length === 0) {
    return '';
  }

  const excerpt = lines.slice(0, 2).join(' / ');
  return excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt;
}

function extractLyricKeywords(lyric: NcmLyric | null | undefined): string[] {
  if (!lyric?.lyric) {
    return [];
  }

  const lines = cleanLyricLines(lyric.lyric, { preserveFiller: true }).slice(0, 10).join(' ');
  if (!lines) {
    return [];
  }

  const tokens = [
    ...(lines.match(/[\u4e00-\u9fff]{2,6}/gu) ?? []),
    ...(lines.match(/[A-Za-z][A-Za-z']{2,}/g) ?? []).map((word) => word.toLowerCase())
  ];

  const counter = new Map<string, number>();
  for (const token of tokens) {
    const normalized = token.trim();
    if (!normalized) continue;
    if (isKeywordStopword(normalized)) continue;
    counter.set(normalized, (counter.get(normalized) ?? 0) + 1);
  }

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
    .slice(0, 6);
}

function normalizeLyric(text: string): string {
  return text
    .replace(/\[[\d:.]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maybeAddTag(output: Set<string>, raw: string): void {
  const tag = normalizeTag(raw);
  if (!tag) return;
  output.add(tag);
}

function normalizeTag(raw: string): string | null {
  const tag = raw.trim();
  if (tag.length < 1 || tag.length > 24) return null;
  if (/https?:\/\//i.test(tag)) return null;
  if (/^\d+$/.test(tag)) return null;
  if (/[，。！？；：、]/u.test(tag)) return null;
  return tag;
}

function normalizeText(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function isKeywordStopword(word: string): boolean {
  return EN_STOPWORDS.has(word) || ZH_STOPWORDS.has(word);
}
