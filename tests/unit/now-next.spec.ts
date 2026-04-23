import { describe, expect, it } from 'vitest';
import {
  estimateDurationMs,
  parseQueueIds,
  pickNextTrackId
} from '../../src/main/server/routes/now-next';

describe('parseQueueIds', () => {
  it('parses csv queue and trims blanks', () => {
    expect(parseQueueIds('1, 2 , ,3')).toEqual(['1', '2', '3']);
  });
});

describe('pickNextTrackId', () => {
  it('returns first track when current missing', () => {
    expect(pickNextTrackId(['10', '11', '12'])).toBe('10');
  });

  it('returns next track after current', () => {
    expect(pickNextTrackId(['10', '11', '12'], '11')).toBe('12');
  });

  it('returns null at queue tail', () => {
    expect(pickNextTrackId(['10', '11'], '11')).toBeNull();
  });
});

describe('estimateDurationMs', () => {
  it('estimates duration from file size and bitrate', () => {
    expect(estimateDurationMs(8_000_000, 320_000)).toBe(200000);
  });

  it('returns null for invalid values', () => {
    expect(estimateDurationMs(null, 320_000)).toBeNull();
    expect(estimateDurationMs(8_000_000, null)).toBeNull();
    expect(estimateDurationMs(0, 320_000)).toBeNull();
    expect(estimateDurationMs(8_000_000, 0)).toBeNull();
  });
});
