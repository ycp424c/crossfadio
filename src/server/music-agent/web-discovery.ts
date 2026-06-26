import { searchArtistsForStyle } from '../web-search.js';
import {
  musicEntityHintSchema,
  webMusicDiscoveryInputSchema,
  type MusicEntityHint,
  type WebMusicDiscoveryInput
} from './schema.js';

const HARD_MISMATCH_ARTIST_PATTERN =
  /\b(slipknot|metallica|megadeth|slayer|korn|limp bizkit|pantera|system of a down)\b/i;

export type WebMusicDiscoveryProvider = {
  discover: (
    input: WebMusicDiscoveryInput,
    options?: { signal?: AbortSignal }
  ) => Promise<MusicEntityHint[]>;
};

export function createDefaultWebMusicDiscoveryProvider(): WebMusicDiscoveryProvider {
  return {
    discover: discoverPublicMusicHints
  };
}

async function discoverPublicMusicHints(
  rawInput: WebMusicDiscoveryInput,
  options: { signal?: AbortSignal } = {}
): Promise<MusicEntityHint[]> {
  const input = webMusicDiscoveryInputSchema.parse(rawInput);
  if (options.signal?.aborted) return [];

  const styleQuery = buildStyleQuery(input);
  if (!styleQuery) return [];

  const artists = await searchArtistsForStyle(styleQuery);
  if (options.signal?.aborted) return [];

  const observedAt = new Date().toISOString();
  return artists
    .filter((artist) => !isHardMismatchedArtistForStyle(artist, styleQuery))
    .slice(0, input.maxHints)
    .map((artist) => musicEntityHintSchema.parse({
    kind: 'artist',
    name: artist,
    styles: styleQuery ? [styleQuery] : [],
    sourceUrl: `https://musicbrainz.org/search?query=${encodeURIComponent(artist)}&type=artist`,
    sourceTitle: 'Public music style discovery',
    snippet: `Public music sources surfaced ${artist} for ${styleQuery}.`,
    confidence: 0.72,
    freshness: input.freshness === 'recent' ? 'fresh' : 'durable',
    observedAt
  }));
}

function buildStyleQuery(input: WebMusicDiscoveryInput): string {
  const styleAnchor = input.anchors.find((anchor) => anchor.type === 'style')?.name ?? '';
  if (styleAnchor) return normalizeStyleQuery(styleAnchor);

  const artistAnchor = input.anchors.find((anchor) => anchor.type === 'artist')?.name ?? '';
  const trackAnchor = input.anchors.find((anchor) => anchor.type === 'track')?.name ?? '';
  const text = [
    input.intent,
    artistAnchor ? `${artistAnchor} similar artists` : '',
    trackAnchor ? `${trackAnchor} similar songs` : ''
  ].filter(Boolean).join(' ');
  const knownStyle = extractKnownStyle(text);
  if (knownStyle) return knownStyle;
  return normalizeStyleQuery(text);
}

function extractKnownStyle(value: string): string {
  const normalized = value.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/city\s*pop|城市流行/i, 'city pop'],
    [/indie\s*folk|独立民谣/i, 'indie folk'],
    [/folk|民谣/i, 'folk'],
    [/singer[-\s]*songwriter|唱作/i, 'singer-songwriter'],
    [/indie\s*pop|独立流行/i, 'indie pop'],
    [/dream\s*pop|梦幻流行/i, 'dream pop'],
    [/synth[-\s]*pop|合成器流行/i, 'synth pop'],
    [/neo\s*soul|新灵魂/i, 'neo soul'],
    [/r\s*&?\s*b|节奏布鲁斯/i, 'r&b'],
    [/jazz|爵士/i, 'jazz'],
    [/electronic|电子/i, 'electronic'],
    [/ambient|氛围/i, 'ambient'],
    [/downtempo|缓拍/i, 'downtempo'],
    [/alternative\s*rock|另类摇滚/i, 'alternative rock'],
    [/indie\s*rock|独立摇滚/i, 'indie rock'],
    [/cantopop|粤语|港乐/i, 'cantopop'],
    [/j[-\s]*pop|日语|日系/i, 'j-pop'],
    [/k[-\s]*pop|韩语|韩系/i, 'k-pop'],
    [/c[-\s]*pop|华语|中文/i, 'c-pop']
  ];
  return patterns.find(([pattern]) => pattern.test(normalized))?.[1] ?? '';
}

function normalizeStyleQuery(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\b(探索|发现|几首|类似|相似|新歌|新音乐|歌曲|歌手|一些|适合|现在|下午|今天)\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function isHardMismatchedArtistForStyle(artist: string, styleQuery: string): boolean {
  if (!styleDisallowsHeavyRock(styleQuery)) return false;
  return HARD_MISMATCH_ARTIST_PATTERN.test(artist);
}

function styleDisallowsHeavyRock(styleQuery: string): boolean {
  return /cantopop|c[-\s]*pop|j[-\s]*pop|k[-\s]*pop|city\s*pop|indie\s*folk|folk|dream\s*pop|synth[-\s]*pop|singer[-\s]*songwriter|neo\s*soul|r\s*&?\s*b|jazz|ambient|downtempo/i.test(styleQuery);
}
