export type SyncedLyricLine = {
  timeSec: number;
  text: string;
};

const LRC_LINE_PATTERN = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;

export function parseSyncedLyrics(raw: string): SyncedLyricLine[] {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const match = LRC_LINE_PATTERN.exec(line.trim());
      if (!match) return null;

      const [, minuteText, secondText, fractionText = '', text] = match;
      const fractionSec = fractionText ? Number(`0.${fractionText.padEnd(3, '0').slice(0, 3)}`) : 0;
      const timeSec = Number(minuteText) * 60 + Number(secondText) + fractionSec;

      return { timeSec, text: text.trim() };
    })
    .filter((line): line is SyncedLyricLine => Boolean(line && line.text));
}

export function getActiveLyricIndex(lines: SyncedLyricLine[], positionSec: number): number {
  if (lines.length === 0) return -1;

  const safePositionSec = Number.isFinite(positionSec) ? positionSec : 0;
  let activeIndex = 0;

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].timeSec > safePositionSec) break;
    activeIndex = index;
  }

  return activeIndex;
}
