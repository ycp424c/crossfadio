import {
  loadEffectiveResourcePolicy,
  resolveUserTier,
  type ResourceOperation,
  type UserTier
} from './resource-policy.js';
import {
  reserveDailyCredits,
  DailyCreditsQuotaError
} from './store/resource-usage.js';

export type ResourceLimitErrorCode =
  | 'daily_quota_exceeded'
  | 'user_concurrency_exceeded'
  | 'standard_capacity_exceeded'
  | 'global_capacity_exceeded'
  | 'event_connection_limit_exceeded';

/** Operations that can carry a resource-limit error; event_sse is the
 *  persistent-connection admission used outside the permit system. */
export type ResourceLimitedOperation = ResourceOperation | 'event_sse';

export class ResourceLimitError extends Error {
  readonly code: ResourceLimitErrorCode;
  readonly operation: ResourceLimitedOperation;
  readonly retryAfterSeconds: number;

  constructor(code: ResourceLimitErrorCode, operation: ResourceLimitedOperation, retryAfterSeconds: number) {
    super(`resource limit: ${code} for ${operation}`);
    this.name = 'ResourceLimitError';
    this.code = code;
    this.operation = operation;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ResourcePermit = {
  tier: UserTier;
  operation: ResourceOperation;
  creditsUsed: number;
  creditsRemaining: number;
  release(): void;
};

// ── In-process concurrency state ──────────────────────────────────────────────
// Counters are per-process only: the plan explicitly documents that concurrency
// limits do not span multiple Node processes.

const activePermitsByUser = new Map<string, number>();
let standardOccupancy = 0;
let totalOccupancy = 0;

export function _resetResourceGovernorForTest(): void {
  activePermitsByUser.clear();
  standardOccupancy = 0;
  totalOccupancy = 0;
}

/**
 * Acquire a resource permit for one expensive operation.
 *
 * Admission order: validate concurrency limits, tentatively increment the
 * in-process counters, then reserve persistent daily credits. If the credit
 * reservation fails, counters are rolled back and a ResourceLimitError with
 * code `daily_quota_exceeded` is thrown. Credits are charged on admission;
 * downstream failures are not refunded.
 */
export function acquireResourcePermit(
  userId: string,
  operation: ResourceOperation,
  now?: Date
): ResourcePermit {
  const policy = loadEffectiveResourcePolicy();
  const tier = resolveUserTier(userId);

  const userCount = activePermitsByUser.get(userId) ?? 0;
  const userLimit = tier === 'priority'
    ? policy.priorityUserConcurrency
    : policy.standardUserConcurrency;
  if (userCount >= userLimit) {
    throw new ResourceLimitError('user_concurrency_exceeded', operation, policy.retryAfterSeconds);
  }

  if (tier === 'standard' && standardOccupancy >= policy.standardGlobalConcurrency) {
    throw new ResourceLimitError('standard_capacity_exceeded', operation, policy.retryAfterSeconds);
  }

  if (totalOccupancy >= policy.totalConcurrency) {
    throw new ResourceLimitError('global_capacity_exceeded', operation, policy.retryAfterSeconds);
  }

  activePermitsByUser.set(userId, userCount + 1);
  if (tier === 'standard') standardOccupancy += 1;
  totalOccupancy += 1;

  let reservation;
  try {
    const cost = policy.operationCosts[operation];
    const limit = tier === 'priority' ? policy.priorityDailyCredits : policy.standardDailyCredits;
    reservation = reserveDailyCredits({ userId, credits: cost, limit, now });
  } catch (err) {
    rollBackCounters(userId, tier);
    if (err instanceof DailyCreditsQuotaError) {
      throw new ResourceLimitError('daily_quota_exceeded', operation, policy.retryAfterSeconds);
    }
    throw err;
  }

  let released = false;
  return {
    tier,
    operation,
    creditsUsed: reservation.creditsUsed,
    creditsRemaining: reservation.creditsRemaining,
    release() {
      if (released) return;
      released = true;
      rollBackCounters(userId, tier);
    }
  };
}

function rollBackCounters(userId: string, tier: UserTier): void {
  const remaining = (activePermitsByUser.get(userId) ?? 1) - 1;
  if (remaining <= 0) activePermitsByUser.delete(userId);
  else activePermitsByUser.set(userId, remaining);
  if (tier === 'standard' && standardOccupancy > 0) standardOccupancy -= 1;
  if (totalOccupancy > 0) totalOccupancy -= 1;
}
