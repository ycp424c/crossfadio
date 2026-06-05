type TrackDedupeInput = {
  name?: string | null;
  artist?: string | null;
  artists?: string[] | null;
};

const DEDUPE_KEY_SEPARATOR = '::';
const MIN_CONTAINED_TITLE_LENGTH = 4;
const MIN_OVERLAP_TITLE_LENGTH = 4;
const MIN_SHORT_TITLE_COVERAGE = 0.88;
const MIN_LONG_TITLE_COVERAGE = 0.58;

export function buildMusicTrackDedupeKey(track: TrackDedupeInput): string {
  const title = normalizeTrackTitle(track.name ?? '');
  const artist = normalizeMusicTrackToken(primaryArtist(track));
  if (!title) return '';
  return `${title}${DEDUPE_KEY_SEPARATOR}${artist}`;
}

export function normalizeMusicTrackToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isMusicTrackDedupeKeyExcluded(dedupeKey: string, excludedKeys: Set<string>): boolean {
  if (!dedupeKey) return false;
  if (excludedKeys.has(dedupeKey)) return true;

  for (const excludedKey of excludedKeys) {
    if (areMusicTrackDedupeKeysSimilar(dedupeKey, excludedKey)) {
      return true;
    }
  }

  return false;
}

export function areMusicTrackDedupeKeysSimilar(leftKey: string, rightKey: string): boolean {
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  const left = parseDedupeKey(leftKey);
  const right = parseDedupeKey(rightKey);
  if (!left || !right) return false;
  if (left.title === right.title) return true;
  if (!left.artist || !right.artist || left.artist !== right.artist) return false;

  return areTitlesSimilar(left.title, right.title);
}

function normalizeTrackTitle(value: string): string {
  return normalizeMusicTrackToken(value.replace(/（[^）]*）|\([^)]*\)|\[[^\]]*]|\{[^}]*}/g, ' '));
}

function primaryArtist(track: TrackDedupeInput): string {
  const artist = track.artist ?? track.artists?.join(' / ') ?? '';
  return artist.split(/\s*(?:\/|,|，|、|&|feat\.?|ft\.?|with)\s*/i)[0]?.trim() ?? '';
}

function parseDedupeKey(key: string): { title: string; artist: string } | null {
  const index = key.lastIndexOf(DEDUPE_KEY_SEPARATOR);
  if (index <= 0) return null;

  return {
    title: key.slice(0, index),
    artist: key.slice(index + DEDUPE_KEY_SEPARATOR.length)
  };
}

function areTitlesSimilar(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length >= MIN_CONTAINED_TITLE_LENGTH && longer.includes(shorter)) {
    return true;
  }

  const overlap = countMultisetCharacterOverlap(shorter, longer);
  return (
    shorter.length >= MIN_OVERLAP_TITLE_LENGTH
    && overlap / shorter.length >= MIN_SHORT_TITLE_COVERAGE
    && overlap / longer.length >= MIN_LONG_TITLE_COVERAGE
  );
}

function countMultisetCharacterOverlap(left: string, right: string): number {
  const rightCounts = new Map<string, number>();
  for (const char of right) {
    rightCounts.set(char, (rightCounts.get(char) ?? 0) + 1);
  }

  let overlap = 0;
  for (const char of left) {
    const count = rightCounts.get(char) ?? 0;
    if (count > 0) {
      overlap++;
      rightCounts.set(char, count - 1);
    }
  }

  return overlap;
}
