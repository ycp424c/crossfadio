// Display punctuation is not a trustworthy artist boundary: names such as
// "Earth, Wind & Fire" and "AC/DC" are one canonical artist. Only separators
// that are explicitly surrounded by whitespace (or collaboration words) are
// treated as structured collaborators.
const STRUCTURED_ARTIST_SEPARATOR = /\s+(?:\/|feat\.?|ft\.?|with)\s+/i;

export function artistKeys(artist: string | null | undefined): string[] {
  const value = artist?.trim() ?? '';
  if (!value) return [];
  const parts = value.split(STRUCTURED_ARTIST_SEPARATOR).map((part) => normalizeArtistKey(part));
  return [...new Set(parts.filter(Boolean))];
}

export function primaryArtistKey(artist: string | null | undefined): string {
  const value = artist?.trim() ?? '';
  return normalizeArtistKey(value.split(STRUCTURED_ARTIST_SEPARATOR)[0] ?? value);
}

/** Hard-exclusion identities preserve band names containing comma, ampersand, or slash. */
export function explicitArtistKeys(artist: string | null | undefined): string[] {
  return artistKeys(artist);
}

function normalizeArtistKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
