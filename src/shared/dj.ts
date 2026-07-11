export const AUTO_FILL_BATCH_SIZE_MIN = 2;
export const AUTO_FILL_BATCH_SIZE_MAX = 5;
export const DEFAULT_AUTO_FILL_BATCH_SIZE = 2;
export const AUTO_FILL_LOW_WATER_MARK = 5;
export const AUTO_FILL_BATCH_SIZE_OPTIONS = [2, 3, 4, 5] as const;
export const DISCOVERY_MODE_VALUES = ['explore', 'comfort', 'legacy'] as const;

export type AutoFillBatchSize = typeof AUTO_FILL_BATCH_SIZE_OPTIONS[number];
export type DiscoveryMode = typeof DISCOVERY_MODE_VALUES[number];

export function parseAutoFillBatchSize(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= AUTO_FILL_BATCH_SIZE_MIN &&
    value <= AUTO_FILL_BATCH_SIZE_MAX
  ) {
    return value;
  }

  return DEFAULT_AUTO_FILL_BATCH_SIZE;
}

export function parseDiscoveryMode(value: unknown): DiscoveryMode {
  if (value === 'comfort' || value === 'legacy') return value;
  return 'explore';
}
