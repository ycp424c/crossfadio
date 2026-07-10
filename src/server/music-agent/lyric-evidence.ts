import { createHash } from 'node:crypto';
import type { NcmLyric } from '../../shared/schema.js';

export type LyricCreditRole =
  | 'lyricists'
  | 'composers'
  | 'arrangers'
  | 'producers'
  | 'mixers'
  | 'recordingEngineers'
  | 'masteringEngineers'
  | 'vocalists';

export type SampledLyricLine = {
  position: 'opening' | 'early' | 'middle' | 'late' | 'ending' | 'hook';
  text: string;
  translation?: string;
  repeatCount?: number;
};

export type PreparedLyricEvidence = {
  lyricHash: string;
  lyricStatus: 'available' | 'missing';
  sampleMode: 'full' | 'stratified' | 'none';
  credits: Partial<Record<LyricCreditRole, string[]>>;
  lineCount: number;
  hasTranslation: boolean;
  repeatedHookCount: number;
  sampledCharCount: number;
  sampledLines: SampledLyricLine[];
};

type ParsedLyricLine = {
  index: number;
  timestampMs: number | null;
  text: string;
};

type EvidenceLine = ParsedLyricLine & {
  translation?: string;
  normalizedText: string;
  window: number;
};

type SamplingCandidate = {
  line: EvidenceLine;
  position: SampledLyricLine['position'];
  repeatCount?: number;
  reasons: Set<'window' | 'hook' | 'information' | 'ending'>;
};

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const CREDIT_ALIASES: Array<{ role: LyricCreditRole; aliases: string[] }> = [
  {
    role: 'recordingEngineers',
    aliases: ['Recording Engineer', 'Recording Engineers', 'Recording', '录音工程师', '录音师', '录音']
  },
  {
    role: 'masteringEngineers',
    aliases: ['Mastering Engineer', 'Mastering Engineers', 'Mastering', '母带工程师', '母带师', '母带']
  },
  { role: 'lyricists', aliases: ['Lyricists', 'Lyricist', 'Lyrics', 'Written by', '作词', '填词', '词'] },
  { role: 'composers', aliases: ['Composers', 'Composer', 'Music by', '作曲', '曲'] },
  { role: 'arrangers', aliases: ['Arrangers', 'Arranger', 'Arrangement', '编曲'] },
  { role: 'producers', aliases: ['Producers', 'Producer', 'Produced by', '制作人', '制作'] },
  { role: 'mixers', aliases: ['Mixing Engineer', 'Mix Engineer', 'Mixing', 'Mixed by', '混音工程师', '混音师', '混音'] },
  { role: 'vocalists', aliases: ['Vocalists', 'Vocalist', 'Vocals', 'Singer', '演唱者', '演唱', '主唱'] }
];
const EMPTY_CREDIT_VALUES = new Set(['无', 'n/a', 'na', 'none', 'null', '-', '--']);
const WINDOW_COUNT = 6;
const MAX_LINES_PER_WINDOW = 2;
const EXTRA_INFORMATION_LINES = 6;
const WINDOW_POSITIONS: Array<Exclude<SampledLyricLine['position'], 'hook'>> = [
  'opening',
  'early',
  'middle',
  'middle',
  'late',
  'ending'
];
const FILLER_RE = /^(?:[.·…~\-—_]+|[[(（【]?\s*(?:纯音乐|间奏|前奏|尾奏|伴奏|music|instrumental|interlude|intro|outro)\s*[\])）】]?)$/iu;
const LRC_METADATA_RE = /^\[(?:ar|ti|al|by|offset|re|ve):.*\]$/iu;

export function cleanLyricLines(raw: string): string[] {
  return parseLyricLines(raw)
    .filter(isMeaningfulLyricLine)
    .map((line) => line.text);
}

