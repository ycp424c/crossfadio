import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-plan-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;

  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

function makePlan(date: string) {
  return {
    mode: 'plan' as const,
    date,
    segments: [
      {
        id: 'morning',
        label: '早晨',
        timeRange: '07:00–09:00',
        mood: '清醒',
        energyPct: 45,
        tracks: [{ query: 'test track', reason: 'because' }]
      }
    ],
    narrative: 'test plan'
  };
}

describe('plan store', () => {
  it('savePlan and loadLatestPlan round-trip', async () => {
    const { savePlan, loadLatestPlan, todayDateStr } = await import('../../src/server/store/plan');
    const date = todayDateStr();
    const plan = makePlan(date);
    savePlan(plan);
    const loaded = loadLatestPlan(date);
    expect(loaded).not.toBeNull();
    expect(loaded!.date).toBe(date);
    expect(loaded!.segments).toHaveLength(1);
    expect(loaded!.narrative).toBe('test plan');
  });

  it('loadLatestPlan returns null for missing date', async () => {
    const { loadLatestPlan } = await import('../../src/server/store/plan');
    const loaded = loadLatestPlan('1990-01-01');
    expect(loaded).toBeNull();
  });

  it('savePlan increments version on each save', async () => {
    const { savePlan, loadLatestPlan, todayDateStr } = await import('../../src/server/store/plan');
    const date = todayDateStr();
    savePlan(makePlan(date));
    const p2 = { ...makePlan(date), narrative: 'v2' };
    savePlan(p2);
    const loaded = loadLatestPlan(date);
    expect(loaded!.narrative).toBe('v2');
  });

  it('todayDateStr returns YYYY-MM-DD format', async () => {
    const { todayDateStr } = await import('../../src/server/store/plan');
    expect(todayDateStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('todayDateStr uses local date instead of UTC date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T18:30:00.000Z'));

    const { todayDateStr } = await import('../../src/server/store/plan');
    expect(todayDateStr()).toBe('2026-04-24');
  });
});
