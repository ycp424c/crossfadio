import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalEnv = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-resource-policy-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  process.env = { ...originalEnv };
  const { _resetResourcePolicyForTest } = await import('../../src/server/resource-policy');
  _resetResourcePolicyForTest();
});

describe('resolveUserTier', () => {
  it('treats allowlist members as priority users', async () => {
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), JSON.stringify(['12345', '67890']));
    const { loadAllowlist } = await import('../../src/server/allowlist');
    loadAllowlist();
    const { resolveUserTier } = await import('../../src/server/resource-policy');

    expect(resolveUserTier('12345')).toBe('priority');
    expect(resolveUserTier('67890')).toBe('priority');
  });

  it('treats everyone else as standard users', async () => {
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), JSON.stringify(['12345']));
    const { loadAllowlist } = await import('../../src/server/allowlist');
    loadAllowlist();
    const { resolveUserTier } = await import('../../src/server/resource-policy');

    expect(resolveUserTier('99999')).toBe('standard');
    expect(resolveUserTier('unknown-user')).toBe('standard');
  });

  it('treats users as standard when allowlist.json is empty or missing', async () => {
    fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '[]');
    const { loadAllowlist } = await import('../../src/server/allowlist');
    loadAllowlist();
    const { resolveUserTier } = await import('../../src/server/resource-policy');

    expect(resolveUserTier('12345')).toBe('standard');
  });
});

describe('effective resource policy', () => {
  async function loadPolicy() {
    const { loadEffectiveResourcePolicy } = await import('../../src/server/resource-policy');
    return loadEffectiveResourcePolicy();
  }

  it('exposes the documented defaults', async () => {
    const policy = await loadPolicy();

    expect(policy.totalConcurrency).toBe(4);
    expect(policy.standardGlobalConcurrency).toBe(2);
    expect(policy.standardUserConcurrency).toBe(1);
    expect(policy.priorityUserConcurrency).toBe(2);
    expect(policy.standardDailyCredits).toBe(200);
    expect(policy.priorityDailyCredits).toBe(5000);
    expect(policy.retryAfterSeconds).toBe(5);
    expect(policy.operationCosts).toEqual({
      chat: 4,
      dj_pick_next: 8,
      segue: 2,
      tts_preview: 2,
      taste_analysis: 40
    });
  });

  it('accepts positive-integer environment overrides', async () => {
    process.env.CROSSFADIO_RESOURCE_TOTAL_CONCURRENCY = '8';
    process.env.CROSSFADIO_RESOURCE_STANDARD_GLOBAL_CONCURRENCY = '3';
    process.env.CROSSFADIO_RESOURCE_STANDARD_USER_CONCURRENCY = '2';
    process.env.CROSSFADIO_RESOURCE_PRIORITY_USER_CONCURRENCY = '4';
    process.env.CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS = '500';
    process.env.CROSSFADIO_RESOURCE_PRIORITY_DAILY_CREDITS = '9000';

    const policy = await loadPolicy();

    expect(policy.totalConcurrency).toBe(8);
    expect(policy.standardGlobalConcurrency).toBe(3);
    expect(policy.standardUserConcurrency).toBe(2);
    expect(policy.priorityUserConcurrency).toBe(4);
    expect(policy.standardDailyCredits).toBe(500);
    expect(policy.priorityDailyCredits).toBe(9000);
  });

  it('falls back to safe defaults for invalid overrides', async () => {
    process.env.CROSSFADIO_RESOURCE_TOTAL_CONCURRENCY = 'abc';
    process.env.CROSSFADIO_RESOURCE_STANDARD_GLOBAL_CONCURRENCY = '-3';
    process.env.CROSSFADIO_RESOURCE_PRIORITY_USER_CONCURRENCY = '0';
    process.env.CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS = '1.5';

    const policy = await loadPolicy();

    expect(policy.totalConcurrency).toBe(4);
    expect(policy.standardGlobalConcurrency).toBe(2);
    expect(policy.priorityUserConcurrency).toBe(2);
    expect(policy.standardDailyCredits).toBe(200);
  });

  it('enforces standardGlobalConcurrency <= totalConcurrency', async () => {
    process.env.CROSSFADIO_RESOURCE_TOTAL_CONCURRENCY = '4';
    process.env.CROSSFADIO_RESOURCE_STANDARD_GLOBAL_CONCURRENCY = '10';

    const policy = await loadPolicy();

    expect(policy.standardGlobalConcurrency).toBeLessThanOrEqual(policy.totalConcurrency);
    expect(policy.standardGlobalConcurrency).toBe(4);
  });

  it('ensures every daily limit is at least the largest single-operation cost', async () => {
    process.env.CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS = '10';
    process.env.CROSSFADIO_RESOURCE_PRIORITY_DAILY_CREDITS = '20';

    const policy = await loadPolicy();

    const largestCost = Math.max(...Object.values(policy.operationCosts));
    expect(policy.standardDailyCredits).toBeGreaterThanOrEqual(largestCost);
    expect(policy.priorityDailyCredits).toBeGreaterThanOrEqual(largestCost);
  });

  it('defines costs for every charged operation', async () => {
    const { RESOURCE_OPERATIONS } = await import('../../src/server/resource-policy');
    const policy = await loadPolicy();

    expect(RESOURCE_OPERATIONS).toEqual(['chat', 'dj_pick_next', 'segue', 'tts_preview', 'taste_analysis']);
    for (const operation of RESOURCE_OPERATIONS) {
      expect(policy.operationCosts[operation]).toBeGreaterThan(0);
    }
  });
});
