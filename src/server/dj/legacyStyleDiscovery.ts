export type LegacyStyleArtistDiscovery = {
  styleConcepts: string[];
  llmArtists: string[];
};

export type LegacySearchQueriesInput = {
  llmArtists: string[];
  webArtists: string[];
  styleConcepts: string[];
  dailyTheme?: { keywords: string[] } | null;
  directiveQueries: string[];
  shouldIncludeThemeKeyword?: (keyword: string) => boolean;
};

export type LegacySearchQueriesResult = {
  searchQueries: string[];
  themeKeywordsAdded: number;
  usedStyleFallback: boolean;
  styleFallbackSourceQueries?: string[];
};

const QUERY_CAP = 10;
const LLM_QUOTA = 6;
const THEME_QUOTA = 2;

export function parseLegacyStyleArtistResponse(raw: string): LegacyStyleArtistDiscovery {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { styleConcepts: [], llmArtists: [] };
  }

  const parsed: unknown = JSON.parse(match[0]);
  const styleConcepts: string[] = [];
  const llmArtists: string[] = [];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const styles = Array.isArray(obj.styles) ? obj.styles : [];
    const seen = new Set<string>();
    for (const s of styles) {
      if (!s || typeof s !== 'object') continue;
      const style = s as Record<string, unknown>;
      if (typeof style.style === 'string' && style.style.trim()) {
        styleConcepts.push(style.style.trim());
      }
      const artists = Array.isArray(style.artists) ? style.artists : [];
      for (const a of artists) {
        if (typeof a === 'string' && a.trim() && a.trim().length < 50) {
          const lower = a.trim().toLowerCase();
          if (!seen.has(lower)) {
            seen.add(lower);
            llmArtists.push(a.trim());
          }
        }
      }
    }
  }

  return { styleConcepts, llmArtists };
}

export function buildLegacySearchQueries(input: LegacySearchQueriesInput): LegacySearchQueriesResult {
  const shouldIncludeThemeKeyword = input.shouldIncludeThemeKeyword
    ?? (() => Math.random() < 0.5);
  const mergedQueries = new Set<string>();
  const searchQueries: string[] = [];

  for (const artist of input.llmArtists) {
    const lower = artist.toLowerCase();
    if (!mergedQueries.has(lower) && searchQueries.length < LLM_QUOTA) {
      mergedQueries.add(lower);
      searchQueries.push(artist);
    }
  }

  for (const artist of input.webArtists) {
    const lower = artist.toLowerCase();
    if (!mergedQueries.has(lower) && searchQueries.length < QUERY_CAP) {
      mergedQueries.add(lower);
      searchQueries.push(artist);
    }
  }

  let themeKeywordsAdded = 0;
  if (input.dailyTheme && input.dailyTheme.keywords.length > 0 && searchQueries.length < QUERY_CAP) {
    const themeCandidates = input.dailyTheme.keywords.filter(
      (keyword) => !mergedQueries.has(keyword.toLowerCase())
    );
    for (const keyword of themeCandidates) {
      if (searchQueries.length >= QUERY_CAP || themeKeywordsAdded >= THEME_QUOTA) break;
      if (shouldIncludeThemeKeyword(keyword)) {
        mergedQueries.add(keyword.toLowerCase());
        searchQueries.push(keyword);
        themeKeywordsAdded++;
      }
    }
  }

  for (const query of [...input.directiveQueries].reverse()) {
    const lower = query.toLowerCase();
    if (!mergedQueries.has(lower)) {
      mergedQueries.add(lower);
      searchQueries.unshift(query);
      if (searchQueries.length > QUERY_CAP) {
        const removed = searchQueries.pop();
        if (removed) mergedQueries.delete(removed.toLowerCase());
      }
    }
  }

  if (searchQueries.length < 2 && input.styleConcepts.length > 0) {
    return {
      searchQueries: input.styleConcepts.slice(0, 3),
      themeKeywordsAdded,
      usedStyleFallback: true,
      styleFallbackSourceQueries: [...searchQueries]
    };
  }

  return { searchQueries, themeKeywordsAdded, usedStyleFallback: false };
}
