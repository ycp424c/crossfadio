const ARTIST_SEPARATOR = /\s*(?:\/|,|，|、|&| feat\.?| ft\.?| with )\s*/i;

export function artistKeys(artist: string | null | undefined): string[] {
  const value = artist ?? '';
  return [...new Set(
    value
      .split(ARTIST_SEPARATOR)
      .map((part) => normalizeArtistKey(part))
      .filter(Boolean)
  )];
}

export function primaryArtistKey(artist: string | null | undefined): string {
  return artistKeys(artist)[0] ?? '';
}

function normalizeArtistKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
