import { getLogger } from './logger.js';

const TIMEOUT_MS = 8_000;
const MAX_ARTISTS = 5;
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const MB_API = 'https://musicbrainz.org/ws/2/artist';

/**
 * Search for artists matching a style/mood from multiple sources.
 * 1. MusicBrainz: tag-based artist search with random offset (good for genre→artist mapping)
 * 2. Wikipedia: "List of X artists" pages (broad coverage)
 * Returns up to 5 randomly sampled artist names, or empty array on failure.
 */
export async function searchArtistsForStyle(styleQuery: string): Promise<string[]> {
  const [mb, wiki] = await Promise.all([
    searchMusicBrainz(styleQuery),
    searchWikipedia(styleQuery),
  ]);

  // Merge, dedupe by lowercase
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...mb, ...wiki]) {
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      merged.push(name);
    }
  }
  return merged.slice(0, MAX_ARTISTS);
}

// ── MusicBrainz ────────────────────────────────────────────────

/**
 * Search MusicBrainz for artists tagged with a given style.
 * Uses random offset to avoid bias toward mainstream crossover acts.
 */
async function searchMusicBrainz(styleQuery: string): Promise<string[]> {
  try {
    // Normalize style to a tag-friendly form (remove trailing descriptors, use lowercase)
    const tag = styleQuery.replace(/\s+/g, '-').toLowerCase();
    const query = `tag:${tag} AND type:group`;

    // First request: get total count
    const countData = await mbApi<MbCountResponse>({
      query,
      limit: '1',
      offset: '0',
      fmt: 'json',
    });
    const total = countData?.count ?? 0;
    if (total < 10) return [];

    // Pick a random offset to get diverse results (avoid top mainstream acts)
    const maxOffset = Math.min(total - 20, 5000);
    const randomOffset = Math.floor(Math.random() * maxOffset);

    // Fetch a batch at random offset
    const data = await mbApi<MbSearchResponse>({
      query,
      limit: '20',
      offset: String(randomOffset),
      fmt: 'json',
    });

    const artists = data?.artists ?? [];
    if (artists.length === 0) return [];

    // Filter and extract names
    const names = artists
      .map((a) => a.name?.trim())
      .filter(
        (n): n is string =>
          !!n &&
          n.length > 0 &&
          n.length < 60 &&
          !isNoiseName(n)
      );

    return sampleN(names, 5);
  } catch {
    return [];
  }
}

/** Quick filter for MusicBrainz noise entries */
function isNoiseName(name: string): boolean {
  return (
    /^(Various Artists|Various|Unknown|Anonymous|[Unknown]|佚名|群星|VA)$/i.test(name) ||
    /\[(unknown|anonymous|various|demo|untitled)\]/i.test(name) ||
    /^(ISBN|S2CID|DOI|ISSN|OCLC|PMID)/.test(name)
  );
}

