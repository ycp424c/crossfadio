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

  it('does not auto-scroll the page when the active lyric changes', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/components/player/SyncedLyrics.tsx'), 'utf-8');

    expect(source).not.toContain('scrollIntoView');
  });

  it('persists the locally selected DJ start track instead of treating it as remote queue state', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const loadLikedQueueStart = source.indexOf('async function loadLikedQueue');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying');
    const loadLikedQueueBody = source.slice(loadLikedQueueStart, loadNowPlayingStart);

    expect(loadLikedQueueBody).toContain('applyQueueSnapshot({ queue: [startTrack], currentIndex: 0 })');
    expect(loadLikedQueueBody).not.toContain('applyingRemoteQueueRef.current = true');
  });

  it('restores the previous player queue from localStorage before falling back to liked queue', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const cacheSource = fs.readFileSync(path.join(root, 'src/renderer/playerQueueCache.ts'), 'utf-8');
    const initStart = source.indexOf('void refreshSession();');
    const initEnd = source.indexOf("if ('geolocation' in navigator)", initStart);
    const initBody = source.slice(initStart, initEnd);

    expect(source).toContain('@renderer/playerQueueCache');
    expect(cacheSource).toContain('PLAYER_QUEUE_STORAGE_KEY');
    expect(source).toContain('restorePersistedQueueSnapshot()');
    expect(source).toContain('persistQueueSnapshot(queue, currentIndex)');
    expect(initBody).toContain('const restoredQueue = restorePersistedQueueSnapshot();');
    expect(initBody).toContain('if (restoredQueue)');
    expect(initBody).toContain('applyQueueSnapshot(restoredQueue);');
    expect(initBody.indexOf('if (restoredQueue)')).toBeLessThan(initBody.indexOf('void loadLikedQueue();'));
  });

  it('refreshes liked track ids when restoring a persisted queue so the hero heart matches NCM', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const initStart = source.indexOf('void refreshSession();');
    const initEnd = source.indexOf("if ('geolocation' in navigator)", initStart);
    const initBody = source.slice(initStart, initEnd);
    const restoredStart = initBody.indexOf('if (restoredQueue)');
    const restoredEnd = initBody.indexOf('} else {', restoredStart);
    const restoredBlock = initBody.slice(restoredStart, restoredEnd);

    expect(source).toContain('async function refreshLikedTrackIds');
    expect(restoredBlock).toContain('void refreshLikedTrackIds();');
  });

  it('surfaces waiting segue states instead of falling back to idle text', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('getSegueWaitingStatus({');
    expect(source).toContain('setSegueStatusText(waitingStatus)');
  });

  it('clears stale track media immediately when the current track changes', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('function resetTrackMedia(): void');
    expect(source).toContain('setNowPlaying(null)');
    expect(source).toContain("audio.removeAttribute('src')");
    expect(source).toContain('resetTrackMedia();');
  });

  it('retries interrupted track streams by refreshing the now-playing URL with stale guards', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const retryStart = source.indexOf('async function retryTrackPlaybackAfterError');
    const resetStart = source.indexOf('function resetTrackMedia', retryStart);
    const retryBody = source.slice(retryStart, resetStart);

    expect(source).toContain('const TRACK_MEDIA_ERROR_MAX_RETRIES = 2');
    expect(source).toContain('async function retryTrackPlaybackAfterError');
    expect(source).toContain('getTrackMediaErrorAction({');
    expect(source).toContain('getTrackMediaRetryResumeDecision({');
    expect(source).toContain('pendingTrackMediaRetryRef.current = {');
    expect(source).toContain('trackMediaRetryRequestIdRef.current += 1');
    expect(source).toContain('currentTrackIdRef.current !== trackId');
    expect(retryBody).toContain('const payload = await getNowPlaying(trackId);');
    expect(retryBody).not.toContain('getNowPlaying(trackId, {');
  });

  it('clears the restored queue snapshot when the final queued track ends', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const onEndedStart = source.indexOf('function onEnded(): void');
    const onErrorStart = source.indexOf('function onTrackMediaError(): void');
    const onEndedBody = source.slice(onEndedStart, onErrorStart);

    expect(onEndedBody).toContain('advanceQueueAfterEnded({ queue, currentIndex })');
    expect(onEndedBody).toContain('applyQueueSnapshot(transition)');
    expect(onEndedBody).toContain("setTrackStatusText('播放完成')");
    expect(source).toContain('persistQueueSnapshot(queue, currentIndex)');
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
    expect(sseHandlerBody).toContain('djPickNextRunner.run({ userId, ncmClient, emit, signal: controller.signal })');
    expect(sseHandlerBody).toContain("result.status === 'timeout'");
    expect(sseHandlerBody).toContain("endSse(res, 'dj.pick-next.done', { added: false, reason: 'timeout' })");
  });

  it('does not start another DJ pick-next SSE stream while one is already in flight', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const triggerStart = source.indexOf('// DJ mode: refill when the backup queue reaches the low-water mark');
    const startSegueAudioStart = source.indexOf('maybeStartSegueAudio();', triggerStart);
    const triggerBlock = source.slice(triggerStart, startSegueAudioStart);

    expect(source).toContain('const djPickNextInFlightRef = useRef(false)');
    expect(source).toContain('AUTO_FILL_LOW_WATER_MARK');
    expect(triggerBlock).toContain('shouldTriggerDjRefill({');
    expect(triggerBlock).toContain('pickNextInFlight: djPickNextInFlightRef.current');
    expect(triggerBlock).toContain('lowWaterMark: AUTO_FILL_LOW_WATER_MARK');
    expect(triggerBlock).toContain('djPickNextInFlightRef.current = true');
    expect(triggerBlock).toContain('djPickNextInFlightRef.current = false');
  });

  it('uses latest queue refs and direct SSE queue-appended events to avoid stale refill retries', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const triggerStart = source.indexOf('// DJ mode: refill when the backup queue reaches the low-water mark');
    const startSegueAudioStart = source.indexOf('maybeStartSegueAudio();', triggerStart);
    const triggerBlock = source.slice(triggerStart, startSegueAudioStart);

    expect(source).toContain('const queueRef = useRef<QueueTrackDto[]>([])');
    expect(source).toContain('const currentIndexRef = useRef(0)');
    expect(source).toContain('consumePlayerPickNextStream({');
    expect(source).toContain('onQueueAppended: appendRemoteQueueTrack');
    expect(triggerBlock).toContain('const latestQueue = queueRef.current');
    expect(triggerBlock).toContain('shouldTriggerDjRefill({');
    expect(triggerBlock).toContain('queueLength: latestQueue.length');
    expect(triggerBlock).toContain('currentIndex: latestCurrentIndex');
    expect(triggerBlock).toContain('queue: latestQueue');
    expect(triggerBlock).toContain('currentIndex: latestCurrentIndex');
  });

  it('backs off instead of retrying immediately when DJ pick-next is already running on the server', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const triggerStart = source.indexOf('// DJ mode: refill when the backup queue reaches the low-water mark');
    const startSegueAudioStart = source.indexOf('maybeStartSegueAudio();', triggerStart);
    const triggerBlock = source.slice(triggerStart, startSegueAudioStart);
    const doneStart = triggerBlock.indexOf('onDone(playerEvent)');
    const doneBlock = triggerBlock.slice(doneStart);

    expect(source).toContain('const DJ_ALREADY_RUNNING_BACKOFF_MS = 30000');
    expect(source).toContain('const djPickNextBackoffUntilRef = useRef<number>(0)');
    expect(triggerBlock).toContain('backoffUntil: djPickNextBackoffUntilRef.current');
    expect(doneBlock).toContain("reason === 'already-running'");
    expect(doneBlock).toContain('djPickNextBackoffUntilRef.current = Date.now() + DJ_ALREADY_RUNNING_BACKOFF_MS');
    expect(doneBlock).toContain("setDjStatusText(latestBackupTrackCount > AUTO_FILL_LOW_WATER_MARK ? '已补充队列' : '正在补充队列…')");
    expect(doneBlock.indexOf("reason === 'already-running'")).toBeLessThan(
      doneBlock.indexOf('djPickNextLastCallRef.current = 0')
    );
  });

  it('sends manually skipped or removed queue tracks as temporary bans when syncing queue state', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const skipStart = source.indexOf('function handleSkip()');
    const selectStart = source.indexOf('function handleSelectIndex', skipStart);
    const deleteStart = source.indexOf('function handleDeleteTrack', selectStart);
    const likeStart = source.indexOf('function handleToggleLike', deleteStart);

    const skipBlock = source.slice(skipStart, selectStart);
    const selectBlock = source.slice(selectStart, deleteStart);
    const deleteBlock = source.slice(deleteStart, likeStart);

    expect(source).toContain('const pendingTemporaryBanTracksRef = useRef<QueueTrackDto[]>([])');
    expect(source).toContain('saveQueueState(queue, currentIndex, temporaryBanTracks)');
    expect(skipBlock).toContain('skipCurrentQueueTrack({ queue, currentIndex })');
    expect(skipBlock).toContain('rememberTemporaryBans(transition.removedTracks)');
    expect(selectBlock).toContain('selectQueueTrackAt({ queue, currentIndex }, index)');
    expect(selectBlock).toContain('rememberTemporaryBans(transition.removedTracks)');
    expect(deleteBlock).toContain('deleteQueueTrackAt({ queue, currentIndex }, index)');
    expect(deleteBlock).toContain('rememberTemporaryBans(transition.removedTracks)');
  });

  it('logs DJ pick-next debug tables to the browser console', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const debugStart = source.indexOf('onDebug(playerEvent)');
    const doneStart = source.indexOf('onDone(playerEvent)', debugStart);
    const debugBlock = source.slice(debugStart, doneStart);

    expect(debugBlock).toContain('console.info');
    expect(debugBlock).toContain('DJ pick-next exclusion list');
    expect(debugBlock).toContain('excludedIds');
    expect(debugBlock).toContain('excludedDedupeKeys');
    expect(debugBlock).toContain('candidateScoreTable');
    expect(debugBlock).toContain('console.table');
    expect(debugBlock).toContain('DJ pick-next candidate scores');
    expect(debugBlock).toContain('buildDjPickDebugLog(playerEvent.data)');
    expect(source).toContain('djPickLog.selectedTracks.map');
    expect(source).toContain('track.reason');
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
    expect(source).toContain('getSegueRequestDecision({');
    expect(source).toContain('useEffect(() => {');
    expect(source).toContain('maybeTriggerSegue();');
    expect(source).not.toContain('decision.shouldTriggerSegue &&');
  });

  it('does not stop an already playing segue audio when staging the next TTS clip', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const ttsReadyStart = source.indexOf("type === 'segue.tts-ready'");
    const degradedStart = source.indexOf("type === 'segue.degraded'");
    const ttsReadyBlock = source.slice(ttsReadyStart, degradedStart);

    expect(ttsReadyBlock).toContain('disposeSegueAudio();');
    expect(ttsReadyBlock).not.toContain('disposeSegueAudio(true);');
  });

  it('uses speech duration instead of only the crossfade window when starting segue audio', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const maybeStartStart = source.indexOf('const maybeStartSegueAudio = useCallback(() => {');
    const nextEffectStart = source.indexOf('useEffect(() => {', maybeStartStart);
    const maybeStartBlock = source.slice(maybeStartStart, nextEffectStart);

    expect(source).toContain('@renderer/playerSegueRuntime');
    expect(maybeStartBlock).toContain('shouldStartPendingSegueAudio({');
    expect(maybeStartBlock).not.toContain('trackAudio.currentTime < crossfadeAtSec');
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
    const bannerStart = source.indexOf('function TodayThemePanel');
    const bannerEnd = source.indexOf('function TastePanel', bannerStart);
    const bannerSource = source.slice(bannerStart, bannerEnd);

    expect(source).toContain('saveSettings');
    expect(source).toContain('dailyThemeEnabled');
    expect(source).toContain('handleDailyThemeToggle');
    expect(source).toContain('saveSettings({ dailyThemeEnabled: next })');
    expect(bannerSource).toContain('role="switch"');
    expect(bannerSource).toContain('aria-checked={dailyThemeEnabled}');
  });

  it('places the daily theme panel in the right queue column on the player page', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const leftStart = source.indexOf('{/* Left column — player */}');
    const rightStart = source.indexOf('{/* Right column — queue + status */}');
    const rightEnd = source.indexOf('</section>', rightStart);
    const leftColumn = source.slice(leftStart, rightStart);
    const rightColumn = source.slice(rightStart, rightEnd);

    expect(leftStart).toBeGreaterThan(-1);
    expect(rightStart).toBeGreaterThan(leftStart);
    expect(rightEnd).toBeGreaterThan(rightStart);
    expect(leftColumn).not.toContain('<TodayThemePanel');
    expect(rightColumn).toContain('<TodayThemePanel');
    expect(rightColumn.indexOf('<QueuePanel')).toBeLessThan(rightColumn.indexOf('<TodayThemePanel'));
    expect(rightColumn.indexOf('<TodayThemePanel')).toBeLessThan(rightColumn.indexOf('<DjStatusDock'));
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

  it('PlaybackTimeline distributes waveform bars across the full progress track', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/PlaybackTimeline.tsx'),
      'utf-8'
    );

    const waveformStart = source.indexOf('{Array.from({ length:');
    const waveformEnd = source.indexOf('<input', waveformStart);
    const waveformSource = source.slice(waveformStart, waveformEnd);

    expect(source).toContain('grid w-full');
    expect(source).toContain('gridTemplateColumns');
    expect(waveformSource).not.toContain('shrink-0');
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

  it('passes real cover artwork and discovery mode into the player surface', () => {
    const playerSource = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const heroSource = fs.readFileSync(path.join(root, 'src/renderer/components/player/NowPlayingHero.tsx'), 'utf-8');
    const queueSource = fs.readFileSync(path.join(root, 'src/renderer/components/player/QueuePanel.tsx'), 'utf-8');

    expect(playerSource).toContain('discoveryMode');
    expect(playerSource).toContain('handleDiscoveryModeChange');
    expect(playerSource).toContain('modeConfig');
    expect(playerSource).toContain('coverImgUrl={currentTrack?.coverImgUrl ?? nowPlaying?.coverImgUrl ?? null}');
    expect(heroSource).toContain('coverImgUrl');
    expect(heroSource).toContain('props.coverImgUrl ?? coverPlaceholder');
    expect(queueSource).toContain('track.coverImgUrl');
  });

  it('PlayerView uses the new mode-aware studio layout from the design reference', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('col-span-2');
    expect(source).not.toContain('col-span-3');
    expect(source).toContain('modeConfig');
    expect(source).toContain('modeInfoCards');
    expect(source).toContain('xl:col-span-8');
    expect(source).toContain('xl:col-span-4');
    expect(source).toContain("discoveryMode === 'comfort'");
    expect(source).toContain("discoveryMode === 'legacy'");
    expect(source).toContain('Legacy LLM 模式');
    expect(source).toContain('TodayThemePanel');
    expect(source).toContain('TastePanel');
    expect(source).toContain('DjStatusDock');
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
