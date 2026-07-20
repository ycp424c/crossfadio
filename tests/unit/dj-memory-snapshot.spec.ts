import { describe, expect, it, vi } from 'vitest';
import { createMusicAgentSelectionAdapter } from '../../src/server/dj-memory/music-agent-adapter';
import { buildDjMemorySnapshot } from '../../src/server/dj-memory/snapshot';
import { DJ_MEMORY_SELECTION_PRESSURE_LIMIT } from '../../src/server/dj-memory/schema';

describe('DJ Memory Snapshot', () => {
  it('loads sources together and separates current track from upcoming queue', async () => {
    const started: string[] = [];
    let release: (() => void) | null = null;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const load = <T>(name: string, value: T) => vi.fn(async () => {
      started.push(name);
      if (started.length === 11) release?.();
      await barrier;
      return value;
    });

    const snapshotPromise = buildDjMemorySnapshot({
      userId: 'user-snapshot',
      now: new Date('2026-07-17T04:00:00.000Z'),
      deps: {
        loadQueue: load('queue', {
          queue: [
            { ncmId: 'past', name: 'Past', artists: ['Past Artist'] },
            { ncmId: 'current', name: 'Current', artists: ['Current Artist'] },
            { ncmId: 'next', name: 'Next', artists: ['Next Artist'] }
          ],
          currentIndex: 1
        }),
        loadEpisodes: load('episodes', []),
        loadPreferenceEvidence: load('preferences', []),
        loadTasteProfile: load('taste', null),
        loadActiveDirective: load('directive', null),
        loadExclusions: load('exclusions', { explicit: [], temporary: [] }),
        loadPersonalContext: load('pdc', null),
        loadRetrievalHistory: load('retrieval', []),
        loadConfiguration: load('configuration', []),
        loadSelectionContext: load('selection-context', {
          discoveryMode: 'comfort' as const,
          dailyTheme: { theme: '盛夏微风', keywords: ['city pop', '清亮'] }
        }),
        loadSessionEvents: load('events', []),
        loadWeather: vi.fn(async () => ({ location: 'Shanghai', tempC: 30, desc: '晴' }))
      }
    });
    await vi.waitFor(() => expect(started).toHaveLength(11));
    const snapshot = await snapshotPromise;

    expect(snapshot.queue.currentTrack?.id).toBe('current');
    expect(snapshot.queue.upcoming.map((track) => track.id)).toEqual(['next']);
    expect(snapshot.queue.upcoming.map((track) => track.id)).not.toContain('current');
    expect(snapshot.weather).toEqual({ location: 'Shanghai', tempC: 30, desc: '晴' });
    expect(snapshot.selectionContext).toEqual({
      discoveryMode: 'comfort',
      dailyTheme: { theme: '盛夏微风', keywords: ['city pop', '清亮'] }
    });
    expect(snapshot.metadata.sources.find((source) => source.kind === 'queue')).toEqual(
      expect.objectContaining({ authority: 'authoritative', recordCount: 2 })
    );
  });

  it('does not revive a stale event directive when the authoritative directive is absent', async () => {
    const snapshot = await buildDjMemorySnapshot({
      userId: 'user-authority',
      now: new Date('2026-07-17T04:00:00.000Z'),
      deps: emptyDeps({
        loadSessionEvents: async () => [{
          id: 'event-1',
          type: 'directive_updated',
          createdAt: '2026-07-17T03:00:00.000Z',
          payload: { directive: '旧指令：只放摇滚', source: 'chat' }
        }]
      })
    });

    expect(snapshot.activeDirective).toBeNull();
    expect(snapshot.sessionLog).toEqual([]);
  });

  it('derives a 24-hour temporary exclusion only for skips before halfway', async () => {
    const snapshot = await buildDjMemorySnapshot({
      userId: 'user-skip-boundary',
      now: new Date('2026-07-17T12:00:00.000Z'),
      deps: emptyDeps({
        loadEpisodes: async () => [
          episode({
            id: 'early', trackId: 'early-track', positionMs: 49_000,
            startedAt: '2026-07-17T10:00:00.000Z', endedAt: '2026-07-17T10:01:00.000Z'
          }),
          episode({
            id: 'half', trackId: 'half-track', positionMs: 50_000,
            startedAt: '2026-07-17T10:02:00.000Z', endedAt: '2026-07-17T10:03:00.000Z'
          }),
          episode({
            id: 'expired', trackId: 'expired-track', positionMs: 10_000,
            startedAt: '2026-07-16T09:00:00.000Z', endedAt: '2026-07-16T09:01:00.000Z'
          })
        ]
      })
    });

    expect(snapshot.temporaryExclusions).toEqual([{
      id: 'early-track',
      name: 'Song early-track',
      artists: ['Boundary Artist'],
      expiresAt: '2026-07-18T10:01:00.000Z'
    }]);
    expect(snapshot.metadata.sources.find((source) => source.kind === 'temporary_queue_exclusions'))
      .toEqual(expect.objectContaining({ authority: 'derived', recordCount: 1 }));
  });

  it('excludes future episodes from raw history, pressure, and temporary exclusions', async () => {
    const snapshot = await buildDjMemorySnapshot({
      userId: 'user-future-episode',
      now: new Date('2026-07-17T12:00:00.000Z'),
      deps: emptyDeps({
        loadEpisodes: async () => [
          episode({
            id: 'accepted-past', trackId: 'past-track',
            startedAt: '2026-07-17T10:00:00.000Z', endedAt: '2026-07-17T10:01:00.000Z'
          }),
          episode({
            id: 'future-start', trackId: 'future-track',
            startedAt: '2026-07-18T10:00:00.000Z', endedAt: '2026-07-18T10:01:00.000Z'
          }),
          episode({
            id: 'future-end', trackId: 'future-ended-track',
            startedAt: '2026-07-17T11:00:00.000Z', endedAt: '2026-07-18T11:01:00.000Z'
          })
        ]
      })
    });

    expect(snapshot.listeningEpisodes.map((item) => item.id)).toEqual(['accepted-past']);
    expect(snapshot.selectionPressure.tracks).toHaveLength(1);
    expect(snapshot.temporaryExclusions.map((item) => item.id)).toEqual(['past-track']);
    expect(snapshot.metadata.sources.find((source) => source.kind === 'listening_episodes'))
      .toEqual(expect.objectContaining({ recordCount: 1 }));
  });

  it('bounds upcoming queue records and preserves structured Personal DJ Context', async () => {
    const snapshot = await buildDjMemorySnapshot({
      userId: 'user-bounded-context',
      now: new Date('2026-07-17T04:00:00.000Z'),
      deps: emptyDeps({
        loadQueue: async () => ({
          queue: Array.from({ length: 61 }, (_, index) => ({
            ncmId: `track-${index}`,
            name: `Song ${index}`,
            artists: [`Artist ${index}`]
          })),
          currentIndex: 0
        }),
        loadPersonalContext: async () => ({
          id: 'pdc-structured',
          expiresAt: '2026-07-18T03:00:00.000Z',
          summary: '正在专注写代码',
          currentState: {
            activity: 'coding',
            energy: 'medium' as const,
            attention: 'low_distraction' as const,
            mood: 'focused'
          },
          musicGuidance: {
            preferredTextures: ['清亮'],
            avoidTextures: [],
            novelty: 'balanced' as const
          },
          musicHints: [{
            kind: 'style' as const,
            label: 'low-distraction city pop',
            strength: 'strong' as const,
            reason: '适合当前专注状态'
          }],
          segueGuidance: { privacyRule: '不透露具体私人信息' }
        })
      })
    });

    expect(snapshot.queue.currentTrack?.id).toBe('track-0');
    expect(snapshot.queue.upcoming).toHaveLength(50);
    expect(snapshot.queue.upcoming.at(-1)?.id).toBe('track-50');
    expect(snapshot.personalContext).toMatchObject({
      currentState: { activity: 'coding', attention: 'low_distraction' },
      musicHints: [{ label: 'low-distraction city pop', strength: 'strong' }]
    });
  });

  it('keeps the complete 60-day pressure projection when raw episode history exceeds 200', async () => {
    const recentEpisodes = Array.from({ length: 200 }, (_, index) => episode({
      id: `recent-${index}`,
      trackId: `recent-${index}`,
      trackName: `Recent ${index}`,
      primaryArtist: `Recent Artist ${index}`,
      listenedMs: 180_000,
      durationMs: 180_000,
      positionMs: 180_000,
      outcome: 'completed',
      startedAt: new Date(Date.parse('2026-07-17T12:00:00.000Z') - index * 1_000).toISOString()
    }));
    const olderPolicyEvidence = [
      episode({
        id: 'target-skip-1', trackId: 'target', trackName: 'Target Song',
        primaryArtist: 'Target Artist', positionMs: 10_000,
        startedAt: '2026-07-15T12:00:00.000Z'
      }),
      episode({
        id: 'target-skip-2', trackId: 'target', trackName: 'Target Song',
        primaryArtist: 'Target Artist', positionMs: 12_000,
        startedAt: '2026-07-14T12:00:00.000Z'
      }),
      ...['one', 'two', 'three'].map((suffix, index) => episode({
        id: `artist-skip-${suffix}`,
        trackId: `artist-track-${suffix}`,
        trackName: `Artist Song ${suffix}`,
        primaryArtist: 'Target Artist',
        positionMs: 8_000,
        startedAt: new Date(Date.parse('2026-07-13T12:00:00.000Z') - index * 86_400_000).toISOString()
      }))
    ];
    const snapshot = await buildDjMemorySnapshot({
      userId: 'user-complete-pressure',
      now: new Date('2026-07-17T12:00:00.000Z'),
      deps: emptyDeps({
        loadEpisodes: async () => [...recentEpisodes, ...olderPolicyEvidence]
      })
    });

    expect(snapshot.listeningEpisodes).toHaveLength(200);
    expect(snapshot.listeningEpisodes.map((item) => item.id)).not.toContain('target-skip-1');
    const pressure = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'auto-fill'
    }).pressureForCandidate({
      id: 'target', name: 'Target Song', artist: 'Target Artist',
      sources: ['search'], evidence: [],
      scores: {
        intentMatch: 0.5, tasteMatch: 0.5, timeFit: 0.5,
        contextFit: 0.5, novelty: 0.5, sourceConfidence: 0.5
      }
    });

    expect(pressure).toContainEqual(expect.objectContaining({
      reasonCode: 'early_skip_track',
      severity: 'suppress'
    }));
    expect(pressure).toContainEqual(expect.objectContaining({ reasonCode: 'exposure_track' }));

    const artistPressure = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'auto-fill'
    }).pressureForCandidate({
      id: 'fresh-target-artist', name: 'Fresh Song', artist: 'Target Artist',
      sources: ['search'], evidence: [],
      scores: {
        intentMatch: 0.5, tasteMatch: 0.5, timeFit: 0.5,
        contextFit: 0.5, novelty: 0.5, sourceConfidence: 0.5
      }
    });

    expect(artistPressure).toContainEqual(expect.objectContaining({
      reasonCode: 'early_skip_artist',
      severity: 'suppress'
    }));
  });

  it('fails explicitly instead of truncating accepted pressure evidence above the hard bound', async () => {
    expect(DJ_MEMORY_SELECTION_PRESSURE_LIMIT).toBe(30_500);
    const episodes = Array.from({ length: DJ_MEMORY_SELECTION_PRESSURE_LIMIT + 1 }, (_, index) =>
      episode({
        id: `bounded-${index}`,
        trackId: `bounded-${index}`,
        trackName: `Bounded ${index}`,
        primaryArtist: `Artist ${index}`,
        listenedMs: 180_000,
        durationMs: 180_000,
        positionMs: 180_000,
        outcome: 'completed',
        startedAt: '2026-07-17T10:00:00.000Z',
        endedAt: '2026-07-17T10:03:00.000Z'
      })
    );

    await expect(buildDjMemorySnapshot({
      userId: 'user-over-pressure-bound',
      now: new Date('2026-07-17T12:00:00.000Z'),
      deps: emptyDeps({ loadEpisodes: async () => episodes })
    })).rejects.toThrow(/pressure episode limit exceeded/i);
  });
});

function episode(overrides: Record<string, unknown>) {
  return {
    id: 'episode',
    trackId: 'track',
    trackName: `Song ${String(overrides.trackId ?? 'track')}`,
    primaryArtist: 'Boundary Artist',
    positionMs: 0,
    listenedMs: 10_000,
    durationMs: 100_000,
    outcome: 'skipped' as const,
    startedAt: '2026-07-17T10:00:00.000Z',
    endedAt: '2026-07-17T10:01:00.000Z',
    ...overrides
  };
}

function emptyDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadQueue: async () => ({ queue: [], currentIndex: 0 }),
    loadEpisodes: async () => [],
    loadPreferenceEvidence: async () => [],
    loadTasteProfile: async () => null,
    loadActiveDirective: async () => null,
    loadExclusions: async () => ({ explicit: [], temporary: [] }),
    loadPersonalContext: async () => null,
    loadRetrievalHistory: async () => [],
    loadConfiguration: async () => [],
    loadSelectionContext: async () => ({ discoveryMode: 'explore', dailyTheme: null }),
    loadSessionEvents: async () => [],
    loadWeather: async () => null,
    ...overrides
  } as never;
}
