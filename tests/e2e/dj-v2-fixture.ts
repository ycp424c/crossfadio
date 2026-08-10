import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import type { QueueTrackDto } from '../../src/shared/schema';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';

const PLAYER_QUEUE_STORAGE_KEY = 'crossfadio.player.queue.v2';
const PLAYWRIGHT_USER_ID = 'playwright-dj-v2-user';
const JWT_STORAGE_KEY = 'crossfadio_jwt';

export type CapturedEpisodeRequest = {
  method: string;
  clientEpisodeId: string;
  body: Record<string, unknown>;
};

export type DjV2BrowserController = {
  episodeRequests: CapturedEpisodeRequest[];
  pickNextRequests: Record<string, unknown>[];
  history: SelectionJourneySnapshot[];
};

export async function setupDjV2Page(input: {
  page: Page;
  queue: QueueTrackDto[];
  pickNextEvents?: Array<{ type: string; data: Record<string, unknown> }>;
  realMedia?: boolean;
}): Promise<DjV2BrowserController> {
  const { page, queue } = input;
  const controller: DjV2BrowserController = {
    episodeRequests: [],
    pickNextRequests: [],
    history: []
  };

  await page.addInitScript(({ initialQueue, queueStorageKey, jwtStorageKey, userId, useRealMedia }) => {
    const jwtPayload = btoa(JSON.stringify({ sub: userId }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    localStorage.setItem(jwtStorageKey, `e30.${jwtPayload}.playwright-signature`);
    localStorage.setItem(`${queueStorageKey}.${encodeURIComponent(userId)}`, JSON.stringify({
      queue: initialQueue,
      currentIndex: 0,
      savedAt: Date.now()
    }));
    localStorage.removeItem('crossfadio_selection_journey_expanded');

    type TestEventSource = {
      readyState: number;
      listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
    };
    const eventSources = new Set<TestEventSource>();
    class BrowserTestEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = BrowserTestEventSource.OPEN;
      listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

      constructor(url: string | URL) {
        this.url = String(url);
        eventSources.add(this);
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        this.listeners.get(type)?.delete(listener);
      }

      close(): void {
        this.readyState = BrowserTestEventSource.CLOSED;
        eventSources.delete(this);
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: BrowserTestEventSource
    });
    Object.assign(BrowserTestEventSource, {
      CONNECTING: BrowserTestEventSource.CONNECTING,
      OPEN: BrowserTestEventSource.OPEN,
      CLOSED: BrowserTestEventSource.CLOSED
    });

    const browserWindow = window as typeof window & {
      __emitCrossfadioSse(type: string, data: unknown): void;
    };
    browserWindow.__emitCrossfadioSse = (type, data) => {
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      for (const source of eventSources) {
        for (const listener of source.listeners.get(type) ?? []) {
          if (typeof listener === 'function') listener.call(source, event);
          else listener.handleEvent(event);
        }
      }
    };

    if (!useRealMedia) {
      type MediaState = {
      currentTime: number;
      duration: number;
      paused: boolean;
      src: string;
      };
      const mediaStates = new WeakMap<HTMLMediaElement, MediaState>();
      const mediaState = (media: HTMLMediaElement): MediaState => {
        const current = mediaStates.get(media);
        if (current) return current;
        const created = { currentTime: 0, duration: 100, paused: true, src: '' };
        mediaStates.set(media, created);
        return created;
      };
      const mediaPrototype = HTMLMediaElement.prototype;
      Object.defineProperties(mediaPrototype, {
        paused: { configurable: true, get() { return mediaState(this).paused; } },
        currentTime: {
          configurable: true,
          get() { return mediaState(this).currentTime; },
          set(value: number) { mediaState(this).currentTime = Number(value); }
        },
        duration: { configurable: true, get() { return mediaState(this).duration; } },
        src: {
          configurable: true,
          get() { return mediaState(this).src; },
          set(value: string) { mediaState(this).src = String(value); }
        }
      });
      Object.defineProperties(mediaPrototype, {
        play: {
          configurable: true,
          value(this: HTMLMediaElement) {
            mediaState(this).paused = false;
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
          }
        },
        pause: {
          configurable: true,
          value(this: HTMLMediaElement) {
            const state = mediaState(this);
            const wasPlaying = !state.paused;
            state.paused = true;
            if (wasPlaying) queueMicrotask(() => this.dispatchEvent(new Event('pause')));
          }
        },
        load: {
          configurable: true,
          value(this: HTMLMediaElement) {
            if (mediaState(this).src) {
              queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
            }
          }
        }
      });
    }
  }, {
    initialQueue: queue,
    queueStorageKey: PLAYER_QUEUE_STORAGE_KEY,
    jwtStorageKey: JWT_STORAGE_KEY,
    userId: PLAYWRIGHT_USER_ID,
    useRealMedia: input.realMedia === true
  });

  if (input.realMedia) {
    const fixture = Buffer.from(
      fs.readFileSync(path.resolve('tests/fixtures/audio/short-tone.wav.base64'), 'utf8')
        .replace(/\s/g, ''),
      'base64'
    );
    await page.route('https://audio.test/**', async (route) => {
      const range = route.request().headers().range;
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number.parseInt(match[1]!, 10) : 0;
      const requestedEnd = match?.[2] ? Number.parseInt(match[2], 10) : fixture.length - 1;
      const end = Math.min(requestedEnd, fixture.length - 1);
      const partial = Boolean(match) && start <= end;
      const body = partial ? fixture.subarray(start, end + 1) : fixture;
      await route.fulfill({
        status: partial ? 206 : 200,
        contentType: 'audio/wav',
        headers: {
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
          'content-length': String(body.length),
          ...(partial ? { 'content-range': `bytes ${start}-${end}/${fixture.length}` } : {})
        },
        body
      });
    });
  }

  await page.route('**/api/**', async (route) => {
    await handleApiRoute(route, queue, input.pickNextEvents ?? [], controller);
  });
  await page.goto('/');
  return controller;
}

export async function setAudioPosition(
  page: Page,
  seconds: number,
  options: { dispatchTimeUpdate?: boolean } = {}
): Promise<void> {
  await page.locator('audio').evaluate((audio, input) => {
    audio.currentTime = input.seconds;
    if (input.dispatchTimeUpdate) audio.dispatchEvent(new Event('timeupdate'));
  }, { seconds, dispatchTimeUpdate: options.dispatchTimeUpdate === true });
}

export async function emitPersistentSse(
  page: Page,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  await page.evaluate(({ eventType, payload }) => {
    const browserWindow = window as typeof window & {
      __emitCrossfadioSse(type: string, data: unknown): void;
    };
    browserWindow.__emitCrossfadioSse(eventType, payload);
  }, { eventType: type, payload: data });
}

async function handleApiRoute(
  route: Route,
  queue: QueueTrackDto[],
  pickNextEvents: Array<{ type: string; data: Record<string, unknown> }>,
  controller: DjV2BrowserController
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const { pathname } = url;

  if (pathname === '/api/runtime') return json(route, { ok: true });
  if (pathname === '/api/ncm/login/session') {
    return json(route, { ok: true, hasCookie: true, profile: { nickname: 'E2E Listener' } });
  }
  if (pathname === '/api/queue/liked/ids') return json(route, { ok: true, ids: [] });
  if (pathname === '/api/settings/player-context') {
    return json(route, { ok: true, theme: null, weather: null, taste: '', discoveryMode: 'explore' });
  }
  if (pathname === '/api/settings/personal-dj-context') {
    return json(route, {
      ok: true,
      current: null,
      latest: null,
      currentActive: false,
      trendCount: 0,
      retainedRecordCount: 0
    });
  }
  if (pathname === '/api/settings/personal-dj-context/tokens') {
    return json(route, { ok: true, tokens: [] });
  }
  if (pathname === '/api/settings') {
    return json(route, {
      ok: true,
      resourceTier: 'standard',
      resourceCapabilities: { thinking: false, configurableAutoFillBatchSize: false },
      llm: { baseUrl: '', model: 'fixture', hasApiKey: true, thinkingEnabled: false, thinkingSupported: false },
      tts: { baseUrl: '', model: 'fixture', hasApiKey: true, voice: 'fixture', voiceDefault: null },
      dailyThemeEnabled: false,
      discoveryMode: 'explore',
      autoFillBatchSize: 2
    });
  }
  if (pathname === '/api/whitelist') return json(route, { ok: true, entries: [] });
  if (pathname === '/api/whitelist/blocked') return json(route, { ok: true, blocked: [] });
  if (pathname === '/api/dj/selection-journeys') {
    return json(route, { ok: true, journeys: controller.history });
  }
  if (pathname.startsWith('/api/listening-episodes/')) {
    controller.episodeRequests.push({
      method: request.method(),
      clientEpisodeId: decodeURIComponent(pathname.split('/').at(-1) ?? ''),
      body: request.postDataJSON() as Record<string, unknown>
    });
    return json(route, { ok: true });
  }
  if (pathname === '/api/now') {
    const id = url.searchParams.get('ncmId') ?? queue[0]?.id ?? 'fixture-track';
    return json(route, {
      ok: true,
      ncmId: id,
      url: `https://audio.test/${encodeURIComponent(id)}.mp3`,
      coverImgUrl: null,
      durationMs: 100_000,
      lyric: null,
      translation: null,
      timing: { prefetchLeadSec: 5, crossfadeSec: 3, segueLeadSec: 5 }
    });
  }
  if (pathname === '/api/next') {
    const currentId = url.searchParams.get('current');
    const index = queue.findIndex((track) => track.id === currentId);
    const track = queue[index + 1] ?? queue[0];
    return json(route, {
      ok: true,
      track,
      url: `https://audio.test/${encodeURIComponent(track.id)}.mp3`,
      durationMs: track.durationMs,
      timing: { prefetchLeadSec: 5, crossfadeSec: 3, segueLeadSec: 5 }
    });
  }
  if (pathname === '/api/queue/state') return json(route, { ok: true, revision: 1 });
  if (pathname === '/api/sse/pick-next') {
    controller.pickNextRequests.push(request.postDataJSON() as Record<string, unknown>);
    const body = pickNextEvents.map(({ type, data }) => (
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    )).join('');
    return route.fulfill({
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8'
      },
      body
    });
  }
  if (pathname === '/api/sse/segue') {
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: 'event: segue.degraded\ndata: {"reason":"fixture_disabled"}\n\n'
    });
  }

  return json(route, { ok: true });
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', json: body });
}
