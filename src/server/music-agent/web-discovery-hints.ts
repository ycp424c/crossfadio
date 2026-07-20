import {
  musicEntityHintSchema,
  type MusicAgentContextSummary,
  type MusicEntityHint,
  type WebMusicDiscoveryInput
} from './schema.js';

export type ParsedMusicEntityHints = {
  hints: MusicEntityHint[];
  problems: string[];
};

export type FilterWebDiscoveryHintsInput = {
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
  _input: FilterWebDiscoveryHintsInput
): FilteredWebDiscoveryHints {
  const hints: unknown[] = [];
  const problems: string[] = [];

  for (const rawHint of objectArrayValue(value)) {
    const parsed = musicEntityHintSchema.safeParse(rawHint);
    if (!parsed.success) {
      hints.push(rawHint);
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

export function objectArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}
