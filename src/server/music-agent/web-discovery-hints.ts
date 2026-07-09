import { artistKeys } from './artists.js';
import {
  musicEntityHintSchema,
  type MusicAgentContextSummary,
  type MusicEntityHint,
  type WebMusicDiscoveryInput
} from './schema.js';

const HARD_MISMATCH_WEB_ARTIST_PATTERN =
  /\b(slipknot|metallica|megadeth|slayer|korn|limp bizkit|pantera|system of a down)\b/i;

export type ParsedMusicEntityHints = {
  hints: MusicEntityHint[];
  problems: string[];
};

export type FilterWebDiscoveryHintsInput = {
  avoidArtists: ReadonlySet<string>;
  expectedStyle?: string;
};

export type FilteredWebDiscoveryHints = {
  hints: unknown[];
  problems: string[];
};

export function parseMusicEntityHints(value: unknown, limit: number): ParsedMusicEntityHints {
  const rawHints = Array.isArray(value) ? value : [];
  const hints: MusicEntityHint[] = [];
  const problems: string[] = [];
  for (const rawHint of rawHints) {
    if (hints.length >= limit) break;
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      problems.push('web hint skipped: invalid sourced hint');
      continue;
    }
    hints.push(parsed.data);
  }
  return { hints, problems };
}

export function filterWebDiscoveryHintsForRecall(
  value: unknown,
  input: FilterWebDiscoveryHintsInput
): FilteredWebDiscoveryHints {
  const hints: unknown[] = [];
  const problems: string[] = [];

  for (const rawHint of objectArrayValue(value)) {
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      hints.push(rawHint);
      continue;
    }
    const hint = parsed.data;
    const artist = webHintArtistName(hint);
    const hintArtistKeys = artistKeys(artist);
    if (hintArtistKeys.some((artistKey) => input.avoidArtists.has(artistKey))) {
      problems.push(`web hint skipped: recently repeated artist ${artist}`);
      continue;
    }
    if (artist && isHardMismatchedWebArtist(artist, input.expectedStyle || hint.styles.join(' '))) {
      problems.push(`web hint skipped: hard style mismatch for ${artist}`);
      continue;
    }
    hints.push(rawHint);
  }

  return { hints, problems };
}

export function webHintArtistName(hint: MusicEntityHint): string {
  if (hint.kind === 'artist') return hint.name;
  if (hint.kind === 'relationship') return hint.relatedName ?? hint.artist ?? hint.name;
  return hint.artist ?? '';
}

export function isHardMismatchedWebArtist(artist: string, styleText: string): boolean {
  if (!styleText || !styleDisallowsHeavyRock(styleText)) return false;
  return HARD_MISMATCH_WEB_ARTIST_PATTERN.test(artist);
}

export function defaultWebDiscoveryLocale(context: MusicAgentContextSummary): WebMusicDiscoveryInput['locale'] {
  const text = webDiscoveryIntentText(context);
  return /[一-鿿]/.test(text) ? 'zh-CN' : 'global';
}

export function defaultWebDiscoveryFreshness(intent: string): WebMusicDiscoveryInput['freshness'] {
  return /新歌|近期|最近|recent|new|fresh|release/i.test(intent) ? 'recent' : 'durable';
}

export function webDiscoveryIntentText(context: MusicAgentContextSummary): string {
  return [
    context.currentUserText,
    ...(context.actionQueries ?? []),
    context.activeDirective
  ].filter(Boolean).join(' ');
}

function styleDisallowsHeavyRock(styleText: string): boolean {
  return /cantopop|c[-\s]*pop|j[-\s]*pop|k[-\s]*pop|city\s*pop|indie\s*folk|folk|dream\s*pop|synth[-\s]*pop|singer[-\s]*songwriter|neo\s*soul|r\s*&?\s*b|jazz|ambient|downtempo/i.test(styleText);
}

export function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}