export function prepareLyricEvidence(
  lyric: NcmLyric | null,
  options: { charBudget: number }
): PreparedLyricEvidence {
  const rawLyric = lyric?.lyric ?? '';
  const rawTranslation = lyric?.translation ?? '';
  const lyricHash = hashNormalizedLyrics(rawLyric, rawTranslation);
  const credits = parseCredits(rawLyric);
  const sourceLines = parseLyricLines(rawLyric).filter(isMeaningfulLyricLine);
  const translationLines = parseLyricLines(rawTranslation).filter(isMeaningfulLyricLine);
  const lines = alignTranslations(sourceLines, translationLines);

  if (lines.length === 0) {
    return {
      lyricHash,
      lyricStatus: 'missing',
      sampleMode: 'none',
      credits,
      lineCount: lines.length,
      hasTranslation: false,
      repeatedHookCount: 0,
      sampledCharCount: 0,
      sampledLines: []
    };
  }

  const charBudget = Math.max(0, Math.floor(options.charBudget));
  if (charBudget === 0) {
    return {
      lyricHash,
      lyricStatus: 'available',
      sampleMode: 'none',
      credits,
      lineCount: lines.length,
      hasTranslation: lines.some((line) => line.translation !== undefined),
      repeatedHookCount: 0,
      sampledCharCount: 0,
      sampledLines: []
    };
  }

  const fullLines = lines.map<SampledLyricLine>((line) => ({
    position: WINDOW_POSITIONS[line.window] ?? 'middle',
    text: line.text,
    ...(line.translation ? { translation: line.translation } : {})
  }));
  const fullCharCount = countSampledChars(fullLines);
  if (fullCharCount <= Math.min(2_000, charBudget)) {
    return {
      lyricHash,
      lyricStatus: 'available',
      sampleMode: 'full',
      credits,
      lineCount: lines.length,
      hasTranslation: lines.some((line) => line.translation !== undefined),
      repeatedHookCount: 0,
      sampledCharCount: fullCharCount,
      sampledLines: fullLines
    };
  }

  const repeatedHooks = findRepeatedHooks(lines);
  const sampledLines = sampleStratifiedLines(lines, repeatedHooks, charBudget);

  return {
    lyricHash,
    lyricStatus: 'available',
    sampleMode: 'stratified',
    credits,
    lineCount: lines.length,
    hasTranslation: lines.some((line) => line.translation !== undefined),
    repeatedHookCount: repeatedHooks.size,
    sampledCharCount: countSampledChars(sampledLines),
    sampledLines
  };
}

function parseLyricLines(raw: string): ParsedLyricLine[] {
  const parsed: ParsedLyricLine[] = [];

  for (const rawLine of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const timestamps = [...rawLine.matchAll(TIMESTAMP_RE)];
    const text = rawLine.replace(TIMESTAMP_RE, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    if (timestamps.length === 0) {
      parsed.push({ index: parsed.length, timestampMs: null, text });
      continue;
    }

    for (const timestamp of timestamps) {
      parsed.push({
        index: parsed.length,
        timestampMs: timestampToMs(timestamp),
        text
      });
    }
  }

  return parsed;
}

function timestampToMs(match: RegExpMatchArray): number {
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  const fraction = match[3] ?? '';
  const fractionMs = fraction.length === 3 ? Number(fraction) : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction) * 100;
  return (minutes * 60 + seconds) * 1_000 + fractionMs;
}

function parseCredits(raw: string): Partial<Record<LyricCreditRole, string[]>> {
  const credits: Partial<Record<LyricCreditRole, string[]>> = {};

  for (const line of parseLyricLines(raw)) {
    const parsed = parseCreditLine(line.text);
    if (!parsed) continue;

    const existing = credits[parsed.role] ?? [];
    const seen = new Set(existing.map((name) => name.toLocaleLowerCase()));
    for (const name of parsed.names) {
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(name);
    }
    if (existing.length > 0) {
      credits[parsed.role] = existing;
    }
  }

  return credits;
}

function isMeaningfulLyricLine(line: ParsedLyricLine): boolean {
  return !parseCreditLine(line.text) && !FILLER_RE.test(line.text) && !LRC_METADATA_RE.test(line.text);
}