async function mbApi<T>(params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams(params);
  const url = `${MB_API}?${qs.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Crossfadio/1.0 (contact@crossfadio.dev)' },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type MbCountResponse = { count: number };
type MbSearchResponse = { artists?: Array<{ name?: string }> };

// ── Wikipedia ──────────────────────────────────────────────────

async function searchWikipedia(styleQuery: string): Promise<string[]> {
  try {
    const queries = [
      `List of ${styleQuery} artists`,
      `List of ${styleQuery} musicians`,
      `${styleQuery} musicians`,
      `${styleQuery} artists`,
    ];

    for (const query of queries) {
      const artists = await tryListPageLookup(query);
      if (artists.length >= 2) return artists;
    }

    const searchArtists = await trySearchExtraction(styleQuery);
    if (searchArtists.length > 0) return searchArtists;

    return [];
  } catch (err) {
    getLogger().debug({ err, styleQuery }, 'Wikipedia artist search failed');
    return [];
  }
}

/**
 * Try to find a "List of X artists" page and extract artist links from it.
 */
async function tryListPageLookup(searchQuery: string): Promise<string[]> {
  // Step 1: Search for list pages
  const searchResults = await wikiApi<WsSearchResponse>({
    action: 'query',
    list: 'search',
    srsearch: searchQuery,
    srlimit: '5',
    format: 'json',
  });

  const hits = searchResults?.query?.search ?? [];
  if (hits.length === 0) return [];

  // Look for a title that matches "List of ... artists/musicians"
  const listHit = hits.find(
    (h) =>
      /^List of .*(artists|musicians|bands|singers|performers)/i.test(h.title) &&
      !/death|murder/i.test(h.title)
  );
  if (!listHit) return [];

  // Step 2: Fetch all links from the list page
  const allArtists = await fetchAllLinks(listHit.title);
  if (allArtists.length === 0) return [];

  // Step 3: Random sample
  getLogger().debug(
    { searchQuery, listTitle: listHit.title, totalLinks: allArtists.length },
    'Wikipedia list page found, sampling artists'
  );
  return sampleN(allArtists, MAX_ARTISTS);
}

/**
 * Fetch ALL links from a Wikipedia list page (handles pagination via "continue").
 */
async function fetchAllLinks(pageTitle: string): Promise<string[]> {
  const all: string[] = [];
  let plcontinue: string | undefined;

  for (let i = 0; i < 5; i++) {
    const params: Record<string, string> = {
      action: 'query',
      prop: 'links',
      titles: pageTitle,
      pllimit: '500',
      format: 'json',
    };
    if (plcontinue) params.plcontinue = plcontinue;

    const data = await wikiApi<WlLinksResponse>(params);
    const pages = data?.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      for (const link of page.links ?? []) {
        const title = link.title.trim();
        // Filter out non-artist entries: genre names, admin pages, templates, etc.
        if (isLikelyArtist(title)) {
          all.push(title);
        }
      }
    }

    plcontinue = (data as { continue?: { plcontinue: string } })?.continue?.plcontinue;
    if (!plcontinue) break;
  }

  return all;
}

/**
 * Fallback: extract artist names from Wikipedia search result titles and snippets.
 */
async function trySearchExtraction(styleQuery: string): Promise<string[]> {
  const data = await wikiApi<WsSearchResponse>({
    action: 'query',
    list: 'search',
    srsearch: `${styleQuery} musician band`,
    srlimit: '20',
    format: 'json',
  });

  const hits = data?.query?.search ?? [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    const title = hit.title.trim();
    // Skip list pages, genre pages, etc.
    if (/^List of |^Index of |musician|band|singer|rapper|guitarist|pianist|drummer|composer/i.test(title)) continue;
    if (/music|genre|album|record|label|festival/i.test(title)) continue;
    if (!isLikelyArtist(title)) continue;

    const lower = title.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    names.push(title);

    if (names.length >= MAX_ARTISTS) break;
  }

  return names;
}

// ── Helpers ──────────────────────────────────────────────────

function isLikelyArtist(title: string): boolean {
  if (!title || title.length > 60) return false;
  // Exclude Wikipedia meta pages
  if (/^(Wikipedia|Template|Category|Portal|Help|File|Draft|Module|TimedText|User):/i.test(title))
    return false;

  // Exclude short titles that are genre/style names (2 words or fewer with genre terms)
  const wordCount = title.split(/\s+/).length;
  if (
    wordCount <= 2 &&
    /(rock|pop|punk|metal|folk|jazz|blues|soul|funk|disco|techno|house|trance|dubstep|hip[ -]?hop|rap|reggae|ska|swing|bebop|fusion|gospel|country|bluegrass|classical|opera|ambient|new age|shoegaze|dream[ -]?pop|synth|electro|industrial|noise|drone|glitch|vaporwave|chillwave|post[ -]?rock|post[ -]?punk|math[ -]?rock|prog|grunge|emo|hardcore|thrash|death[ -]?metal|black[ -]?metal|doom|sludge|stoner|garage|psych|surf|rockabilly|R\s*&?\s*B|dance|EDM|electronica|downtempo|trip[ -]?hop|breakbeat|grime|dub|grrrl|storm|brass|orchestra|choir|chorus|band$)/i.test(
      title
    )
  )
    return false;

  // Exclude list/overview pages
  if (/^(List of |Index of |Music of |Timeline of )/i.test(title)) return false;

  // Exclude known non-musician entries
  if (
    /(magazine|newspaper|festival|concert|record label|compilation|chart|award|radio station|television|film series|video game|software|company|Records$|discography|musick)/i.test(
      title
    )
  )
    return false;

  // Exclude identifiers and non-musical organizations
  if (
    /^(ISBN|S2CID|DOI|ISSN|OCLC|PMID|PMC|Bibcode|Arxiv|JSTOR|LCCN)(\s*\(identifier\))?$/.test(
      title
    )
  )
    return false;

  if (/^(NPR|BBC|CNN|MTV|VH1|KEXP|WFMU|WNYC|Pitchfork|Pitchfork Media|Rolling Stone|Billboard|Spin|NME|Mojo|Q magazine)$/i.test(title))
    return false;

  // Must contain at least one letter from a known script
  if (!/[a-zA-Z一-鿿぀-ゟ゠-ヿ]/.test(title)) return false;
  return true;
}

function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function wikiApi<T>(params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams({ ...params, origin: '*' });
  const url = `${WIKI_API}?${qs.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Crossfadio/1.0 (music-recommendation; contact@crossfadio.dev)' },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── API response types ───────────────────────────────────────

type WsSearchResponse = {
  query?: {
    search?: Array<{ title: string; snippet: string }>;
  };
};

type WlLinksResponse = {
  query?: {
    pages?: Record<string, { links?: Array<{ title: string }> }>;
  };
};
