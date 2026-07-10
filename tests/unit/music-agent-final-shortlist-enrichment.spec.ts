import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';
import type { NcmLyric } from '../../src/shared/schema.js';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

const profile = {
  genres: ['ambient'],
  moods: ['calm'],
  energy: 'low',
  aggression: 'low',
  vocalIntensity: 'low',
  lyricThemes: ['reflection'],
  language: 'en'
} as const;

const confidence = {
  genres: 0.9,
  moods: 0.8,
  energy: 0.95,
  aggression: 0.9,
  vocalIntensity: 0.7,
  lyricThemes: 0.6,
  language: 0.99
} as const;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-shortlist-enrichment-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('final shortlist enrichment', () => {
  it('enriches only the ranked top 12 and preserves their order', async () => {
    const lyricIds: string[] = [];
    const ncmClient = createNcmClient({
      getLyric: async (id) => {
        lyricIds.push(id);
        return lyric(id);
      }
    });
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(15));

    expect(result.shortlist.map((candidate) => candidate.id)).toEqual(ids(12));
    expect(result.promptPackets.map((packet) => packet.id)).toEqual(ids(12));
    expect(lyricIds).toEqual(expect.arrayContaining(ids(12)));
    expect(lyricIds).not.toContain('track-12');
    expect(result.diagnostics.shortlistCount).toBe(12);
  });

  it('uses an exact-version valid cached assessment without NCM calls', async () => {
    const { recordMusicTrackLyricRefresh, saveMusicTrackSemanticProfile } =
      await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm',
      trackId: 'track-0',
      lyricStatus: 'available',
      lyricHash: 'cached-hash',
      extractionSummary: { lineCount: 3 },
      refreshedAt: '2026-07-10T00:00:00.000Z'
    });
    saveMusicTrackSemanticProfile({
      provider: 'ncm',
      trackId: 'track-0',
      analyzerVersion: 'lyrics-v1',
      lyricHash: 'cached-hash',
      profile,
      confidence,
      evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }],
      extractionSummary: { lineCount: 3 },
      analysisModel: 'analysis-model',
      lyricRefreshedAt: '2026-07-10T00:00:00.000Z'
    });
    const ncmClient = createNcmClient();
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(1));

    expect(ncmClient.getLyric).not.toHaveBeenCalled();
    expect(ncmClient.getSongWikiSummary).not.toHaveBeenCalled();
    expect(result.promptPackets[0]).toMatchObject({
      kind: 'profile',
      id: 'track-0',
      assessment: {
        id: 'track-0',
        profile,
        confidence,
        evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }]
      }
    });
    expect(result.diagnostics).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
  });

  it('builds bounded deterministic lyric evidence and wiki tags on a cache miss', async () => {
    const ncmClient = createNcmClient({
      getLyric: async (id) => lyric(id),
      getSongWikiSummary: async () => ({ song: { tags: ['ambient', 'dream pop'] } })
    });
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(1));

    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      id: 'track-0',
      name: 'Song 0',
      artist: 'Artist 0',
      lyricEvidence: {
        lyricStatus: 'available',
        sampleMode: 'full'
      },
      wikiTags: ['ambient', 'dream pop']
    });
    expect(JSON.stringify(result.promptPackets[0])).not.toContain('[00:00.00]');
    expect(result.diagnostics).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      lyricSuccess: 1,
      wikiSuccess: 1
    });
    const { getMusicTrackAnalysisCache } = await import('../../src/server/store/music-track-analysis-cache.js');
    expect(getMusicTrackAnalysisCache('ncm', 'track-0')).toMatchObject({
      lyricStatus: 'available',
      extractionSummary: {
        lineCount: 3,
        sampledCharCount: expect.any(Number)
      },
      profile: null
    });
  });

  it('limits candidate workers to the configured concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const ncmClient = createNcmClient({
      getLyric: async (id) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        return lyric(id);
      }
    });
    const enrich = await createEnricher(ncmClient, { maxConcurrency: 6 });

    await enrich(candidates(12));

    expect(maxActive).toBeLessThanOrEqual(6);
    expect(maxActive).toBe(6);
  });

  it('returns partial results at the shared deadline and retains every shortlist id', async () => {
    const ncmClient = createNcmClient({
      getLyric: (id, options) => id === 'track-0'
        ? Promise.resolve(lyric(id))
        : rejectWhenAborted(options?.signal),
      getSongWikiSummary: async () => ({ tags: ['ambient'] })
    });
    const enrich = await createEnricher(ncmClient, {
      maxConcurrency: 2,
      deadlineMs: 30
    });

    const result = await enrich(candidates(5));

    expect(result.promptPackets.map((packet) => packet.id)).toEqual(ids(5));
    expect(result.promptPackets[0]?.kind).toBe('evidence');
    expect(result.promptPackets.slice(1).some((packet) => packet.kind === 'base')).toBe(true);
    expect(result.diagnostics.deadlineReached).toBe(true);
    expect(result.diagnostics.lyricTimeout).toBeGreaterThan(0);
    expect(result.diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates a parent abort to NCM and still retains all packet ids', async () => {
    const observedSignals: AbortSignal[] = [];
    const ncmClient = createNcmClient({
      getLyric: (_id, options) => {
        if (options?.signal) observedSignals.push(options.signal);
        return rejectWhenAborted(options?.signal);
      }
    });
    const enrich = await createEnricher(ncmClient, { deadlineMs: 1_000 });
    const controller = new AbortController();
    const resultPromise = enrich(candidates(3), { signal: controller.signal });
    await delay(5);
    controller.abort();

    const result = await resultPromise;

    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(result.promptPackets.map((packet) => packet.id)).toEqual(ids(3));
    expect(result.promptPackets.every((packet) => packet.kind === 'base')).toBe(true);
    expect(result.diagnostics.deadlineReached).toBe(false);
  });

  it('splits the lyric character budget equally across misses and respects the total cap', async () => {
    const longLyric = Array.from(
      { length: 80 },
      (_, index) => `[00:${String(index % 60).padStart(2, '0')}.00]line ${index} ${'x'.repeat(30)}`
    ).join('\n');
    const ncmClient = createNcmClient({
      getLyric: async (id) => ({ id, lyric: longLyric, translation: null })
    });
    const enrich = await createEnricher(ncmClient, { maxLyricEvidenceChars: 1_000 });

    const result = await enrich(candidates(4));
    const sampled = result.promptPackets.map((packet) =>
      packet.kind === 'evidence' ? packet.lyricEvidence.sampledCharCount : -1
    );

    expect(new Set(sampled).size).toBe(1);
    expect(sampled.every((count) => count <= 250)).toBe(true);
    expect(result.diagnostics.sampledChars).toBeLessThanOrEqual(1_000);
  });

  it('uses a fresh one-day missing lyric cache without refetching lyrics', async () => {
    const now = Date.parse('2026-07-10T12:00:00.000Z');
    const { recordMusicTrackLyricRefresh } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm',
      trackId: 'track-0',
      lyricStatus: 'missing',
      lyricHash: null,
      extractionSummary: { reason: 'not_found' },
      refreshedAt: new Date(now - 23 * 60 * 60 * 1_000).toISOString()
    });
    const ncmClient = createNcmClient({
      getSongWikiSummary: async () => ({ tags: ['instrumental'] })
    });
    const enrich = await createEnricher(ncmClient, { now: () => now });

    const result = await enrich(candidates(1));

    expect(ncmClient.getLyric).not.toHaveBeenCalled();
    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      lyricEvidence: { lyricStatus: 'missing', sampledCharCount: 0 }
    });
    expect(result.diagnostics.lyricMissing).toBe(1);
  });

  it('does no NCM work or cache mutation when mode is off', async () => {
    const ncmClient = createNcmClient();
    const enrich = await createEnricher(ncmClient, { mode: 'off' });

    const result = await enrich(candidates(2));

    expect(ncmClient.getLyric).not.toHaveBeenCalled();
    expect(ncmClient.getSongWikiSummary).not.toHaveBeenCalled();
    expect(result.promptPackets.every((packet) => packet.kind === 'base')).toBe(true);
    expect(result.diagnostics).toMatchObject({
      cacheHits: 0,
      cacheMisses: 0,
      lyricSuccess: 0,
      lyricMissing: 0,
      wikiSuccess: 0,
      sampledChars: 0,
      deadlineReached: false
    });
    const { getMusicTrackAnalysisCaches } = await import('../../src/server/store/music-track-analysis-cache.js');
    expect(getMusicTrackAnalysisCaches('ncm', ids(2)).size).toBe(0);
  });

  it('classifies timed-out lyric and wiki requests separately from failures', async () => {
    const ncmClient = createNcmClient({
      getLyric: async (id) => id === 'track-0' ? lyric(id) : null,
      getSongWikiSummary: (_id, options) => rejectWhenAborted(options?.signal)
    });
    const enrich = await createEnricher(ncmClient, {
      maxConcurrency: 2,
      deadlineMs: 25
    });

    const result = await enrich(candidates(2));

    expect(result.diagnostics.wikiTimeout).toBeGreaterThan(0);
    expect(result.diagnostics.wikiFail).toBe(0);
    expect(result.diagnostics.deadlineReached).toBe(true);
  });
});