function alignTranslations(source: ParsedLyricLine[], translations: ParsedLyricLine[]): EvidenceLine[] {
  const timestampedTranslations = new Map<number, string>();
  const untimestampedTranslations: string[] = [];

  for (const line of translations) {
    if (line.timestampMs === null) {
      untimestampedTranslations.push(line.text);
    } else if (!timestampedTranslations.has(line.timestampMs)) {
      timestampedTranslations.set(line.timestampMs, line.text);
    }
  }

  const timestampValues = [...timestampedTranslations.entries()].sort((a, b) => a[0] - b[0]);
  const ratios = calculatePositionRatios(source);

  return source.map((line, index) => {
    let translation: string | undefined;
    if (line.timestampMs !== null) {
      translation = timestampedTranslations.get(line.timestampMs);
      if (!translation) {
        const closest = timestampValues
          .map(([timestamp, text]) => ({ distance: Math.abs(timestamp - line.timestampMs!), text }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (closest && closest.distance <= 750) {
          translation = closest.text;
        }
      }
    } else {
      translation = untimestampedTranslations[index];
    }

    const ratio = ratios[index] ?? 0;
    return {
      ...line,
      ...(translation ? { translation } : {}),
      normalizedText: normalizeLineForDedupe(line.text),
      window: Math.min(WINDOW_COUNT - 1, Math.floor(ratio * WINDOW_COUNT))
    };
  });
}

function calculatePositionRatios(lines: ParsedLyricLine[]): number[] {
  const timestamps = lines.map((line) => line.timestampMs).filter((value): value is number => value !== null);
  const canUseTimestamps = timestamps.length >= 2 && Math.max(...timestamps) > Math.min(...timestamps);

  if (canUseTimestamps) {
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    return lines.map((line, index) =>
      line.timestampMs === null ? indexRatio(index, lines.length) : (line.timestampMs - first) / (last - first)
    );
  }

  return lines.map((_line, index) => indexRatio(index, lines.length));
}

function indexRatio(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1);
}

function findRepeatedHooks(lines: EvidenceLine[]): Map<string, { representative: EvidenceLine; count: number }> {
  const groups = new Map<string, EvidenceLine[]>();
  for (const line of lines) {
    if (line.normalizedText.length < 4) continue;
    const group = groups.get(line.normalizedText) ?? [];
    group.push(line);
    groups.set(line.normalizedText, group);
  }

  return new Map(
    [...groups.entries()]
      .filter(([, group]) => group.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[1][0]!.index - b[1][0]!.index)
      .map(([key, group]) => [key, { representative: group[0]!, count: group.length }])
  );
}

function sampleStratifiedLines(
  lines: EvidenceLine[],
  repeatedHooks: Map<string, { representative: EvidenceLine; count: number }>,
  charBudget: number
): SampledLyricLine[] {
  const candidates = new Map<string, SamplingCandidate>();
  const addCandidate = (
    line: EvidenceLine,
    reason: SamplingCandidate['reasons'] extends Set<infer T> ? T : never,
    repeatCount?: number
  ) => {
    const existing = candidates.get(line.normalizedText);
    if (existing) {
      existing.reasons.add(reason);
      if (repeatCount !== undefined) {
        existing.position = 'hook';
        existing.repeatCount = repeatCount;
      }
      return;
    }
    candidates.set(line.normalizedText, {
      line,
      position: repeatCount === undefined ? WINDOW_POSITIONS[line.window] ?? 'middle' : 'hook',
      ...(repeatCount === undefined ? {} : { repeatCount }),
      reasons: new Set([reason])
    });
  };

  for (const hook of repeatedHooks.values()) {
    addCandidate(hook.representative, 'hook', hook.count);
  }

  for (let window = 0; window < WINDOW_COUNT; window += 1) {
    const windowLines = lines.filter((line) => line.window === window);
    let added = 0;
    for (const line of windowLines) {
      const before = candidates.size;
      addCandidate(line, 'window', repeatedHooks.get(line.normalizedText)?.count);
      if (candidates.size > before || candidates.get(line.normalizedText)?.reasons.has('window')) {
        added += 1;
      }
      if (added >= MAX_LINES_PER_WINDOW) break;
    }
  }

  const informationLines = [...lines]
    .filter((line) => !repeatedHooks.has(line.normalizedText))
    .sort(
      (a, b) =>
        uniqueContentTokenCount(b.text) - uniqueContentTokenCount(a.text) ||
        b.text.length - a.text.length ||
        a.index - b.index
    )
    .slice(0, EXTRA_INFORMATION_LINES);
  for (const line of informationLines) {
    addCandidate(line, 'information');
  }

  for (const line of lines.slice(-2)) {
    addCandidate(line, 'ending', repeatedHooks.get(line.normalizedText)?.count);
  }

  const selected = chooseWithinBudget([...candidates.values()], lines, charBudget);
  return selected
    .sort((a, b) => a.line.index - b.line.index)
    .map((candidate) => ({
      position: candidate.position,
      text: candidate.line.text,
      ...(candidate.line.translation ? { translation: candidate.line.translation } : {}),
      ...(candidate.repeatCount === undefined ? {} : { repeatCount: candidate.repeatCount })
    }));
}

function chooseWithinBudget(
  candidates: SamplingCandidate[],
  allLines: EvidenceLine[],
  charBudget: number
): SamplingCandidate[] {
  const byWindow = Array.from({ length: WINDOW_COUNT }, (_, window) =>
    candidates.filter((candidate) => candidate.line.window === window && candidate.reasons.has('window'))
  );
  const lastLine = allLines.at(-1);
  const penultimateLine = allLines.at(-2);
  const preferred: SamplingCandidate[] = [];
  const append = (candidate: SamplingCandidate | undefined) => {
    if (candidate && !preferred.includes(candidate)) preferred.push(candidate);
  };

  append(lastLine ? candidates.find((candidate) => candidate.line.normalizedText === lastLine.normalizedText) : undefined);
  append(byWindow[0]?.[0]);
  for (const hook of candidates
    .filter((candidate) => candidate.reasons.has('hook'))
    .sort((a, b) => (b.repeatCount ?? 0) - (a.repeatCount ?? 0) || a.line.index - b.line.index)) {
    append(hook);
  }
  append(byWindow[2]?.[0]);
  append(byWindow[3]?.[0]);
  append(byWindow[1]?.[0]);
  append(byWindow[4]?.[0]);
  append(byWindow[5]?.[0]);
  append(
    penultimateLine
      ? candidates.find((candidate) => candidate.line.normalizedText === penultimateLine.normalizedText)
      : undefined
  );

  for (let offset = 1; offset < MAX_LINES_PER_WINDOW; offset += 1) {
    for (let window = 0; window < WINDOW_COUNT; window += 1) {
      append(byWindow[window]?.[offset]);
    }
  }
  for (const candidate of candidates
    .filter((item) => item.reasons.has('information'))
    .sort(
      (a, b) =>
        uniqueContentTokenCount(b.line.text) - uniqueContentTokenCount(a.line.text) ||
        b.line.text.length - a.line.text.length ||
        a.line.index - b.line.index
    )) {
    append(candidate);
  }
  for (const candidate of candidates.sort((a, b) => a.line.index - b.line.index)) {
    append(candidate);
  }

  const selected: SamplingCandidate[] = [];
  let used = 0;
  for (const candidate of preferred) {
    const cost = candidate.line.text.length + (candidate.line.translation?.length ?? 0);
    if (used + cost > charBudget) continue;
    selected.push(candidate);
    used += cost;
  }
  return selected;
}

function normalizeLineForDedupe(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function uniqueContentTokenCount(text: string): number {
  const tokens = text.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9']+|[\u3400-\u9fff]/giu) ?? [];
  return new Set(tokens).size;
}

function countSampledChars(lines: SampledLyricLine[]): number {
  return lines.reduce((sum, line) => sum + line.text.length + (line.translation?.length ?? 0), 0);
}

function parseCreditLine(text: string): { role: LyricCreditRole; names: string[] } | null {
  for (const candidate of CREDIT_ALIASES) {
    for (const alias of candidate.aliases) {
      const match = text.match(new RegExp(`^${escapeRegExp(alias)}\\s*[:：]\\s*(.+)$`, 'iu'));
      if (!match) continue;

      const names = (match[1] ?? '')
        .replace(/\bN\s*\/\s*A\b/giu, '无')
        .split(/\s*(?:\/|、|,|，|;|；|&|\band\b)\s*/iu)
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !EMPTY_CREDIT_VALUES.has(name.toLocaleLowerCase()));
      return { role: candidate.role, names };
    }
  }
  return null;
}

function hashNormalizedLyrics(lyric: string, translation: string): string {
  const normalize = (value: string) =>
    value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  return createHash('sha256').update(`${normalize(lyric)}\n---translation---\n${normalize(translation)}`).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
