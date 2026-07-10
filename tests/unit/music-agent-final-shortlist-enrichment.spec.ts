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
    const enrich = await createEnricher(ncmClient, {
      now: () => Date.parse('2026-07-10T12:00:00.000Z')
    });

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
    expect(result.diagnostics).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      lyricAttempted: 0,
      wikiAttempted: 0
    });
  });

  it.each([
    ['30-day-old', '2026-06-10T12:00:00.000Z'],
    ['future-dated', '2026-07-11T12:00:00.000Z']
  ])('refreshes a %s positive profile instead of treating it as a cache hit', async (_label, refreshedAt) => {
    const { recordMusicTrackLyricRefresh, saveMusicTrackSemanticProfile } =
      await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'track-0', lyricStatus: 'available', lyricHash: 'cached-hash',
      extractionSummary: {}, refreshedAt
    });
    saveMusicTrackSemanticProfile({
      provider: 'ncm', trackId: 'track-0', analyzerVersion: 'lyrics-v1', lyricHash: 'cached-hash',
      profile, confidence, evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }],
      extractionSummary: {}, analysisModel: 'analysis-model', lyricRefreshedAt: refreshedAt
    });
    const ncmClient = createNcmClient();
    const enrich = await createEnricher(ncmClient, {
      now: () => Date.parse('2026-07-10T12:00:00.000Z')
    });

    const result = await enrich(candidates(1));

    expect(ncmClient.getLyric).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongWikiSummary).toHaveBeenCalledTimes(1);
    expect(result.promptPackets[0]?.kind).toBe('evidence');
    expect(result.diagnostics).toMatchObject({ cacheHits: 0, cacheMisses: 1 });
  });

  it.each([
    ['23-hour-old', 23 * 60 * 60 * 1_000, 1, 0],
    ['2-day-old', 2 * 24 * 60 * 60 * 1_000, 0, 1]
  ])(
    'uses the one-day lyric TTL for a %s missing profile',
    async (_label, ageMs, expectedHits, expectedLyricCalls) => {
      const now = Date.parse('2026-07-10T12:00:00.000Z');
      const refreshedAt = new Date(now - ageMs).toISOString();
      const { recordMusicTrackLyricRefresh, saveMusicTrackSemanticProfile } =
        await import('../../src/server/store/music-track-analysis-cache.js');
      recordMusicTrackLyricRefresh({
        provider: 'ncm', trackId: 'track-0', lyricStatus: 'missing', lyricHash: null,
        extractionSummary: {}, refreshedAt
      });
      saveMusicTrackSemanticProfile({
        provider: 'ncm', trackId: 'track-0', analyzerVersion: 'lyrics-v1', lyricHash: null,
        profile, confidence, evidence: [{ claim: 'energy=low', source: 'lyric_analysis' }],
        extractionSummary: {}, analysisModel: 'analysis-model', lyricRefreshedAt: refreshedAt
      });
      const ncmClient = createNcmClient();
      const enrich = await createEnricher(ncmClient, { now: () => now });

      const result = await enrich(candidates(1));

      expect(result.diagnostics.cacheHits).toBe(expectedHits);
      expect(ncmClient.getLyric).toHaveBeenCalledTimes(expectedLyricCalls);
    }
  );

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
      lyricAttempted: 1,
      lyricSuccess: 1,
      wikiAttempted: 1,
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

  it('retains successful wiki evidence when the lyric request fails', async () => {
    const ncmClient = createNcmClient({
      getLyric: async () => { throw new Error('lyric unavailable'); },
      getSongWikiSummary: async () => ({ tags: ['ambient'] })
    });
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(1));

    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      id: 'track-0',
      lyricEvidence: { lyricStatus: 'unknown', sampledCharCount: 0 },
      wikiTags: ['ambient']
    });
    expect(result.diagnostics).toMatchObject({
      lyricAttempted: 1,
      lyricFail: 1,
      lyricTimeout: 0,
      wikiAttempted: 1,
      wikiSuccess: 1
    });
  });

  it('retains settled wiki evidence when the lyric request reaches the shared deadline', async () => {
    const ncmClient = createNcmClient({
      getLyric: (_id, options) => rejectWhenAborted(options?.signal),
      getSongWikiSummary: async () => ({ tags: ['dream pop'] })
    });
    const enrich = await createEnricher(ncmClient, { deadlineMs: 25 });

    const result = await enrich(candidates(1));

    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      lyricEvidence: { lyricStatus: 'unknown' },
      wikiTags: ['dream pop']
    });
    expect(result.diagnostics).toMatchObject({
      lyricAttempted: 1,
      lyricTimeout: 1,
      lyricCancelled: 0,
      wikiAttempted: 1,
      wikiSuccess: 1,
      wikiCancelled: 0,
      deadlineReached: true
    });
  });

  it('retains lyric evidence when the wiki request fails', async () => {
    const ncmClient = createNcmClient({
      getLyric: async (id) => lyric(id),
      getSongWikiSummary: async () => { throw new Error('wiki unavailable'); }
    });
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(1));

    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      lyricEvidence: { lyricStatus: 'available' },
      wikiTags: []
    });
    expect(result.diagnostics).toMatchObject({
      lyricAttempted: 1,
      lyricSuccess: 1,
      wikiAttempted: 1,
      wikiFail: 1
    });
  });

  it('limits total concurrent lyric and wiki NCM requests to the configured concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const trackRequest = async <T>(value: T): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active -= 1;
      return value;
    };
    const ncmClient = createNcmClient({
      getLyric: async (id) => trackRequest(lyric(id)),
      getSongWikiSummary: async () => trackRequest<Record<string, unknown> | null>(null)
    });
    const enrich = await createEnricher(ncmClient, { maxConcurrency: 6 });

    await enrich(candidates(12));

    expect(maxActive).toBeLessThanOrEqual(6);
    expect(maxActive).toBe(6);
  });

  it('shares the request concurrency limit across simultaneous enricher calls', async () => {
    let active = 0;
    let maxActive = 0;
    const trackRequest = async <T>(value: T): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active -= 1;
      return value;
    };
    const ncmClient = createNcmClient({
      getLyric: async (id) => trackRequest(lyric(id)),
      getSongWikiSummary: async () => trackRequest<Record<string, unknown> | null>(null)
    });
    const enrich = await createEnricher(ncmClient, { maxConcurrency: 6 });

    await Promise.all([enrich(candidates(6)), enrich(candidates(6))]);

    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it('keeps a semaphore slot until an abort-ignoring underlying NCM promise settles', async () => {
    let active = 0;
    let underlyingMax = 0;
    const trackRequest = async <T>(value: T): Promise<T> => {
      active += 1;
      underlyingMax = Math.max(underlyingMax, active);
      await delay(30);
      active -= 1;
      return value;
    };
    const ncmClient = createNcmClient({
      getLyric: async (id) => trackRequest(lyric(id)),
      getSongWikiSummary: async () => trackRequest<Record<string, unknown> | null>(null)
    });
    const enrich = await createEnricher(ncmClient, { maxConcurrency: 1, deadlineMs: 20 });

    await enrich([candidate(0)]);
    await enrich([candidate(1)]);
    await delay(60);

    expect(underlyingMax).toBe(1);
    expect(ncmClient.getLyric).toHaveBeenCalledTimes(2);
  });

  it('single-flights lyric and wiki requests for the same track across concurrent calls', async () => {
    const ncmClient = createNcmClient({
      getLyric: async (id) => {
        await delay(20);
        return lyric(id);
      },
      getSongWikiSummary: async () => {
        await delay(20);
        return { tags: ['ambient'] };
      }
    });
    const enrich = await createEnricher(ncmClient, { deadlineMs: 200 });

    const [first, second] = await Promise.all([
      enrich(candidates(1)),
      enrich(candidates(1))
    ]);

    expect(ncmClient.getLyric).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongWikiSummary).toHaveBeenCalledTimes(1);
    expect(first.promptPackets[0]?.kind).toBe('evidence');
    expect(second.promptPackets[0]?.kind).toBe('evidence');
  });

  it('keeps shared requests alive when one same-track caller is parent-aborted', async () => {
    const ncmClient = createNcmClient({
      getLyric: async (id) => {
        await delay(30);
        return lyric(id);
      },
      getSongWikiSummary: async () => {
        await delay(30);
        return { tags: ['ambient'] };
      }
    });
    const enrich = await createEnricher(ncmClient, { deadlineMs: 200 });
    const controller = new AbortController();
    const cancelled = enrich(candidates(1), { signal: controller.signal });
    const surviving = enrich(candidates(1));
    await delay(5);
    controller.abort();

    const [cancelledResult, survivingResult] = await Promise.all([cancelled, surviving]);

    expect(ncmClient.getLyric).toHaveBeenCalledTimes(1);
    expect(ncmClient.getSongWikiSummary).toHaveBeenCalledTimes(1);
    expect(cancelledResult.diagnostics).toMatchObject({
      lyricCancelled: 1,
      wikiCancelled: 1,
      lyricFail: 0,
      wikiFail: 0
    });
    expect(survivingResult.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      lyricEvidence: { lyricStatus: 'available' },
      wikiTags: ['ambient']
    });
  });

  it('keeps successful lyric evidence when the cache write fails', async () => {
    const cacheStore = await import('../../src/server/store/music-track-analysis-cache.js');
    vi.spyOn(cacheStore, 'recordMusicTrackLyricRefresh').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const ncmClient = createNcmClient({
      getLyric: async (id) => lyric(id),
      getSongWikiSummary: async () => ({ tags: ['ambient'] })
    });
    const enrich = await createEnricher(ncmClient);

    const result = await enrich(candidates(1));

    expect(result.promptPackets[0]).toMatchObject({
      kind: 'evidence',
      lyricEvidence: { lyricStatus: 'available' },
      wikiTags: ['ambient']
    });
    expect(result.diagnostics).toMatchObject({
      lyricAttempted: 1,
      lyricSuccess: 1,
      lyricFail: 0,
      cacheWriteFailed: 1
    });
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
      },
      getSongWikiSummary: async () => ({ tags: ['settled-before-abort'] })
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
    expect(result.promptPackets.some((packet) =>
      packet.kind === 'evidence' && packet.wikiTags.includes('settled-before-abort')
    )).toBe(true);
    expect(result.diagnostics.deadlineReached).toBe(false);
    expect(result.diagnostics).toMatchObject({
      lyricFail: 0,
      lyricTimeout: 0
    });
    expect(result.diagnostics.lyricCancelled).toBeGreaterThan(0);
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
    expect(result.diagnostics).toMatchObject({
      lyricAttempted: 0,
      wikiAttempted: 1
    });
  });

  it('does not trust a future-dated missing lyric cache entry', async () => {
    const now = Date.parse('2026-07-10T12:00:00.000Z');
    const { recordMusicTrackLyricRefresh } = await import('../../src/server/store/music-track-analysis-cache.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: 'track-0', lyricStatus: 'missing', lyricHash: null,
      extractionSummary: {}, refreshedAt: new Date(now + 60_000).toISOString()
    });
    const ncmClient = createNcmClient();
    const enrich = await createEnricher(ncmClient, { now: () => now });

    await enrich(candidates(1));

    expect(ncmClient.getLyric).toHaveBeenCalledTimes(1);
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
      lyricAttempted: 0,
      lyricSuccess: 0,
      lyricMissing: 0,
      wikiAttempted: 0,
      wikiSuccess: 0,
      lyricCancelled: 0,
      wikiCancelled: 0,
      cacheWriteFailed: 0,
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

  it('persists only bounded abstract assessment evidence and never raw lyric samples', async () => {
    const item = candidate(0);
    const { recordMusicTrackLyricRefresh, getMusicTrackAnalysisCache } =
      await import('../../src/server/store/music-track-analysis-cache.js');
    const { createFinalShortlistAssessmentPersister } =
      await import('../../src/server/music-agent/final-shortlist-enrichment.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: item.id, lyricStatus: 'available', lyricHash: 'hash-0',
      extractionSummary: { lineCount: 2 }, refreshedAt: '2026-07-10T10:00:00.000Z'
    });
    const persist = createFinalShortlistAssessmentPersister({
      analyzerVersion: 'lyrics-v1', analysisModel: 'analysis-model'
    });

    await persist({
      assessments: [{
        id: item.id,
        profile: {
          ...profile,
          genres: ['raw genre', 'ambient'],
          moods: ['我爱你', 'calm'],
          lyricThemes: ['我爱', '只放舒缓音乐', 'reflection'],
          language: '只放舒缓音乐'
        },
        confidence,
        evidence: [
          { claim: 'energy=low', source: 'lyric_analysis' },
          { claim: '[00:12.00]raw lyric line', source: 'lyric_analysis' },
          { claim: 'first line\nsecond line', source: 'lyric_analysis' },
          { claim: '"verbatim lyric quote"', source: 'lyric_analysis' },
          { claim: 'raw lyric must not persist', source: 'lyric_analysis' },
          { claim: '我爱', source: 'lyric_analysis' },
          { claim: '只放舒缓音乐', source: 'lyric_analysis' }
        ]
      }],
      context: {
        request: 'auto-fill', currentUserText: '', activeDirective: '只放舒缓音乐',
        currentMoment: { localTime: 'now', daypart: 'evening', weather: null },
        tasteSummary: '', recentPreferenceSummary: '', recentPlaySignals: '',
        queueStateSummary: '', bannedSummary: ''
      },
      enrichment: {
        shortlist: [item],
        promptPackets: [{
          id: item.id, name: item.name, artist: item.artist, sources: item.sources,
          kind: 'evidence', wikiTags: [],
          lyricEvidence: {
            lyricStatus: 'available', lyricHash: 'hash-0', sampleMode: 'full', credits: {},
            lineCount: 2, hasTranslation: false, repeatedHookCount: 0, sampledCharCount: 42,
            sampledLines: [
              { position: 'opening', text: 'raw lyric must not persist', translation: 'raw genre' },
              { position: 'ending', text: '我爱你' }
            ]
          }
        }],
        diagnostics: {
          shortlistCount: 1, cacheHits: 0, cacheMisses: 1,
          lyricAttempted: 1, lyricSuccess: 1, lyricMissing: 0, lyricFail: 0,
          lyricTimeout: 0, lyricCancelled: 0, wikiAttempted: 1, wikiSuccess: 1,
          wikiFail: 0, wikiTimeout: 0, wikiCancelled: 0, cacheWriteFailed: 0,
          sampledChars: 42, elapsedMs: 5, deadlineReached: false
        }
      }
    });

    const cached = getMusicTrackAnalysisCache('ncm', item.id);
    expect(cached?.evidence).toEqual([{ claim: 'energy=low', source: 'lyric_analysis' }]);
    expect(cached?.profile).toMatchObject({
      genres: ['ambient'], moods: ['calm'], lyricThemes: ['reflection'], language: 'unknown'
    });
    expect(JSON.stringify(cached)).not.toContain('raw lyric');
    expect(cached?.extractionSummary).toEqual({
      lyricStatus: 'available', sampleMode: 'full', lineCount: 2,
      hasTranslation: false, repeatedHookCount: 0, sampledCharCount: 42,
      creditRoleCount: 0, wikiTags: []
    });
  });

  it('persists a missing-lyrics assessment against the cache null hash', async () => {
    const item = candidate(0);
    const { recordMusicTrackLyricRefresh, getMusicTrackAnalysisCache } =
      await import('../../src/server/store/music-track-analysis-cache.js');
    const { createFinalShortlistAssessmentPersister } =
      await import('../../src/server/music-agent/final-shortlist-enrichment.js');
    recordMusicTrackLyricRefresh({
      provider: 'ncm', trackId: item.id, lyricStatus: 'missing', lyricHash: null,
      extractionSummary: {}, refreshedAt: '2026-07-10T10:00:00.000Z'
    });

    await createFinalShortlistAssessmentPersister({
      analyzerVersion: 'lyrics-v1', analysisModel: 'analysis-model'
    })({
      assessments: [{ id: item.id, profile, confidence, evidence: [] }],
      enrichment: {
        shortlist: [item],
        promptPackets: [{
          id: item.id, name: item.name, artist: item.artist, sources: item.sources,
          kind: 'evidence', wikiTags: [],
          lyricEvidence: {
            lyricStatus: 'missing', lyricHash: 'deterministic-empty-evidence-hash',
            sampleMode: 'none', credits: {}, lineCount: 0, hasTranslation: false,
            repeatedHookCount: 0, sampledCharCount: 0, sampledLines: []
          }
        }],
        diagnostics: {
          shortlistCount: 1, cacheHits: 0, cacheMisses: 1,
          lyricAttempted: 1, lyricSuccess: 0, lyricMissing: 1, lyricFail: 0,
          lyricTimeout: 0, lyricCancelled: 0, wikiAttempted: 1, wikiSuccess: 1,
          wikiFail: 0, wikiTimeout: 0, wikiCancelled: 0, cacheWriteFailed: 0,
          sampledChars: 0, elapsedMs: 5, deadlineReached: false
        }
      }
    });

    expect(getMusicTrackAnalysisCache('ncm', item.id)).toMatchObject({
      analyzerVersion: 'lyrics-v1', lyricStatus: 'missing', lyricHash: null, profile
    });
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