type NcmOptions = { signal?: AbortSignal; timeoutMs?: number };
type TestNcmClient = {
  getLyric: ReturnType<typeof vi.fn<(id: string, options?: NcmOptions) => Promise<NcmLyric | null>>>;
  getSongWikiSummary: ReturnType<typeof vi.fn<(id: string, options?: NcmOptions) => Promise<Record<string, unknown> | null>>>;
};

function createNcmClient(overrides: {
  getLyric?: (id: string, options?: NcmOptions) => Promise<NcmLyric | null>;
  getSongWikiSummary?: (id: string, options?: NcmOptions) => Promise<Record<string, unknown> | null>;
} = {}): TestNcmClient {
  return {
    getLyric: vi.fn(overrides.getLyric ?? (async (id) => lyric(id))),
    getSongWikiSummary: vi.fn(overrides.getSongWikiSummary ?? (async () => null))
  };
}

async function createEnricher(
  ncmClient: TestNcmClient,
  overrides: Partial<{
    mode: 'off' | 'shadow' | 'enforce_fit' | 'enforce_all';
    maxConcurrency: number;
    deadlineMs: number;
    maxLyricEvidenceChars: number;
    now: () => number;
  }> = {}
) {
  const { createFinalShortlistEnricher } =
    await import('../../src/server/music-agent/final-shortlist-enrichment.js');
  return createFinalShortlistEnricher({
    ncmClient,
    mode: 'shadow',
    analyzerVersion: 'lyrics-v1',
    analysisModel: 'analysis-model',
    ...overrides
  });
}

function candidate(index: number): MusicCandidate {
  return {
    id: `track-${index}`,
    name: `Song ${index}`,
    artist: `Artist ${index}`,
    sources: ['search'],
    evidence: [`ranked-${index}`],
    scores: {
      intentMatch: 0.8,
      tasteMatch: 0.7,
      timeFit: 0.6,
      contextFit: 0.5,
      novelty: 0.9,
      recentPenalty: 0,
      skipPenalty: 0,
      sourceConfidence: 0.8
    },
    qualitySignals: { instrumental: false }
  };
}

function candidates(count: number): MusicCandidate[] {
  return Array.from({ length: count }, (_, index) => candidate(index));
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `track-${index}`);
}

function lyric(id: string): NcmLyric {
  return {
    id,
    lyric: '[00:00.00]first line\n[00:10.00]second line\n[00:20.00]third line',
    translation: null
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (!signal) return;
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}
