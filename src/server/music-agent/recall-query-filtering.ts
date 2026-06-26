import { sanitizeSearchQuery } from './query-stats.js';

export const SEMANTIC_ONLY_QUERY_PROBLEM = 'skipped semantic-only queries; use semantic discovery before NCM song search';

const SEMANTIC_SONG_SEARCH_PATTERNS = [
  /\b(city\s*pop|indie\s*pop|dream\s*pop|synth[-\s]*pop|cantopop|neo\s*soul|nu\s*jazz|downtempo|electropop)\b/i,
  /\b(indie\s*rock|alternative\s*rock|soft\s*rock|j[-\s]*pop|k[-\s]*pop|c[-\s]*pop)\b/i,
  /\b(female\s*(vocal|singer|artist)|male\s*(vocal|singer|artist)|low\s*energy|medium[-\s]*low\s*energy)\b/i,
  /\b(chill|quiet|focus|workout|relax(?:ed|ing)?|soft|mellow|synth|band|guitar)\b/i,
  /午后|下午|上午|早晨|清晨|晚上|夜晚|深夜|工作|学习|专注|轻松|柔和|不吵|安静|中低能量|低能量|高能量/,
  /女声|男声|女歌手|男歌手|女生唱|男生唱|乐队|律动|合成器|清爽|明亮|提神|低人声|少人声|粤语|华语/
];

export type RecallQueryEligibility = {
  sanitizedQueries: string[];
  artistFilteredQueries: string[];
  exactTrackQueries: string[];
  skippedAvoidedQueries: number;
  skippedSemanticQueries: number;
};

export type NoExecutableQueryReasonInput = {
  inputQueryCount: number;
  sanitizedQueryCount: number;
  artistFilteredQueryCount: number;
  skippedAvoidedQueries: number;
  skippedSemanticQueries: number;
};

export function prepareRecallQueryEligibility(
  queries: string[],
  avoidArtists: ReadonlySet<string>
): RecallQueryEligibility {
  const sanitizedQueries = uniqueStrings(queries.map(sanitizeSearchQuery).filter(Boolean));
  const { queries: artistFilteredQueries, skipped: skippedAvoidedQueries } = filterAvoidedQueries(sanitizedQueries, avoidArtists);
  const { queries: exactTrackQueries, skipped: skippedSemanticQueries } = filterExactSongSearchQueries(artistFilteredQueries);

  return {
    sanitizedQueries,
    artistFilteredQueries,
    exactTrackQueries,
    skippedAvoidedQueries,
    skippedSemanticQueries
  };
}

export function filterAvoidedQueries(queries: string[], avoidArtists: ReadonlySet<string>): { queries: string[]; skipped: number } {
  if (avoidArtists.size === 0) return { queries, skipped: 0 };
  const kept: string[] = [];
  let skipped = 0;
  for (const query of queries) {
    const normalized = query.toLowerCase();
    if ([...avoidArtists].some((artist) => artist && normalized.includes(artist))) {
      skipped += 1;
      continue;
    }
    kept.push(query);
  }
  return { queries: kept, skipped };
}

export function filterExactSongSearchQueries(queries: string[]): { queries: string[]; skipped: number } {
  const kept: string[] = [];
  let skipped = 0;
  for (const query of uniqueStrings(queries)) {
    if (isExactSongSearchQuery(query)) {
      kept.push(query);
    } else {
      skipped += 1;
    }
  }
  return { queries: kept, skipped };
}

export function isExactSongSearchQuery(query: string): boolean {
  const value = sanitizeSearchQuery(query);
  if (!value) return false;
  if (SEMANTIC_SONG_SEARCH_PATTERNS.some((pattern) => pattern.test(value))) return false;
  if (/^[\p{L}\p{N}'’().]+(?:\s+[—-]\s+|\s+--\s+)[\p{L}\p{N}'’().]+/u.test(value)) return true;
  if (value.includes(':')) return false;
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length > 8) return false;
  if (parts.some((part) => /[A-Z]/.test(part) || /[\u3400-\u9fffぁ-ゟ゠-ヿ가-힣]/.test(part))) {
    return true;
  }
  return parts.length >= 3;
}

export function formatNoExecutableQueryReason(input: NoExecutableQueryReasonInput): string {
  const reasons: string[] = [];
  if (input.inputQueryCount === 0) reasons.push('query plan empty');
  if (input.inputQueryCount > 0 && input.sanitizedQueryCount === 0) reasons.push('queries sanitized to empty');
  if (input.skippedAvoidedQueries > 0 && input.artistFilteredQueryCount === 0) {
    reasons.push('all queries skipped for recently repeated artists');
  }
  if (input.skippedSemanticQueries > 0) {
    reasons.push(input.artistFilteredQueryCount === input.skippedSemanticQueries
      ? 'all queries skipped as semantic-only'
      : `${input.skippedSemanticQueries} semantic-only queries skipped`);
  }
  return reasons.length > 0 ? reasons.join('; ') : 'no exact-track search queries available';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
