import { isAllowed } from './allowlist.js';

export type UserTier = 'standard' | 'priority';

/**
 * Tier resolution: allowlist.json remains the backward-compatible source of
 * priority membership. It is NOT an authorization source — every valid NCM
 * account may authenticate regardless of tier.
 */
export function resolveUserTier(userId: string): UserTier {
  return isAllowed(userId) ? 'priority' : 'standard';
}

// ── Effective resource policy ─────────────────────────────────────────────────

export const RESOURCE_OPERATIONS = [
  'chat',
  'dj_pick_next',
  'segue',
  'tts_preview',
  'taste_analysis'
] as const;

export type ResourceOperation = (typeof RESOURCE_OPERATIONS)[number];

export type OperationCosts = Record<ResourceOperation, number>;

export type EffectiveResourcePolicy = {
  totalConcurrency: number;
  standardGlobalConcurrency: number;
  standardUserConcurrency: number;
  priorityUserConcurrency: number;
  standardDailyCredits: number;
  priorityDailyCredits: number;
  retryAfterSeconds: number;
  operationCosts: OperationCosts;
};

const DEFAULT_POLICY: EffectiveResourcePolicy = {
  totalConcurrency: 4,
  standardGlobalConcurrency: 2,
  standardUserConcurrency: 1,
  priorityUserConcurrency: 2,
  standardDailyCredits: 200,
  priorityDailyCredits: 5000,
  retryAfterSeconds: 5,
  operationCosts: {
    chat: 4,
    dj_pick_next: 8,
    segue: 2,
    tts_preview: 2,
    taste_analysis: 40
  }
};

let cachedPolicy: EffectiveResourcePolicy | null = null;

/**
 * Resolve the effective resource policy from environment overrides.
 * Invalid overrides fall back to safe defaults; cross-field constraints are
 * enforced (standardGlobalConcurrency <= totalConcurrency, and every daily
 * limit is at least the largest single-operation cost). The parsed policy is
 * cached — env changes only take effect after _resetResourcePolicyForTest.
 */
export function loadEffectiveResourcePolicy(): EffectiveResourcePolicy {
  if (cachedPolicy) return cachedPolicy;

  const parsed: EffectiveResourcePolicy = {
    ...DEFAULT_POLICY,
    operationCosts: { ...DEFAULT_POLICY.operationCosts }
  };

  parsed.totalConcurrency = parseIntEnv('CROSSFADIO_RESOURCE_TOTAL_CONCURRENCY', parsed.totalConcurrency);
  parsed.standardGlobalConcurrency = parseIntEnv(
    'CROSSFADIO_RESOURCE_STANDARD_GLOBAL_CONCURRENCY',
    parsed.standardGlobalConcurrency
  );
  parsed.standardUserConcurrency = parseIntEnv(
    'CROSSFADIO_RESOURCE_STANDARD_USER_CONCURRENCY',
    parsed.standardUserConcurrency
  );
  parsed.priorityUserConcurrency = parseIntEnv(
    'CROSSFADIO_RESOURCE_PRIORITY_USER_CONCURRENCY',
    parsed.priorityUserConcurrency
  );
  parsed.standardDailyCredits = parseIntEnv(
    'CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS',
    parsed.standardDailyCredits
  );
  parsed.priorityDailyCredits = parseIntEnv(
    'CROSSFADIO_RESOURCE_PRIORITY_DAILY_CREDITS',
    parsed.priorityDailyCredits
  );

  if (parsed.standardGlobalConcurrency > parsed.totalConcurrency) {
    parsed.standardGlobalConcurrency = parsed.totalConcurrency;
  }

  const largestOperationCost = Math.max(...Object.values(parsed.operationCosts));
  if (parsed.standardDailyCredits < largestOperationCost) {
    parsed.standardDailyCredits = largestOperationCost;
  }
  if (parsed.priorityDailyCredits < largestOperationCost) {
    parsed.priorityDailyCredits = largestOperationCost;
  }

  cachedPolicy = parsed;
  return parsed;
}

export function _resetResourcePolicyForTest(): void {
  cachedPolicy = null;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
