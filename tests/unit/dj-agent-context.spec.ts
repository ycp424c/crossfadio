import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { appendDjEvent } from '../../src/server/store/dj-events';
import { savePersonalDjContext } from '../../src/server/store/personal-dj-context';
import { buildDjContextSnapshot } from '../../src/server/dj-agent/context';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-agent-context-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('DJAgent context snapshot', () => {
  it('nests MusicAgent context and exposes only safe Personal DJ Context fields', async () => {
    const now = new Date();
    savePersonalDjContext({
      userId: 'user-1',
      uploadedAt: hoursBefore(now, 4),
      payload: createPayload('trend-secret-bundle', '早上偏低能量，适合慢一点。')
    });
    savePersonalDjContext({
      userId: 'user-1',
      uploadedAt: hoursBefore(now, 1),
      payload: createPayload('current-secret-bundle', '正在写代码，适合稳定、低干扰的音乐。')
    });
    appendDjEvent({
      userId: 'user-1',
      type: 'directive_updated',
      payload: {
        directive: '接下来稳一点',
        source: 'chat'
      }
    });

    const snapshot = await buildDjContextSnapshot({
      userId: 'user-1',
      includeDailyTheme: false,
      now,
      recentEventLimit: 5
    });

    expect(snapshot.userId).toBe('user-1');
    expect(snapshot.musicSelectionContext.request).toBe('auto-fill');
    expect(snapshot.personalDjContext?.summary).toContain('正在写代码');
    expect(snapshot.personalDjContext?.trend).toHaveLength(1);
    expect(snapshot.personalDjContext?.trend[0].summary).toContain('早上偏低能量');
    expect(snapshot.recentEvents.map((event) => event.type)).toContain('directive_updated');

    const llmContextJson = JSON.stringify(snapshot.musicSelectionContext.personalDjContext);
    expect(llmContextJson).not.toContain('current-secret-bundle');
    expect(llmContextJson).not.toContain('trend-secret-bundle');
    expect(llmContextJson).not.toContain('sliceRefs');
    expect(llmContextJson).not.toContain('manual-input-v1:test');
  });
});

function createPayload(bundleId: string, summary: string) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-08T10:00:00+08:00',
    summary,
    currentState: {
      activity: 'coding',
      energy: 'medium',
      attention: 'low_distraction',
      mood: 'focused'
    },
    musicGuidance: {
      energyCurve: 'steady',
      preferredTextures: ['steady rhythm'],
      avoidTextures: ['too noisy'],
      vocalPreference: 'mixed',
      novelty: 'balanced'
    },
    musicHints: [
      {
        kind: 'style',
        label: 'low-distraction city pop',
        strength: 'medium',
        reason: 'fits current focus state'
      }
    ],
    segueGuidance: {
      tone: 'familiar but discreet',
      privacyRule: 'Acknowledge broad state only; do not reveal concrete private details.'
    },
    source: {
      kind: 'lifemesh_bundle',
      bundleId,
      sliceRefs: [
        {
          sliceId: `${bundleId}-slice`,
          evidenceRole: 'context',
          citationLabel: 'manual-input-v1:test'
        }
      ]
    }
  };
}

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}
