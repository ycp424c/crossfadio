import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('player layout', () => {
  it('allows the active view to scroll instead of clipping tall player content', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');

    expect(source).toContain('flex-1 overflow-y-auto');
    expect(source).not.toContain('flex-1 overflow-hidden');
  });

  it('limits queue list height and scrolls the playlist internally', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/components/player/QueuePanel.tsx'), 'utf-8');

    expect(source).toContain('max-h-');
    expect(source).toContain('overflow-y-auto');
  });

  it('persists the locally selected DJ start track instead of treating it as remote queue state', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const loadLikedQueueStart = source.indexOf('async function loadLikedQueue');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying');
    const loadLikedQueueBody = source.slice(loadLikedQueueStart, loadNowPlayingStart);

    expect(loadLikedQueueBody).toContain('setQueue([startTrack])');
    expect(loadLikedQueueBody).not.toContain('applyingRemoteQueueRef.current = true');
  });

  it('restores the previous player queue from localStorage before falling back to liked queue', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const initStart = source.indexOf('void refreshSession();');
    const initEnd = source.indexOf("if ('geolocation' in navigator)", initStart);
    const initBody = source.slice(initStart, initEnd);

    expect(source).toContain('PLAYER_QUEUE_STORAGE_KEY');
    expect(source).toContain('restorePersistedQueueSnapshot()');
    expect(source).toContain('persistQueueSnapshot(queue, currentIndex)');
    expect(initBody).toContain('const restoredQueue = restorePersistedQueueSnapshot();');
    expect(initBody).toContain('if (restoredQueue)');
    expect(initBody).toContain('setQueue(restoredQueue.queue);');
    expect(initBody).toContain('setCurrentIndex(restoredQueue.currentIndex);');
    expect(initBody.indexOf('if (restoredQueue)')).toBeLessThan(initBody.indexOf('void loadLikedQueue();'));
  });

  it('surfaces waiting segue states instead of falling back to idle text', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain("setSegueStatusText('已开播，等待下一首加入队列')");
    expect(source).toContain("setSegueStatusText('下一首与当前相同，跳过')");
  });

  it('clears stale track media immediately when the current track changes', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('function resetTrackMedia(): void');
    expect(source).toContain('setNowPlaying(null)');
    expect(source).toContain("audio.removeAttribute('src')");
    expect(source).toContain('resetTrackMedia();');
  });

  it('ignores stale now-playing responses from a previous current track', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying');
    const refreshNextTrackStart = source.indexOf('async function refreshNextTrack');
    const loadNowPlayingBody = source.slice(loadNowPlayingStart, refreshNextTrackStart);

    expect(loadNowPlayingBody).toContain('if (currentTrackIdRef.current !== trackId)');
    expect(loadNowPlayingBody).toContain('setNowPlaying(payload)');
    expect(loadNowPlayingBody.indexOf('if (currentTrackIdRef.current !== trackId)')).toBeLessThan(
      loadNowPlayingBody.indexOf('setNowPlaying(payload)')
    );
  });

  it('shows segue request failures directly in the player status area', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).not.toContain("setSegueStatus('degraded')");
    expect(source).toContain('setSegueStatusText(`请求失败：${message}`)');
  });

  it('releases the active segue request after tts-ready so DJ refill can resume', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const ttsReadyStart = source.indexOf("type === 'segue.tts-ready'");
    const degradedStart = source.indexOf("type === 'segue.degraded'");
    const ttsReadyBlock = source.slice(ttsReadyStart, degradedStart);

    expect(ttsReadyBlock).toContain('segueClientRequestIdRef.current = null');
    expect(ttsReadyBlock).toContain('segueSatisfiedForTrackIdRef.current = currentTrackIdRef.current');
  });

  it('keeps reading chat SSE after chat.done so recommendation progress can arrive', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/components/player/ChatPanel.tsx'), 'utf-8');
    const doneStart = source.indexOf("type === 'chat.done'");
    const errorStart = source.indexOf("type === 'chat.error'");
    const doneBlock = source.slice(doneStart, errorStart);

    expect(doneBlock).toContain('setSending(false)');
    expect(doneBlock).not.toContain('break;');
  });

  it('handles DJ pick-next completion from the one-shot SSE stream', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/http/routes/djNext.ts'), 'utf-8');
    const sseHandlerStart = source.indexOf('export function createSseDjPickNextHandler');
    const scopedClientStart = source.indexOf('function getScopedNcmClient');
    const sseHandlerBody = source.slice(sseHandlerStart, scopedClientStart);

    expect(sseHandlerBody).toContain('writeSseEvent(res, type, payload)');
    expect(sseHandlerBody).toContain('doPickNext(userId, ncmClient, emit)');
  });

  it('does not start another DJ pick-next SSE stream while one is already in flight', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const triggerStart = source.indexOf('// DJ mode: keep queue at DJ_TARGET_QUEUE songs');
    const startSegueAudioStart = source.indexOf('maybeStartSegueAudio();', triggerStart);
    const triggerBlock = source.slice(triggerStart, startSegueAudioStart);

    expect(source).toContain('const djPickNextInFlightRef = useRef(false)');
    expect(triggerBlock).toContain('!djPickNextInFlightRef.current');
    expect(triggerBlock).toContain('djPickNextInFlightRef.current = true');
    expect(triggerBlock).toContain('djPickNextInFlightRef.current = false');
  });

  it('logs DJ pick-next exclusion lists from debug events to the browser console', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const debugStart = source.indexOf("type === 'dj.debug'");
    const doneStart = source.indexOf("type === 'dj.pick-next.done'", debugStart);
    const debugBlock = source.slice(debugStart, doneStart);

    expect(debugBlock).toContain('console.info');
    expect(debugBlock).toContain('DJ pick-next exclusion list');
    expect(debugBlock).toContain('data.excludedIds');
    expect(debugBlock).toContain('data.excludedDedupeKeys');
  });

  it('includes clientRequestId in direct SSE segue payloads before the player filters them', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/http/routes/segue.ts'), 'utf-8');
    const sseHandlerStart = source.indexOf('export function createSseSegueHandler');
    const audioHandlerStart = source.indexOf('export function createSegueAudioHandler');
    const sseHandlerBody = source.slice(sseHandlerStart, audioHandlerStart);

    expect(sseHandlerBody).toContain('clientRequestId');
    expect(sseHandlerBody).toContain('requestId');
    expect(sseHandlerBody).toContain('{ ...payload, requestId, clientRequestId }');
  });

  it('triggers segue as soon as playback is running and a next track is known', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('const maybeTriggerSegue = useCallback(() => {');
    expect(source).toContain('if (!audio || audio.paused || !currentTrackId || !nextTrackId) {');
    expect(source).toContain('useEffect(() => {');
    expect(source).toContain('maybeTriggerSegue();');
    expect(source).not.toContain('decision.shouldTriggerSegue &&');
  });

  it('reloads player context after auth token changes so daily theme appears after login', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const contextLoadStart = source.indexOf('getPlayerContext()');
    const contextEffectStart = source.lastIndexOf('useEffect(() => {', contextLoadStart);
    const contextEffectEnd = source.indexOf('  }, [sseToken]);', contextLoadStart);
    const contextLoadEffect = source.slice(contextEffectStart, contextEffectEnd) + '  }, [sseToken]);';

    expect(contextLoadStart).toBeGreaterThan(-1);
    expect(contextEffectStart).toBeGreaterThan(-1);
    expect(contextEffectEnd).toBeGreaterThan(contextLoadStart);
    expect(contextLoadEffect).toContain('if (!sseToken)');
    expect(contextLoadEffect).toContain('setDailyTheme(ctx.theme)');
    expect(contextLoadEffect).toContain('  }, [sseToken]);');
    expect(source).not.toContain('void refreshSession();\n    void getPlayerContext()');
  });

  it('reports browser location only after auth token is available and then refreshes player context', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const locationCall = source.indexOf('navigator.geolocation.getCurrentPosition');
    const locationEffectStart = source.lastIndexOf('useEffect(() => {', locationCall);
    const locationEffectEnd = source.indexOf('  }, [sseToken]);', locationCall);
    const locationEffect = source.slice(locationEffectStart, locationEffectEnd) + '  }, [sseToken]);';

    expect(locationCall).toBeGreaterThan(-1);
    expect(locationEffectStart).toBeGreaterThan(-1);
    expect(locationEffect).toContain('if (!sseToken');
    expect(locationEffect).toContain('updateLocation(pos.coords.latitude, pos.coords.longitude)');
    expect(locationEffect).toContain('.then(() => {');
    expect(locationEffect).toContain('void refreshPlayerContext().catch(() => {});');
    expect(locationEffect).toContain('  }, [sseToken]);');
    expect(source.slice(locationCall, locationEffectEnd)).not.toContain('  }, []);');
  });

  it('logs browser location and weather refresh diagnostics to the console', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('[Crossfadio] weather geolocation unavailable');
    expect(source).toContain('[Crossfadio] weather geolocation resolved');
    expect(source).toContain('[Crossfadio] weather location updated');
    expect(source).toContain('[Crossfadio] weather location update failed');
    expect(source).toContain('[Crossfadio] player context weather');
  });

  it('places the daily theme recommendation toggle in the player theme banner', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const bannerStart = source.indexOf('{/* Daily Theme Banner */}');
    const bannerEnd = source.indexOf('{/* User Taste', bannerStart);
    const bannerSource = source.slice(bannerStart, bannerEnd);

    expect(source).toContain('saveSettings');
    expect(source).toContain('dailyThemeEnabled');
    expect(source).toContain('handleDailyThemeToggle');
    expect(source).toContain('saveSettings({ dailyThemeEnabled: next })');
    expect(bannerSource).toContain('role="switch"');
    expect(bannerSource).toContain('aria-checked={dailyThemeEnabled}');
  });

  it('shows weather location and current weather in the player header', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const headerStart = source.indexOf('{/* Header */}');
    const headerEnd = source.indexOf('</header>', headerStart);
    const headerSource = source.slice(headerStart, headerEnd);

    expect(source).toContain('weatherContext');
    expect(headerSource).toContain('MapPin');
    expect(headerSource).toContain('CloudSun');
    expect(headerSource).toContain('weatherContext.location');
    expect(headerSource).toContain('weatherContext.tempC');
    expect(headerSource).toContain('weatherContext.desc');
  });

  it('shows a tooltip warning when browser location is blocked by insecure origin', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const headerStart = source.indexOf('{/* Header */}');
    const headerEnd = source.indexOf('</header>', headerStart);
    const headerSource = source.slice(headerStart, headerEnd);

    expect(source).toContain('AlertTriangle');
    expect(source).toContain('geolocationIssue');
    expect(source).toContain('Only secure origins are allowed');
    expect(source).toContain('chrome://flags/#unsafely-treat-insecure-origin-as-secure');
    expect(headerSource).toContain('title={geolocationIssue}');
    expect(headerSource).toContain('<AlertTriangle');
  });

  it('PlaybackTimeline does not render DeckCard or dual-deck section', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/PlaybackTimeline.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('DeckCard');
    expect(source).not.toContain('双 Deck 混音台');
    expect(source).toContain('A→B');
  });

  it('NowPlayingHero does not show DJ Deck A badge or NCM ID', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/NowPlayingHero.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('DJ Deck A');
    expect(source).not.toContain('NCM ID');
    expect(source).not.toContain('trackId');
  });

  it('PlayerView uses two-column layout and removes the left sidebar', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('col-span-2');
    expect(source).not.toContain('col-span-7');
    expect(source).not.toContain('col-span-3');
    expect(source).toContain('col-span-12');
    expect(source).toContain('col-span-6');
  });

  it('PlayerView removes the prefetch status panel', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('预取状态');
    expect(source).not.toContain('prefetchLeadSec');
  });

  it('PlayerView has NCM chip dropdown controlled by showNcmDropdown state', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).toContain('showNcmDropdown');
    expect(source).toContain('setShowNcmDropdown');
  });
});
