import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNextTrack,
  getNowPlaying,
  getPlayerContext,
  getSettings,
  getSuspendedUsers,
  patchListeningEpisode,
  patchListeningEpisodeKeepalive,
  putListeningEpisode,
  reactivateUser,
  saveQueueState,
  suspendUser,
  updateLocation
} from '../../src/renderer/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderer listening API', () => {
  it('uses the episode-bound auth token instead of the latest stored account token', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'new-account-token')
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await putListeningEpisode('episode-old', {
      playerInstanceId: 'old-tab',
      deckId: 'main',
      track: { id: 'track-a', name: 'Track A', artists: [] },
      durationMs: 100_000,
      checkpointSeq: 0
    }, { keepalive: true, authToken: 'old-account-token' });
    await patchListeningEpisode('episode-old', {
      checkpointSeq: 1,
      listenedMs: 5_000,
      positionMs: 5_000,
      durationMs: 100_000,
      outcome: 'interrupted'
    }, { keepalive: true, authToken: 'old-account-token' });
    await patchListeningEpisodeKeepalive('episode-pagehide', {
      create: {
        playerInstanceId: 'old-tab',
        deckId: 'main',
        track: { id: 'track-a', name: 'Track A', artists: [] },
        durationMs: 100_000,
        checkpointSeq: 0
      },
      checkpoint: {
        checkpointSeq: 1,
        listenedMs: 5_000,
        positionMs: 5_000,
        durationMs: 100_000
      }
    }, { authToken: 'old-account-token' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        keepalive: true,
        headers: expect.objectContaining({ Authorization: 'Bearer old-account-token' })
      });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      create: { playerInstanceId: 'old-tab' },
      checkpoint: { checkpointSeq: 1, positionMs: 5_000 }
    });
  });
});

describe('renderer queue API', () => {
  it('uses the queue-save scheduling token instead of the latest stored account token', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'new-account-token')
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      queue: [
        { id: 'track-a', name: 'Track A', artists: [], durationMs: 180_000, coverImgUrl: null },
        { id: 'remote-track', name: 'Remote Track', artists: [], durationMs: 180_000, coverImgUrl: null }
      ],
      currentIndex: 0,
      revision: 5
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveQueueState([
      { id: 'track-a', name: 'Track A', artists: [] }
    ], 0, [], 3, 'a88a59c9-fecf-4f39-98f4-5a2fd89938d8', { authToken: 'old-account-token' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer old-account-token' })
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      mutationId: 'a88a59c9-fecf-4f39-98f4-5a2fd89938d8'
    });
    expect(result).toMatchObject({
      ok: true,
      queue: [{ id: 'track-a' }, { id: 'remote-track' }],
      currentIndex: 0,
      revision: 5
    });
  });
});

describe('renderer player account-bound API', () => {
  it('bypasses browser caches when refreshing a failed track stream', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'new-account-token') });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      ncmId: 'track-a',
      url: 'https://example.test/fresh-a.mp3',
      durationMs: 100_000,
      lyric: null,
      translation: null,
      timing: { prefetchLeadSec: 10, crossfadeSec: 3, segueLeadSec: 8 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await getNowPlaying('track-a', {
      authToken: 'captured-account-token',
      freshStream: true
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/now?ncmId=track-a&fresh=1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      headers: expect.objectContaining({ Authorization: 'Bearer captured-account-token' })
    });
  });

  it('uses the captured token for now, next and geolocation context requests', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'new-account-token') });
    const responses = [
      {
        ok: true,
        ncmId: 'track-a',
        url: 'https://example.test/a.mp3',
        durationMs: 100_000,
        lyric: null,
        translation: null,
        timing: { prefetchLeadSec: 10, crossfadeSec: 3, segueLeadSec: 8 }
      },
      {
        ok: true,
        track: { id: 'track-b' },
        url: 'https://example.test/b.mp3',
        durationMs: 100_000,
        timing: { prefetchLeadSec: 10, crossfadeSec: 3, segueLeadSec: 8 }
      },
      { ok: true },
      { ok: true, theme: null, weather: null, taste: '', discoveryMode: 'comfort' }
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const requestOptions = { authToken: 'captured-account-token' };
    await getNowPlaying('track-a', requestOptions);
    await getNextTrack(['track-a', 'track-b'], 'track-a', requestOptions);
    await updateLocation(1, 2, requestOptions);
    await getPlayerContext(requestOptions);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer captured-account-token' })
      });
    }
  });
});

describe('renderer resource governance API', () => {
  it('passes through resource tier and capability fields in the settings response', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'new-account-token') });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      resourceTier: 'priority',
      resourceCapabilities: { thinking: true, configurableAutoFillBatchSize: true },
      llm: { thinkingEnabled: true },
      tts: { voice: 'Cherry' },
      dailyThemeEnabled: true,
      discoveryMode: 'explore',
      autoFillBatchSize: 5
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const settings = await getSettings();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://localhost:5173/api/settings');
    expect(settings.resourceTier).toBe('priority');
    expect(settings.resourceCapabilities).toEqual({
      thinking: true,
      configurableAutoFillBatchSize: true
    });
  });

  it('loads, suspends, and reactivates users through the access-control wire paths', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'new-account-token') });
    const responses = [
      { ok: true, suspended: [{ userId: '1001', updatedAt: '2026-08-10T00:00:00.000Z' }] },
      { ok: true },
      { ok: true }
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      responses.shift();
      return new Response(JSON.stringify({
        ok: true,
        suspended: [{ userId: '1001', updatedAt: '2026-08-10T00:00:00.000Z' }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const suspended = await getSuspendedUsers();
    expect(suspended.suspended).toEqual([{ userId: '1001', updatedAt: '2026-08-10T00:00:00.000Z' }]);

    await suspendUser('1001');
    await reactivateUser('1001');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://localhost:5173/api/access/suspended');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ ncmId: '1001' });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('http://localhost:5173/api/access/suspended/1001');
  });
});
