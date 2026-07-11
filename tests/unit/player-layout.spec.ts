import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('player layout', () => {
  it('creates one browser playback session with stable system transport handlers and disposes it', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const createStart = source.indexOf('const playbackSession = createBrowserPlaybackSession({');
    const sessionEffectStart = source.lastIndexOf('useEffect(() => {', createStart);
    const sessionEffectEnd = source.indexOf('}, []);', createStart);
    const sessionBlock = source.slice(sessionEffectStart, sessionEffectEnd);

    expect(source).toContain('createBrowserPlaybackSession,');
    expect(source).toContain("from '@renderer/playbackSession'");
    expect(sessionBlock).toContain('createBrowserPlaybackSession({');
    expect(sessionBlock).toContain('onPlay: () => { void requestTrackPlayRef.current(); }');
    expect(sessionBlock).toContain('onPause: () => audioRef.current?.pause()');
    expect(sessionBlock).toContain('onPrevious: () => handlePrevRef.current()');
    expect(sessionBlock).toContain('onNext: () => handleSkipRef.current()');
    expect(sessionBlock).toContain('void playbackSession.dispose()');
    expect(sessionBlock).not.toContain('setInterval');
  });

  it('drives playback session state from native audio events and releases it on ended', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const endedStart = source.indexOf('function onEnded(): void');
    const errorStart = source.indexOf('function onTrackMediaError(): void', endedStart);
    const endedBlock = source.slice(endedStart, errorStart);

    expect(source).toContain('function onNativePlay(): void');
    expect(source).toContain('playbackSessionRef.current?.setPlaying(true)');
    expect(source).toContain('function onNativePause(): void');
    expect(source).toContain('playbackSessionRef.current?.setPlaying(false)');
    expect(endedBlock).toContain('playbackSessionRef.current?.setPlaying(false)');
    expect(source).toContain('onPlay={onNativePlay}');
    expect(source).toContain('onPause={onNativePause}');
  });

  it('publishes current-track metadata and valid native audio position', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const sessionCreation = source.indexOf('const playbackSession = createBrowserPlaybackSession({');
    const metadataSync = source.indexOf('playbackSessionRef.current?.setMetadata({');
    const timeUpdateStart = source.indexOf('function onTimeUpdate(): void');
    const metadataStart = source.indexOf('function onLoadedMetadata(): void', timeUpdateStart);
    const timeUpdateBlock = source.slice(timeUpdateStart, metadataStart);

    expect(sessionCreation).toBeGreaterThan(-1);
    expect(metadataSync).toBeGreaterThan(sessionCreation);
    expect(source).toContain('playbackSessionRef.current?.setMetadata({');
    expect(source).toContain("artist: currentTrack.artists?.join(' / ') ?? ''");
    expect(source).toContain('artwork: currentTrack.coverImgUrl ?? nowPlaying?.coverImgUrl ?? undefined');
    expect(source).toContain("playbackSessionRef.current?.setMetadata({ title: '', artist: '' })");
    expect(timeUpdateBlock).toContain('playbackSessionRef.current?.setPosition({');
    expect(timeUpdateBlock).toContain('duration: audio.duration');
    expect(timeUpdateBlock).toContain('position: audio.currentTime');
    expect(timeUpdateBlock).toContain('playbackRate: audio.playbackRate');
  });

  it('shares the fresh-stream play request between visible and lock-screen controls', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const requestStart = source.indexOf('const requestTrackPlay = useCallback(async (): Promise<void> => {');
    const playPauseStart = source.indexOf('function handlePlayPause(): void', requestStart);
    const requestBlock = source.slice(requestStart, playPauseStart);
    const playPauseEnd = source.indexOf('function handlePrev(): void', playPauseStart);
    const playPauseBlock = source.slice(playPauseStart, playPauseEnd);

    expect(requestBlock).toContain('getTrackMediaManualResumeDecision({');
    expect(requestBlock).toContain('retryTrackPlaybackAfterError(');
    expect(requestBlock).toContain('await audio.play()');
    expect(playPauseBlock).toContain('void requestTrackPlay();');
    expect(playPauseBlock).not.toContain('audio.play()');
  });

  it('integrates previous-track history without changing delete or temporary-ban semantics', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const endedStart = source.indexOf('function onEnded(): void');
    const errorStart = source.indexOf('function onTrackMediaError(): void', endedStart);
    const endedBlock = source.slice(endedStart, errorStart);
    const prevStart = source.indexOf('function handlePrev(): void');
    const skipStart = source.indexOf('function handleSkip()', prevStart);
    const selectStart = source.indexOf('function handleSelectIndex', skipStart);
    const deleteStart = source.indexOf('function handleDeleteTrack', selectStart);
    const rememberBansStart = source.indexOf('function rememberTemporaryBans', deleteStart);
    const prevBlock = source.slice(prevStart, skipStart);
    const skipBlock = source.slice(skipStart, selectStart);
    const selectBlock = source.slice(selectStart, deleteStart);
    const deleteBlock = source.slice(deleteStart, rememberBansStart);
    const loadLikedQueueStart = source.indexOf('async function loadLikedQueue');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying', loadLikedQueueStart);
    const loadLikedQueueBlock = source.slice(loadLikedQueueStart, loadNowPlayingStart);

    expect(source).toContain("import { createPlaybackHistory } from '@renderer/playerPlaybackHistory'");
    expect(source).toContain('const playbackHistoryRef = useRef(createPlaybackHistory())');
    expect(source).toContain('function recordPlaybackHistory(removedTracks: QueueTrackDto[]): void');
    expect(endedBlock).toContain('recordPlaybackHistory(transition.removedTracks)');
    expect(skipBlock).toContain('recordPlaybackHistory(transition.removedTracks)');
    expect(selectBlock).toContain('recordPlaybackHistory(transition.removedTracks)');
    expect(deleteBlock).not.toContain('recordPlaybackHistory(');
    expect(prevBlock).toContain('playbackHistoryRef.current.restore(queue)');
    expect(prevBlock).toContain('shouldAutoplayNextRef.current = isPlaying');
    expect(prevBlock).toContain('applyQueueSnapshot({ queue: restored, currentIndex: 0 })');
    expect(source).toContain('playbackHistoryRef.current.snapshot().length > 0');
    expect(loadLikedQueueBlock).toContain('playbackHistoryRef.current.clear()');
    expect(loadLikedQueueBlock).toContain('setHistoryVersion((version) => version + 1)');
  });

  it('allows the active view to scroll instead of clipping tall player content', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');

    expect(source).toContain('flex-1 overflow-y-auto');
    expect(source).not.toContain('flex-1 overflow-hidden');
  });

  it('keeps playback before mode details in DOM order and restores desktop visual order', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const playerStart = source.indexOf('{/* Mobile-first DOM: player controls precede mode diagnostics for focus and reading order. */}');
    const modeStart = source.indexOf('{/* Desktop visually restores mode controls before the player. */}');

    expect(playerStart).toBeGreaterThan(-1);
    expect(modeStart).toBeGreaterThan(playerStart);
    expect(source).toContain('md:order-2');
    expect(source).toContain('md:order-1');
    expect(source).toContain('md:order-3');
  });

  it('keeps the primary mobile transport controls touchable and icon-first', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/TransportControls.tsx'),
      'utf-8'
    );

    expect(source.match(/min-h-11 min-w-11/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('<span className="hidden sm:inline">Prev</span>');
    expect(source).toContain('<span className="hidden sm:inline">Skip</span>');
  });

  it('uses compact phone artwork and title sizing while restoring the desktop hero scale', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/NowPlayingHero.tsx'),
      'utf-8'
    );

    expect(source).toContain('h-28 w-28');
    expect(source).toContain('md:h-44 md:w-44');
    expect(source).toContain('text-2xl');
    expect(source).toContain('md:text-4xl');
  });

  it('uses dynamic viewport height with a fallback and keeps content clear of every safe-area edge', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');

    expect(source).toContain('h-screen supports-[height:100dvh]:h-[100dvh]');
    expect(source).not.toContain('h-screen h-[100dvh]');
    expect(source).toContain('pt-[env(safe-area-inset-top)]');
    expect(source).toContain('pl-[env(safe-area-inset-left)]');
    expect(source).toContain('pr-[env(safe-area-inset-right)]');
    expect(source).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(source).not.toContain('p-[env(safe-area-inset-');
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
    expect(doneBlock).toContain("setDjStatusText(latestBackupTrackCount >= AUTO_FILL_LOW_WATER_MARK ? '已补充队列' : '正在补充队列…')");
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

  it('creates the segue voice gain controller only after commit and disposes it without returning a promise', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const creation = source.match(/createBrowserSegueVoiceGainController\(\)/g) ?? [];
    const cleanupStart = source.indexOf('const segueVoiceGainController = createBrowserSegueVoiceGainController();');
    const cleanupEnd = source.indexOf('}, []);', cleanupStart);
    const cleanup = source.slice(cleanupStart, cleanupEnd);

    expect(source).toContain('createBrowserSegueVoiceGainController,');
    expect(source).toContain("from '@renderer/audio/segueVoiceGain'");
    expect(source).toContain('const segueVoiceGainControllerRef = useRef<SegueVoiceGainController | null>(null)');
    expect(source).not.toContain('segueVoiceGainControllerRef.current ??= createBrowserSegueVoiceGainController()');
    expect(cleanup).toContain('const segueVoiceGainController = createBrowserSegueVoiceGainController()');
    expect(cleanup).toContain('segueVoiceGainControllerRef.current = segueVoiceGainController');
    expect(cleanup).toContain('segueVoiceGainControllerRef.current = null');
    expect(creation).toHaveLength(1);
    expect(cleanup).toContain('return () => {');
    expect(cleanup).toContain('void segueVoiceGainController.dispose()');
    expect(cleanup).not.toContain('return segueVoiceGainController.dispose()');
  });

  it('prepares a pending segue once before playing and keeps enhanced or native playback on the original element', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const start = source.indexOf('const maybeStartSegueAudio = useCallback(() => {');
    const end = source.indexOf('useEffect(() => {', start);
    const block = source.slice(start, end);

    expect(block).toContain('pending.preparing = true');
    expect(block).toContain('const route = await prepareSegueAudioRoute({');
    expect(block.indexOf('const route = await prepareSegueAudioRoute({')).toBeLessThan(
      block.indexOf('await settleSegueAudioPlay({')
    );
    expect(block).toContain('nativeOnly: pending.nativeOnly');
    expect(block).toContain('play: () => capturedAudio.play()');
    expect(block).toContain('pendingSegueRef.current !== pending');
    expect(block).toContain('pending.audio !== capturedAudio');
    expect(block).toContain('pending.preparing');
  });

  it('replaces an unavailable routed element with a fresh native Audio and preserves handlers without preparing it again', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const start = source.indexOf("if (route === 'unavailable') {");
    const end = source.indexOf('if (pendingSegueRef.current !== pending', start);
    const block = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('capturedAudio.onloadedmetadata = null');
    expect(block).toContain('capturedAudio.onended = null');
    expect(block).toContain('capturedAudio.onerror = null');
    expect(block).toContain('segueVoiceGainControllerRef.current?.release(capturedAudio)');
    expect(block).toContain('unloadAudioElement(capturedAudio)');
    expect(block).toContain('const nativeAudioUrl = capturedAudio.src || pending.audioUrl');
    expect(block).toContain('const nativeAudio = new Audio(nativeAudioUrl)');
    expect(block).toContain('nativeAudio.volume = TRACK_DEFAULT_VOLUME');
    expect(block).toContain('configureSegueAudio(pending, nativeAudio)');
    expect(block).toContain('pending.audio = nativeAudio');
    expect(block).toContain('pending.nativeOnly = true');
    expect(block).toContain('segueAudioRef.current = nativeAudio');
    expect(block).toContain('capturedAudio = nativeAudio');
    expect(block).not.toContain('prepare(nativeAudio)');
    const startBlock = source.slice(source.indexOf('const maybeStartSegueAudio = useCallback(() => {'), source.indexOf('useEffect(() => {', start));
    expect(startBlock.indexOf('capturedAudio = nativeAudio')).toBeLessThan(startBlock.indexOf('play: () => capturedAudio.play()'));
  });

  it('ignores late events from replaced segue elements and releases normal finishes before unloading', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const finishStart = source.indexOf('const finishSegueAudio = useCallback(');
    const finishEnd = source.indexOf('const configureSegueAudio', finishStart);
    const finishBlock = source.slice(finishStart, finishEnd);

    expect(finishStart).toBeGreaterThan(-1);
    expect(finishEnd).toBeGreaterThan(finishStart);
    expect(finishBlock).toContain('pendingSegueRef.current !== pending || pending.audio !== audio');
    expect(finishBlock.indexOf('release(audio)')).toBeLessThan(finishBlock.indexOf('unloadAudioElement(audio)'));
  });

  it('releases a replaced pending clip before unloading without stopping an already playing clip', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const disposeStart = source.indexOf('const disposeSegueAudio = useCallback(');
    const disposeEnd = source.indexOf('const disposeAllSegueAudio', disposeStart);
    const disposeBlock = source.slice(disposeStart, disposeEnd);
    const ttsStart = source.indexOf("type === 'segue.tts-ready'");
    const ttsEnd = source.indexOf("type === 'segue.degraded'", ttsStart);
    const ttsBlock = source.slice(ttsStart, ttsEnd);

    expect(disposeEnd).toBeGreaterThan(disposeStart);
    expect(disposeBlock).toContain('if (pending.started && !force) return');
    expect(disposeBlock.indexOf('release(pending.audio)')).toBeLessThan(disposeBlock.indexOf('unloadAudioElement(pending.audio)'));
    expect(ttsBlock).toContain('disposeSegueAudio();');
    expect(ttsBlock).not.toContain('disposeSegueAudio(true);');
  });

  it('releases force-disposed pending audio before unloading', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const deleteStart = source.indexOf('function handleDeleteTrack');
    const deleteEnd = source.indexOf('function rememberTemporaryBans', deleteStart);
    const deleteBlock = source.slice(deleteStart, deleteEnd);
    const disposeStart = source.indexOf('const disposeSegueAudio = useCallback(');
    const disposeEnd = source.indexOf('const disposeAllSegueAudio', disposeStart);
    const disposeBlock = source.slice(disposeStart, disposeEnd);

    expect(deleteEnd).toBeGreaterThan(deleteStart);
    expect(deleteBlock).toContain('disposeSegueAudio(true)');
    expect(disposeBlock.indexOf('release(pending.audio)')).toBeLessThan(disposeBlock.indexOf('unloadAudioElement(pending.audio)'));
  });

  it('releases every pending and active segue before unmount disposal', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const allStart = source.indexOf('const disposeAllSegueAudio = useCallback(() => {');
    const allEnd = source.indexOf('const resolveSegueDurationSec', allStart);
    const allBlock = source.slice(allStart, allEnd);
    const cleanupStart = source.indexOf('() => () => {\n      disposeAllSegueAudio();');
    const cleanupEnd = source.indexOf('[disposeAllSegueAudio]', cleanupStart);
    const cleanupBlock = source.slice(cleanupStart, cleanupEnd);

    expect(allEnd).toBeGreaterThan(allStart);
    expect(allBlock.indexOf('release(pending.audio)')).toBeLessThan(allBlock.indexOf('unloadAudioElement(pending.audio)'));
    expect(allBlock.indexOf('release(audio)')).toBeLessThan(allBlock.indexOf('unloadAudioElement(audio)'));
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(cleanupBlock).toContain('disposeAllSegueAudio();');
  });

  it('routes play settlement through a mounted identity guard before updating segue status', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const start = source.indexOf('const maybeStartSegueAudio = useCallback(() => {');
    const end = source.indexOf('useEffect(() => {', start);
    const block = source.slice(start, end);

    expect(source).toContain('prepareSegueAudioRoute, settleSegueAudioPlay');
    expect(source).toContain("from '@renderer/playerSegueVoicePlayback'");
    expect(source).toContain('const playerMountedRef = useRef(false)');
    expect(block).toContain('await settleSegueAudioPlay({');
    expect(block).toContain('isCurrent: () =>');
    expect(block).toContain('playerMountedRef.current');
    expect(block).toContain('pendingSegueRef.current === pending');
    expect(block).toContain('pending.audio === capturedAudio');
    expect(block).toContain('pending.started');
    expect(block).toContain('isActive: () => activeSegueAudiosRef.current.has(capturedAudio)');
    expect(block).toContain('onCurrentSuccess: () => {');
    const successStart = block.indexOf('onCurrentSuccess: () => {');
    expect(successStart).toBeGreaterThan(-1);
    expect(block.indexOf('setSegueStatusText(`过渡播报中', successStart)).toBeGreaterThan(successStart);
  });

  it('keeps ducking constants and only tracks the final element that actually plays', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const start = source.indexOf('const maybeStartSegueAudio = useCallback(() => {');
    const end = source.indexOf('useEffect(() => {', start);
    const block = source.slice(start, end);

    expect(source).toContain('const TRACK_DEFAULT_VOLUME = 1');
    expect(source).toContain('const TRACK_DUCKING_VOLUME = 0.2');
    expect(block.indexOf('activeSegueAudiosRef.current.add(capturedAudio)')).toBeGreaterThan(
      block.indexOf("if (route === 'unavailable') {")
    );
    expect(block).not.toContain('activeSegueAudiosRef.current.add(pending.audio)');
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

  it('PlayerView resets NCM session state locally after logout succeeds', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );
    const refreshStart = source.indexOf('async function refreshSession');
    const refreshEnd = source.indexOf('async function startNcmQrLogin', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    const logoutStart = source.indexOf('async function handleNcmLogout');
    const logoutEnd = source.indexOf('useEffect(() => {', logoutStart);
    const logoutBody = source.slice(logoutStart, logoutEnd);

    expect(source).toContain('function resetNcmAuthState(): void');
    expect(refreshBody).toContain('if (!getStoredToken())');
    expect(refreshBody).toContain('resetNcmAuthState();');
    expect(logoutBody).toContain('await logoutNcm();');
    expect(logoutBody).toContain('setSseToken(null);');
    expect(logoutBody).toContain('resetNcmAuthState();');
    expect(logoutBody).toContain("setTrackStatusText('已登出 NCM');");
    expect(logoutBody).not.toContain('await refreshSession();');
  });

  it('PlayerView polls NCM QR login status automatically while preserving manual checks', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).toContain('const QR_LOGIN_POLL_INTERVAL_MS = 2000');
    expect(source).toContain('async function checkNcmQrStatus');
    expect(source).toContain('async function checkCurrentNcmQrStatus');
    expect(source).toContain('window.setTimeout(() => {');
    expect(source.match(/void checkCurrentNcmQrStatus/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('PlayerView refreshes a failed track stream before manual playback resumes', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );
    const playPauseStart = source.indexOf('const requestTrackPlay = useCallback(async (): Promise<void> => {');
    const prevStart = source.indexOf('function handlePrev(): void');
    const playPauseBody = source.slice(playPauseStart, prevStart);

    expect(source).toContain('trackMediaManualResumeRequiredRef');
    expect(playPauseBody).toContain('getTrackMediaManualResumeDecision({');
    expect(playPauseBody).toContain('retryTrackPlaybackAfterError(');
    expect(playPauseBody).toContain('trackMediaRetryAttemptsRef.current = 0');
    expect(source).toContain('trackMediaManualResumeRequiredRef.current = Boolean(trackId)');
  });
});
