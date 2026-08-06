import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fragments } from '../../src/server/agent/schema';

let capturedFragments: Fragments | null = null;

vi.mock('../../src/server/agent/compute', () => ({
  computeStream: vi.fn(async function* (fragments: Fragments) {
    capturedFragments = fragments;
    yield { type: 'delta', say: '接上这一首' };
    yield {
      type: 'done',
      output: {
        mode: 'segue',
        say: '刚才那首把注意力铺稳了，下一首继续保持这个低干扰的推进。',
        duckingHintSec: 8,
        filterSweep: true,
        emotionTag: 'focused'
      }
    };
  })
}));

vi.mock('../../src/server/weather', () => ({
  fetchWeather: async () => null
}));

import { generateSegue } from '../../src/server/dj-agent/segue';
import { truncateTtsText } from '../../src/server/tts/client';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { appendDjEvent, getRecentDjEvents } from '../../src/server/store/dj-events';
import { getRecentSegues } from '../../src/server/store/segues';
import { savePersonalDjContext } from '../../src/server/store/personal-dj-context';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  capturedFragments = null;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-agent-segue-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  vi.clearAllMocks();
});

describe('DJAgent segue orchestration', () => {
  it('uses selection rationale and safe Personal DJ Context guidance, then records segue_generated', async () => {
    const now = new Date(Date.now() + 1_000);
    savePersonalDjContext({
      userId: 'segue-user',
      payload: createPersonalContextPayload('secret-bundle')
    });
    const selection = appendDjEvent({
      userId: 'segue-user',
      type: 'track_selected',
      correlationId: 'run-1',
      runId: 'run-1',
      trackId: 'to-1',
      payload: {
        trackId: 'to-1',
        trackName: 'Next Song',
        artist: 'Next Artist',
        selectionRationale: '它能延续低干扰节奏，并给一点轻微上扬。',
        batchRationale: '保持稳定推进。',
        source: 'search',
        pickOrder: 1
      }
    });

    const deltas: string[] = [];
    const result = await generateSegue({
      userId: 'segue-user',
      from: { id: 'from-1', name: 'From Song', artist: 'From Artist' },
      to: { id: 'to-1', name: 'Next Song', artist: 'Next Artist' },
      ncmClient: {
        getSongDetails: async () => [
          { id: 'from-1', name: 'From Song', artists: ['From Artist'] },
          { id: 'to-1', name: 'Next Song', artists: ['Next Artist'] }
        ],
        getLyric: async () => null,
        getSongWikiSummary: async () => null
      } as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      emitDelta: (say) => deltas.push(say),
      now
    });

    expect(result?.segue.say).toContain('低干扰');
    expect(result?.selectionEvent?.id).toBe(selection.id);
    expect(deltas).toEqual(['接上这一首']);

    expect(capturedFragments?.djMemory.purpose).toBe('segue');
    expect(capturedFragments?.djMemory.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'segue_privacy_rule', value: '只提宽泛状态，不暴露原始记录。' }),
      expect.objectContaining({ key: 'session_continuity', value: expect.stringContaining('低干扰') })
    ]));
    expect(capturedFragments?.input.kind).toBe('segueTrigger');
    if (capturedFragments?.input.kind !== 'segueTrigger') throw new Error('expected segueTrigger');
    expect(capturedFragments.input.context?.selectionRationale).toBe('它能延续低干扰节奏，并给一点轻微上扬。');
    expect(capturedFragments.input.context).not.toHaveProperty('personalSegueGuidance');
    expect(JSON.stringify(capturedFragments.input.context)).not.toContain('secret-bundle');
    expect(JSON.stringify(capturedFragments.input.context)).not.toContain('sliceRefs');
    expect(JSON.stringify(capturedFragments.input.context)).not.toContain('citationLabel');

    const segueEvent = getRecentDjEvents('segue-user')
      .find((event) => event.type === 'segue_generated');
    expect(segueEvent).toMatchObject({
      correlationId: 'run-1',
      causationEventId: selection.id,
      runId: 'run-1',
      trackId: 'to-1'
    });
    expect(segueEvent?.payload).toMatchObject({
      fromTrackId: 'from-1',
      toTrackId: 'to-1',
      selectionEventId: selection.id,
      segueSummary: '刚才那首把注意力铺稳了，下一首继续保持这个低干扰的推进。'
    });
  });

  it('truncates say once before save, return, and event emission when maxSayUnits is set', async () => {
    const original = '刚才那首把注意力铺稳了，下一首继续保持这个低干扰的推进。';
    const truncated = truncateTtsText(original, 10);
    expect(truncated).toBe('刚才那首把注意力铺稳');

    const result = await generateSegue({
      userId: 'segue-user',
      from: { id: 'from-1', name: 'From Song', artist: 'From Artist' },
      to: { id: 'to-1', name: 'Next Song', artist: 'Next Artist' },
      ncmClient: {
        getSongDetails: async () => [
          { id: 'from-1', name: 'From Song', artists: ['From Artist'] },
          { id: 'to-1', name: 'Next Song', artists: ['Next Artist'] }
        ],
        getLyric: async () => null,
        getSongWikiSummary: async () => null
      } as never,
      llmConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model' },
      maxSayUnits: 10
    });

    // 返回、落库、SSE 事件三处必须使用同一个截断结果，保证前端展示/估时/合成文本一致。
    expect(result?.segue.say).toBe(truncated);
    expect(getRecentSegues('segue-user')[0].say).toBe(truncated);
    const segueEvent = getRecentDjEvents('segue-user')
      .find((event) => event.type === 'segue_generated');
    expect(segueEvent?.payload?.segueSummary).toBe(truncated);
  });
});

function createPersonalContextPayload(bundleId: string) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: '正在写代码，适合稳定、低干扰的音乐。',
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
      tone: '熟悉但克制',
      privacyRule: '只提宽泛状态，不暴露原始记录。'
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
