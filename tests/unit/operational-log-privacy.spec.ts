import { describe, expect, it, vi } from 'vitest';
import { createPreferenceExtractionRuntime } from '../../src/server/jobs/preference-extraction-runtime.js';
import { createSelectionNarrationRuntime } from '../../src/server/jobs/selection-narration-runtime.js';
import { createExplicitExclusionResolutionRuntime } from '../../src/server/jobs/explicit-exclusion-resolution-runtime.js';
import {
  projectMusicAgentFallbackEventForLog,
  type MusicAgentFallbackStats
} from '../../src/server/music-agent/index.js';
import type { MusicAgentFallbackLogEvent } from '../../src/server/music-agent/loop.js';

const privateProviderBody = 'private provider response containing prompt context';

describe('operational log privacy', () => {
  it.each([
    ['preference extraction', createPreferenceExtractionRuntime],
    ['selection narration', createSelectionNarrationRuntime]
  ] as const)('%s worker logs only a safe error projection', (_name, createRuntime) => {
    const logger = { warn: vi.fn() };
    let onError: ((error: unknown) => void) | undefined;
    createRuntime({
      logger,
      createWorker(options: { onError?: (error: unknown) => void }) {
        onError = options.onError;
        return {
          runOnce: vi.fn(),
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
          preempt: vi.fn()
        } as never;
      }
    } as never);

    onError?.(Object.assign(new Error(privateProviderBody), {
      status: 503,
      responseBody: privateProviderBody
    }));

    expect(logger.warn).toHaveBeenCalledWith({
      error: { code: 'provider_server_error', status: 503 }
    }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privateProviderBody);
  });

  it('explicit exclusion worker logs only a safe error projection', () => {
    const logger = { warn: vi.fn() };
    let onError: ((error: unknown) => void) | undefined;
    createExplicitExclusionResolutionRuntime({
      ncmBaseUrl: 'https://ncm.example.test',
      logger,
      createWorker(options: { onError?: (error: unknown) => void }) {
        onError = options.onError;
        return {
          runOnce: vi.fn(),
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
          preempt: vi.fn()
        } as never;
      }
    } as never);

    onError?.(Object.assign(new Error(privateProviderBody), {
      status: 503,
      responseBody: privateProviderBody
    }));

    expect(logger.warn).toHaveBeenCalledWith({
      error: { code: 'provider_server_error', status: 503 }
    }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privateProviderBody);
  });

  it('omits the account id from routine MusicAgent fallback logs', () => {
    const event: MusicAgentFallbackLogEvent & { userId: string } = {
      userId: 'private-account-id',
      reason: 'budget_reached',
      mode: 'pick_next',
      status: 'empty_pool',
      candidateCount: 0,
      pickCount: 0,
      step: 1,
      llmCalls: 1,
      toolCalls: 0,
      elapsedMs: 25,
      budget: {
        maxMs: 1_000,
        maxSteps: 1,
        maxLlmCalls: 1,
        maxToolCalls: 1,
        maxNcmSearches: 1,
        maxPlaylistFetches: 1,
        maxTrendFetchMs: 100,
        maxCandidates: 10
      }
    };
    const stats: MusicAgentFallbackStats = {
      totalRuns: 1,
      convergenceRuns: 0,
      fallbackRuns: 1,
      fallbackRate: 1,
      fallbackReasons: { budget_reached: 1 }
    };

    const projected = projectMusicAgentFallbackEventForLog(event, stats);

    expect(projected).not.toHaveProperty('userId');
    expect(JSON.stringify(projected)).not.toContain(event.userId);
  });
});
