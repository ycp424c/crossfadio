import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CloudSun,
  Compass,
  Home,
  LogOut,
  MapPin,
  Palette,
  QrCode,
  ScanSearch,
  Settings2,
  Sparkles,
  X
} from 'lucide-react';
import {
  checkNcmQr,
  createNcmQr,
  getLikedQueue,
  getLikedTrackIds,
  getNcmSession,
  getNextTrack,
  getNowPlaying,
  getPlayerContext,
  getSettings,
  logoutNcm,
  getStoredToken,
  saveSettings,
  saveQueueState,
  toggleLikeTrack,
  updateLocation
} from '@renderer/api';
import { getPrefetchDecision } from '@renderer/audio/prefetch';
import { shouldTreatMediaErrorAsEnded } from '@renderer/audio/mediaError';
import { NowPlayingHero } from '@renderer/components/player/NowPlayingHero';
import { PlaybackTimeline } from '@renderer/components/player/PlaybackTimeline';
import { QueuePanel } from '@renderer/components/player/QueuePanel';
import { TransportControls } from '@renderer/components/player/TransportControls';
import { initSseEvents, addSseListener, closeSseEvents, streamSegue, streamPickNext } from '@renderer/sse/client';
import { useMediaQuery } from '@renderer/lib-hooks';
import { persistQueueSnapshot, restorePersistedQueueSnapshot } from '@renderer/playerQueueCache';
import type { NextTrackResponse, NowPlayingResponse, QueueTrackDto } from '@shared/schema';
import appMark from '@renderer/assets/image2/crossfadio-mark.svg';


type NcmSessionState = {
  hasCookie: boolean;
  profile: unknown | null;
};

type PlayerViewProps = {
  onNavigate?: (tab: 'plan' | 'settings') => void;
};

const DEFAULT_DUCKING_HINT_SEC = 8;
const TRACK_DEFAULT_VOLUME = 1;
const TRACK_DUCKING_VOLUME = 0.2;
const DJ_TARGET_QUEUE = 3;       // keep this many songs in queue at all times
const DJ_PICK_COOLDOWN_MS = 3000; // min ms between pick-next calls
const SEGUE_RETRY_COOLDOWN_MS = 6000; // min ms between segue trigger retries within the same track

type DiscoveryMode = 'explore' | 'comfort';

function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isActiveSegueMessage(
  msg: Record<string, unknown>,
  activeId: string | null
): boolean {
  if (!activeId) return false;
  return typeof msg.clientRequestId === 'string' && msg.clientRequestId === activeId;
}

type PendingSegueAudio = {
  audio: HTMLAudioElement;
  estimatedDurationSec: number;
  actualDurationSec: number | null;
  started: boolean;
};

type DjTrackSample = { id: string; name: string; artist: string };

type DjPickLog = {
  likedSample: DjTrackSample[];
  searchQueries: string[];
  searchedTracks: DjTrackSample[];
  totalCandidates: number;
  selectedSay: string;
};

export function PlayerView({ onNavigate }: PlayerViewProps): JSX.Element {
  const [queue, setQueue] = useState<QueueTrackDto[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingResponse | null>(null);
  const [nextTrack, setNextTrack] = useState<NextTrackResponse | null>(null);
  const [likedTrackIds, setLikedTrackIds] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [trackStatusText, setTrackStatusText] = useState('准备就绪');
  const [djStatusText, setDjStatusText] = useState('');
  const [segueStatusText, setSegueStatusText] = useState('');
  const [segueScriptText, setSegueScriptText] = useState('');
  const [segueScriptExpanded, setSegueScriptExpanded] = useState(false);
  const [djPickLog, setDjPickLog] = useState<DjPickLog | null>(null);
  const [djPickLogExpanded, setDjPickLogExpanded] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [statusExpanded, setStatusExpanded] = useState(isDesktop);
  useEffect(() => { setStatusExpanded(isDesktop); }, [isDesktop]);
  const [error, setError] = useState('');
  const [session, setSession] = useState<NcmSessionState>({ hasCookie: false, profile: null });
  const [qrPayload, setQrPayload] = useState<{ key: string; qrimg: string } | null>(null);
  const [showNcmDropdown, setShowNcmDropdown] = useState(false);
  const [showNcmSheet, setShowNcmSheet] = useState(false);
  const [sseToken, setSseToken] = useState<string | null>(() => getStoredToken());
  const [dailyTheme, setDailyTheme] = useState<{ theme: string; keywords: string[] } | null>(null);
  const [weatherContext, setWeatherContext] = useState<{ location: string; tempC: number; desc: string } | null>(null);
  const [geolocationIssue, setGeolocationIssue] = useState<string | null>(null);
  const [dailyThemeEnabled, setDailyThemeEnabled] = useState(true);
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>('explore');
  const [userTaste, setUserTaste] = useState('');
  const [tasteExpanded, setTasteExpanded] = useState(false);

  // Body scroll lock when mobile NCM sheet is open
  useEffect(() => {
    if (!showNcmSheet) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [showNcmSheet]);

  // ESC key closes mobile NCM sheet
  useEffect(() => {
    if (!showNcmSheet) return;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setShowNcmSheet(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [showNcmSheet]);

  const ncmDropdownRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segueAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSegueRef = useRef<PendingSegueAudio | null>(null);
  const shouldAutoplayNextRef = useRef(false);
  const prefetchTriggeredRef = useRef(false);
  const segueClientRequestIdRef = useRef<string | null>(null);
  const segueExpectedFromTrackIdRef = useRef<string | null>(null);
  const segueSatisfiedForTrackIdRef = useRef<string | null>(null);
  const segueLastAttemptAtRef = useRef<number>(0);
  const djPickNextLastCallRef = useRef<number>(0);
  const djPickNextInFlightRef = useRef(false);
  const applyingRemoteQueueRef = useRef(false);
  const skipNextQueuePersistRef = useRef(true);

  useEffect(() => {
    if (!showNcmDropdown) return;
    function handleClickOutside(event: MouseEvent): void {
      if (ncmDropdownRef.current && !ncmDropdownRef.current.contains(event.target as Node)) {
        setShowNcmDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNcmDropdown]);

  const queueIds = useMemo(() => queue.map((track) => track.id), [queue]);
  const currentTrack = queue[currentIndex] ?? null;
  const currentTrackId = currentTrack?.id ?? null;
  const currentTrackIdRef = useRef<string | null>(currentTrackId);
  currentTrackIdRef.current = currentTrackId;
  const nowPlayingRef = useRef<NowPlayingResponse | null>(nowPlaying);
  nowPlayingRef.current = nowPlaying;

  const restoreTrackVolume = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.volume = TRACK_DEFAULT_VOLUME;
    }
  }, []);

  const disposeSegueAudio = useCallback(
    (force = false) => {
      const pending = pendingSegueRef.current;
      if (!pending) return;
      if (pending.started && !force) return;

      pending.audio.pause();
      pending.audio.removeAttribute('src');
      pending.audio.load();
      pendingSegueRef.current = null;
      segueAudioRef.current = null;
      restoreTrackVolume();
    },
    [restoreTrackVolume]
  );

  const resolveSegueDurationSec = useCallback((pending: PendingSegueAudio): number => {
    if (Number.isFinite(pending.actualDurationSec) && (pending.actualDurationSec ?? 0) > 0) {
      return pending.actualDurationSec as number;
    }
    return pending.estimatedDurationSec;
  }, []);

  const maybeStartSegueAudio = useCallback(() => {
    const trackAudio = audioRef.current;
    const pending = pendingSegueRef.current;

    if (!trackAudio || trackAudio.paused || !pending || pending.started) {
      return;
    }

    // Only start at the crossfade window — don't play the moment TTS arrives
    const crossfadeSec = nowPlayingRef.current?.timing.crossfadeSec ?? DEFAULT_DUCKING_HINT_SEC;
    const trackDuration = trackAudio.duration;
    if (!Number.isFinite(trackDuration) || trackDuration <= 0) {
      return;
    }
    const crossfadeAtSec = Math.max(0, trackDuration - crossfadeSec);
    if (trackAudio.currentTime < crossfadeAtSec) {
      return;
    }

    const segueDurationSec = resolveSegueDurationSec(pending);
    pending.started = true;
    trackAudio.volume = TRACK_DUCKING_VOLUME;
    void pending.audio
      .play()
      .then(() => {
        setSegueStatusText(`过渡播报中（约 ${Math.round(segueDurationSec)} 秒）`);
      })
      .catch(() => {
        pending.started = false;
        restoreTrackVolume();
        setSegueStatusText('过渡语音已就绪，等待用户点击 Play 后继续');
      });
  }, [resolveSegueDurationSec, restoreTrackVolume]);

  useEffect(() => {
    if (queueIds.length === 0) {
      setCurrentIndex(0);
      return;
    }

    if (currentIndex >= queueIds.length) {
      setCurrentIndex(queueIds.length - 1);
    }
  }, [currentIndex, queueIds]);

  useEffect(() => {
    void refreshSession();

    const restoredQueue = restorePersistedQueueSnapshot();
    if (restoredQueue) {
      setQueue(restoredQueue.queue);
      setCurrentIndex(restoredQueue.currentIndex);
      setTrackStatusText('已恢复上次播放列表');
      setDjStatusText('播放列表已从本机恢复');
    } else {
      void loadLikedQueue();
    }
  }, []);

  useEffect(() => {
    if (!sseToken) {
      setDailyTheme(null);
      setWeatherContext(null);
      setDailyThemeEnabled(true);
      setUserTaste('');
      return;
    }

    void Promise.all([getPlayerContext(), getSettings()])
      .then(([ctx, settings]) => {
        if (ctx.ok) {
          setDailyTheme(ctx.theme);
          setWeatherContext(ctx.weather);
          console.info('[Crossfadio] player context weather', { weather: ctx.weather });
          setUserTaste(ctx.taste);
          setDiscoveryMode(ctx.discoveryMode);
        }
        setDailyThemeEnabled(settings.dailyThemeEnabled);
        setDiscoveryMode(settings.discoveryMode);
      })
      .catch(() => {});
  }, [sseToken]);

  useEffect(() => {
    if (!sseToken) {
      return;
    }
    if (!('geolocation' in navigator)) {
      setGeolocationIssue('当前浏览器不支持定位，天气会使用 auto。');
      console.warn('[Crossfadio] weather geolocation unavailable', {
        isSecureContext: window.isSecureContext,
        protocol: window.location.protocol
      });
      return;
    }

    console.info('[Crossfadio] weather geolocation request', {
      isSecureContext: window.isSecureContext,
      protocol: window.location.protocol
    });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(4);
        const lon = pos.coords.longitude.toFixed(4);
        setGeolocationIssue(null);
        console.info('[Crossfadio] weather geolocation resolved', { lat, lon });
        void updateLocation(pos.coords.latitude, pos.coords.longitude)
          .then(() => {
            console.info('[Crossfadio] weather location updated', { lat, lon });
            void refreshPlayerContext().catch(() => {});
          })
          .catch((err) => {
            console.warn('[Crossfadio] weather location update failed', { err });
          });
      },
      (err) => {
        const insecureOriginBlocked =
          err.code === 1 && (!window.isSecureContext || err.message.includes('Only secure origins are allowed'));
        setGeolocationIssue(
          insecureOriginBlocked
            ? `浏览器安全策略阻止定位：${err.message || 'Only secure origins are allowed'}。解决方案1：在 Chrome 打开 chrome://flags/#unsafely-treat-insecure-origin-as-secure，把当前 http://IP:4318 加入白名单后重启浏览器。`
            : `浏览器定位失败：${err.message || `code=${err.code}`}。天气会使用 auto。`
        );
        console.warn('[Crossfadio] weather geolocation failed', {
          code: err.code,
          message: err.message,
          isSecureContext: window.isSecureContext,
          protocol: window.location.protocol
        });
      }
    );
  }, [sseToken]);

  useEffect(() => {
    if (!sseToken) return;
    initSseEvents(sseToken);
    const unsub = addSseListener((event, data) => {
      if (event === 'queue-updated') {
        const d = data as Record<string, unknown>;
        const nextQueue: QueueTrackDto[] = Array.isArray(d.queue)
          ? (d.queue as unknown[]).map((track): QueueTrackDto | null => {
              if (!track || typeof track !== 'object' || !('ncmId' in track)) return null;
              const t = track as unknown as Record<string, unknown>;
              return {
                id: String(t.ncmId),
                name: typeof t.name === 'string' ? t.name : `Track ${t.ncmId}`,
                artists: Array.isArray(t.artists) ? (t.artists as string[]) : [],
                durationMs: typeof t.durationMs === 'number' ? t.durationMs : 0,
                coverImgUrl: typeof t.coverImgUrl === 'string' ? t.coverImgUrl : null
              };
            })
            .filter((track): track is QueueTrackDto => track !== null)
          : [];
        const nextIndex = typeof d.currentIndex === 'number' ? d.currentIndex : 0;
        applyingRemoteQueueRef.current = true;
        setQueue(nextQueue);
        setCurrentIndex(nextIndex);
      } else if (event === 'queue-appended') {
        const t = (data as Record<string, unknown>).track as { ncmId?: unknown; name?: unknown; artists?: unknown; durationMs?: unknown; coverImgUrl?: unknown } | null;
        if (t && typeof t === 'object' && t.ncmId) {
          const appended: QueueTrackDto = {
            id: String(t.ncmId),
            name: typeof t.name === 'string' ? t.name : `Track ${t.ncmId}`,
            artists: Array.isArray(t.artists) ? (t.artists as string[]) : [],
            durationMs: typeof t.durationMs === 'number' ? t.durationMs : 0,
            coverImgUrl: typeof (t as { coverImgUrl?: unknown }).coverImgUrl === 'string'
              ? (t as { coverImgUrl: string }).coverImgUrl
              : null
          };
          setQueue((prev) => [...prev, appended]);
        }
      }
    });
    return () => { unsub(); closeSseEvents(); };
  }, [sseToken]);

  useEffect(() => {
    if (skipNextQueuePersistRef.current) {
      skipNextQueuePersistRef.current = false;
      return;
    }
    persistQueueSnapshot(queue, currentIndex);
    if (applyingRemoteQueueRef.current) {
      applyingRemoteQueueRef.current = false;
      return;
    }
    void saveQueueState(queue, currentIndex).catch(() => {
      // Queue sync is best effort; playback should keep running locally.
    });
  }, [currentIndex, queue]);

  // When the queue gains a new song while currentTrackId hasn't changed,
  // nextTrack may still be null — refresh it so segue can fire promptly.
  useEffect(() => {
    if (currentTrackId && queueIds.length > 1) {
      void refreshNextTrack(currentTrackId);
    }
    // intentionally only watching queueIds.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIds.length]);

  useEffect(() => {
    if (!currentTrackId) {
      setNowPlaying(null);
      resetTrackMedia();
      return;
    }

    disposeSegueAudio();
    resetTrackMedia();
    prefetchTriggeredRef.current = false;
    segueClientRequestIdRef.current = null;
    segueExpectedFromTrackIdRef.current = null;
    segueSatisfiedForTrackIdRef.current = null;
    segueLastAttemptAtRef.current = 0;
    setSegueStatusText('');
    setSegueScriptText('');
    setSegueScriptExpanded(false);
    setTrackStatusText(`正在加载曲目 ${currentTrackId} ...`);

    void loadNowPlaying(currentTrackId);
    void refreshNextTrack(currentTrackId);
  }, [currentTrackId, disposeSegueAudio]);

  useEffect(
    () => () => {
      disposeSegueAudio(true);
    },
    [disposeSegueAudio]
  );

  async function refreshSession(): Promise<void> {
    try {
      const payload = await getNcmSession();
      setSession({ hasCookie: payload.hasCookie, profile: payload.profile });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'session 请求失败');
    }
  }

  async function refreshPlayerContext(): Promise<void> {
    const ctx = await getPlayerContext();
    if (ctx.ok) {
      setDailyTheme(ctx.theme);
      setWeatherContext(ctx.weather);
      console.info('[Crossfadio] player context weather', { weather: ctx.weather });
      setUserTaste(ctx.taste);
      setDiscoveryMode(ctx.discoveryMode);
    }
  }

  async function handleDailyThemeToggle(): Promise<void> {
    const next = !dailyThemeEnabled;
    setDailyThemeEnabled(next);
    if (!next) {
      setDailyTheme(null);
    }

    try {
      await saveSettings({ dailyThemeEnabled: next });
      if (next) {
        await refreshPlayerContext();
      }
    } catch (err) {
      setDailyThemeEnabled(!next);
      if (next) {
        setDailyTheme(null);
      } else {
        void refreshPlayerContext().catch(() => {});
      }
      setError(err instanceof Error ? err.message : '每日主题设置保存失败');
    }
  }

  async function handleDiscoveryModeChange(next: DiscoveryMode): Promise<void> {
    if (next === discoveryMode) return;
    const prev = discoveryMode;
    setDiscoveryMode(next);
    setDjStatusText(next === 'explore' ? '探索模式：放宽个人品味权重' : '舒适区模式：提高个人品味匹配');
    try {
      await saveSettings({ discoveryMode: next });
    } catch (err) {
      setDiscoveryMode(prev);
      setError(err instanceof Error ? err.message : '模式保存失败');
    }
  }

  async function loadLikedQueue(): Promise<void> {
    try {
      const [payload, likedIds] = await Promise.all([
        getLikedQueue(50),
        getLikedTrackIds()
      ]);
      setLikedTrackIds(likedIds);
      if (payload.tracks.length === 0) {
        setError('红心歌单为空，请先在网易云收藏歌曲');
        return;
      }
      const randomIdx = Math.floor(Math.random() * payload.tracks.length);
      const startTrack = payload.tracks[randomIdx];
      djPickNextLastCallRef.current = 0;
      djPickNextInFlightRef.current = false;
      setQueue([startTrack]);
      setCurrentIndex(0);
      setTrackStatusText(`DJ 模式启动：随机选中「${startTrack.name ?? startTrack.id}」`);
      setDjStatusText('正在补充队列…');
    } catch (err) {
      setError(err instanceof Error ? err.message : '红心歌单加载失败');
    }
  }

  async function loadNowPlaying(trackId: string): Promise<void> {
    try {
      const trackMeta = queue[currentIndex];
      const payload = await getNowPlaying(trackId, {
        name: trackMeta?.name,
        artist: trackMeta?.artists?.join(' / ')
      });
      if (currentTrackIdRef.current !== trackId) {
        return;
      }
      setNowPlaying(payload);
      setError('');

      if (audioRef.current) {
        audioRef.current.src = payload.url;
        audioRef.current.load();
        if (shouldAutoplayNextRef.current) {
          shouldAutoplayNextRef.current = false;
          void audioRef.current.play().catch(() => {
            setTrackStatusText('下一首已就绪，点击 Play 继续播放');
          });
        }
      }

      setTrackStatusText(`已加载 ${trackId}`);
    } catch (err) {
      if (currentTrackIdRef.current !== trackId) {
        return;
      }
      setNowPlaying(null);
      setTrackStatusText('加载失败');
      setError(err instanceof Error ? err.message : 'now 请求失败');
    }
  }

  function resetTrackMedia(): void {
    setNowPlaying(null);
    setPositionSec(0);
    setDurationSec(0);

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  async function refreshNextTrack(trackId: string): Promise<void> {
    if (queueIds.length === 0) {
      setNextTrack(null);
      return;
    }

    // If current track is the last in the queue, there's no next track — skip the request.
    const idx = queueIds.indexOf(trackId);
    if (idx !== -1 && idx >= queueIds.length - 1) {
      setNextTrack(null);
      return;
    }

    try {
      const payload = await getNextTrack(queueIds, trackId);
      setNextTrack(payload);
    } catch {
      setNextTrack(null);
    }
  }

  const maybeTriggerSegue = useCallback(() => {
    const audio = audioRef.current;
    const nextTrackId = nextTrack?.track.id ?? null;
    if (!audio || audio.paused || !currentTrackId || !nextTrackId) {
      return;
    }

    if (nextTrackId === currentTrackId) {
      return;
    }

    if (segueSatisfiedForTrackIdRef.current === currentTrackId || segueClientRequestIdRef.current !== null) {
      return;
    }

    if (Date.now() - segueLastAttemptAtRef.current < SEGUE_RETRY_COOLDOWN_MS) {
      return;
    }

    const clientRequestId = newClientRequestId();
    const nextQueueTrack = queue.find((track) => track.id === nextTrackId) ?? null;
    segueClientRequestIdRef.current = clientRequestId;
    segueExpectedFromTrackIdRef.current = currentTrackId;
    segueLastAttemptAtRef.current = Date.now();
    setSegueStatusText(`生成中：${currentTrackId} → ${nextTrackId}`);
    void (async () => {
      try {
        for await (const { type, data } of streamSegue({
          clientRequestId,
          from: { id: currentTrackId, name: currentTrack?.name, artist: currentTrack?.artists?.[0] },
          to: { id: nextTrackId, name: nextQueueTrack?.name ?? nextTrack?.track.name, artist: nextQueueTrack?.artists?.[0] ?? nextTrack?.track.artists?.[0] }
        })) {
          if (type === 'segue.delta') {
            if (!isActiveSegueMessage(data, segueClientRequestIdRef.current)) continue;
            const say = String(data.say ?? '').trim();
            if (say) {
              setSegueStatusText('生成中…接收文案 token');
            }
          } else if (type === 'segue.tts-ready') {
            if (!isActiveSegueMessage(data, segueClientRequestIdRef.current)) continue;
            if (
              segueExpectedFromTrackIdRef.current &&
              segueExpectedFromTrackIdRef.current !== currentTrackIdRef.current
            ) {
              continue;
            }
            segueClientRequestIdRef.current = null;
            if (currentTrackIdRef.current) {
              segueSatisfiedForTrackIdRef.current = currentTrackIdRef.current;
            }

            const ttsHintSec =
              data.segue && typeof data.segue === 'object' && 'duckingHintSec' in data.segue
                ? Number((data.segue as { duckingHintSec: unknown }).duckingHintSec)
                : NaN;
            const speechDurationSec =
              typeof data.speechDurationSec === 'number' && data.speechDurationSec > 0 ? data.speechDurationSec : NaN;
            const dynamicHintSec = Number.isFinite(speechDurationSec)
              ? Math.max(1, speechDurationSec)
              : Number.isFinite(ttsHintSec) && ttsHintSec > 0
                ? ttsHintSec
                : DEFAULT_DUCKING_HINT_SEC;

            const sayText =
              data.segue && typeof data.segue === 'object' && 'say' in data.segue
                ? String((data.segue as { say: unknown }).say).trim()
                : '';
            if (sayText) setSegueScriptText(sayText);

            const audioUrl = typeof data.audioUrl === 'string' ? data.audioUrl : null;
            if (!audioUrl) {
              setSegueStatusText('过渡文案已生成（未配置 TTS）');
              continue;
            }

            disposeSegueAudio(true);
            const audio = new Audio(audioUrl);
            audio.preload = 'auto';
            audio.volume = 1;
            const pending: PendingSegueAudio = {
              audio,
              estimatedDurationSec: dynamicHintSec,
              actualDurationSec: null,
              started: false
            };

            audio.onloadedmetadata = () => {
              const duration = audio.duration;
              if (pendingSegueRef.current?.audio !== audio) return;
              if (Number.isFinite(duration) && duration > 0) {
                pending.actualDurationSec = duration;
              }
            };
            audio.onended = () => {
              if (pendingSegueRef.current?.audio === audio) {
                pendingSegueRef.current = null;
                segueAudioRef.current = null;
              }
              restoreTrackVolume();
            };
            audio.onerror = () => {
              if (pendingSegueRef.current?.audio === audio) {
                pendingSegueRef.current = null;
                segueAudioRef.current = null;
              }
              restoreTrackVolume();
              setSegueStatusText('过渡语音播放失败');
            };

            pendingSegueRef.current = pending;
            segueAudioRef.current = audio;
            setSegueStatusText(`过渡语音已就绪（约 ${Math.round(dynamicHintSec)} 秒）`);
            maybeStartSegueAudio();
          } else if (type === 'segue.degraded') {
            if (!isActiveSegueMessage(data, segueClientRequestIdRef.current)) continue;
            const reason =
              typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : 'unknown';
            segueClientRequestIdRef.current = null;
            setSegueStatusText(`过渡语音暂不可用（${reason}）`);
          }
        }
      } catch (err) {
        if (segueClientRequestIdRef.current === clientRequestId) {
          segueClientRequestIdRef.current = null;
        }
        const message = err instanceof Error ? err.message : 'segue 请求失败';
        setSegueStatusText(`请求失败：${message}`);
        setError(message);
      }
    })();
  }, [currentTrack, currentTrackId, nextTrack, queue]);

  useEffect(() => {
    maybeTriggerSegue();
  }, [isPlaying, currentTrackId, nextTrack, maybeTriggerSegue]);

  function handlePlayPause(): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play().then(() => {
        maybeStartSegueAudio();
      });
      return;
    }

    audio.pause();
  }

  function handlePrev(): void {
    // DJ mode: no history to go back to
  }

  function handleSkip(): void {
    if (queue.length <= 1) return;
    if (isPlaying) shouldAutoplayNextRef.current = true;
    setQueue((q) => q.slice(1));
    setCurrentIndex(0);
  }

  function handleSelectIndex(index: number): void {
    if (index <= 0 || index >= queue.length) return;
    if (isPlaying) shouldAutoplayNextRef.current = true;
    setQueue((q) => q.slice(index));
    setCurrentIndex(0);
  }

  function handleDeleteTrack(index: number): void {
    if (index === currentIndex) return;

    const deletedId = queue[index]?.id ?? null;
    const isNext = deletedId !== null && deletedId === (nextTrack?.track.id ?? null);

    setQueue((q) => [...q.slice(0, index), ...q.slice(index + 1)]);

    if (index < currentIndex) {
      setCurrentIndex((i) => i - 1);
    }

    if (isNext) {
      disposeSegueAudio(true);
      segueClientRequestIdRef.current = null;
      segueSatisfiedForTrackIdRef.current = null;
      segueLastAttemptAtRef.current = 0;
      setNextTrack(null);
      setSegueStatusText('下一首已移除，重新生成过渡…');
    }
  }

  function handleToggleLike(): void {
    if (!currentTrackId) {
      return;
    }

    setLikedTrackIds((ids) => {
      const isLiked = ids.includes(currentTrackId);
      const nextLike = !isLiked;

      // 乐观更新本地 state，异步同步到 NCM
      toggleLikeTrack(currentTrackId, nextLike).catch(() => {
        // 静默失败：本地状态优先，不阻断 UI
      });

      return isLiked ? ids.filter((id) => id !== currentTrackId) : [...ids, currentTrackId];
    });
  }

  function handleSeek(positionSec: number): void {
    setPositionSec(positionSec);
    if (audioRef.current) {
      audioRef.current.currentTime = positionSec;
    }
  }

  function onTimeUpdate(): void {
    const audio = audioRef.current;
    if (!audio || !nowPlaying) {
      return;
    }

    setPositionSec(audio.currentTime);
    setDurationSec(audio.duration || 0);

    const decision = getPrefetchDecision(audio.currentTime, audio.duration || 0, nowPlaying.timing);

    if (!prefetchTriggeredRef.current && decision.shouldPrefetchNext && currentTrackId) {
      prefetchTriggeredRef.current = true;
      setTrackStatusText('预取触发');
      void refreshNextTrack(currentTrackId);
    }

    maybeTriggerSegue();

    const nextTrackId = nextTrack?.track.id ?? null;
    const segueAttempted = segueSatisfiedForTrackIdRef.current === currentTrackId
      || segueClientRequestIdRef.current !== null
      || segueLastAttemptAtRef.current > 0;

    if (!segueAttempted && currentTrackId) {
      // Surface why the trigger hasn't fired yet, so "空闲" doesn't hide a waiting state.
      if (!nextTrackId) {
        setSegueStatusText('已开播，等待下一首加入队列');
      } else if (nextTrackId === currentTrackId) {
        setSegueStatusText('下一首与当前相同，跳过');
      }
    }

    // DJ mode: keep queue at DJ_TARGET_QUEUE songs; rate-limited by cooldown.
    // Defer while a segue request is in flight so both jobs don't compete for LLM bandwidth —
    // segue has a hard timing constraint, DJ pick-next does not.
    const segueInFlight = segueClientRequestIdRef.current !== null;
    if (isPlaying && !segueInFlight && !djPickNextInFlightRef.current && queueIds.length < DJ_TARGET_QUEUE) {
      const now = Date.now();
      if (now - djPickNextLastCallRef.current >= DJ_PICK_COOLDOWN_MS) {
        djPickNextLastCallRef.current = now;
        djPickNextInFlightRef.current = true;
        setDjStatusText('正在挑选下一首…');
        void (async () => {
          try {
            for await (const { type, data } of streamPickNext({ queue, currentIndex })) {
              if (type === 'dj.debug') {
                const excludedIds = Array.isArray(data.excludedIds) ? data.excludedIds as string[] : [];
                const excludedDedupeKeys = Array.isArray(data.excludedDedupeKeys) ? data.excludedDedupeKeys as string[] : [];
                console.info('[Crossfadio] DJ pick-next exclusion list', {
                  excludedIds,
                  excludedDedupeKeys,
                  excludedIdCount: excludedIds.length,
                  excludedDedupeKeyCount: excludedDedupeKeys.length
                });
                setDjPickLog({
                  likedSample: Array.isArray(data.likedSample) ? data.likedSample as DjTrackSample[] : [],
                  searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries as string[] : [],
                  searchedTracks: Array.isArray(data.searchedTracks) ? data.searchedTracks as DjTrackSample[] : [],
                  totalCandidates: typeof data.totalCandidates === 'number' ? data.totalCandidates : 0,
                  selectedSay: typeof data.selectedSay === 'string' ? data.selectedSay : '',
                });
              } else if (type === 'dj.pick-next.done') {
                if (data.added) {
                  const name = typeof data.trackName === 'string' ? data.trackName : '';
                  setDjStatusText(name ? `已加入「${name}」` : '已补充一首');
                } else {
                  djPickNextLastCallRef.current = 0;
                  const reason = typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : '稍后重试';
                  setDjStatusText(`补歌失败（${reason}）`);
                }
              }
            }
          } catch {
            djPickNextLastCallRef.current = 0;
            setDjStatusText('补歌请求失败');
          } finally {
            djPickNextInFlightRef.current = false;
          }
        })();
      }
    }

    maybeStartSegueAudio();
  }

  function onLoadedMetadata(): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setDurationSec(audio.duration || 0);
  }

  function onEnded(): void {
    if (queue.length > 1) {
      shouldAutoplayNextRef.current = true;
      setQueue((q) => q.slice(1));
      setCurrentIndex(0);
      return;
    }
    setIsPlaying(false);
    shouldAutoplayNextRef.current = false;
    setQueue([]);
    setCurrentIndex(0);
    setTrackStatusText('播放完成');
  }

  function onTrackMediaError(): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (shouldTreatMediaErrorAsEnded({ currentTime: audio.currentTime, duration: audio.duration })) {
      setTrackStatusText('音频流在结尾断开，继续下一首');
      onEnded();
      return;
    }

    setIsPlaying(false);
    shouldAutoplayNextRef.current = false;
    setTrackStatusText('播放流中断');
    setError('音频资源加载中断，请稍后重试或切换下一首');
  }

  const canPrev = false;
  const canSkip = queue.length > 1;
  const isLiked = currentTrackId ? likedTrackIds.includes(currentTrackId) : false;
  const modeSurface = discoveryMode === 'explore'
    ? {
        page: 'bg-[radial-gradient(circle_at_12%_0%,rgba(34,197,94,0.20)_0%,transparent_28%),radial-gradient(circle_at_80%_8%,rgba(6,182,212,0.18)_0%,transparent_30%),linear-gradient(135deg,#07100f_0%,#070a12_44%,#020407_100%)]',
        panel: 'border-emerald-400/15 bg-zinc-950/62',
        accent: 'text-emerald-200',
        soft: 'bg-emerald-400/10 text-emerald-100 border-emerald-300/20',
        active: 'bg-emerald-400 text-zinc-950 shadow-[0_0_28px_rgba(52,211,153,0.28)]',
        inactive: 'text-zinc-400 hover:text-emerald-100',
        rail: 'border-cyan-300/15 bg-cyan-950/18',
        caption: '品味外延 · 主题/天气/时间混合'
      }
    : {
        page: 'bg-[radial-gradient(circle_at_16%_0%,rgba(251,191,36,0.18)_0%,transparent_27%),radial-gradient(circle_at_78%_8%,rgba(244,114,182,0.12)_0%,transparent_28%),linear-gradient(135deg,#120d08_0%,#090909_46%,#040405_100%)]',
        panel: 'border-amber-300/15 bg-zinc-950/68',
        accent: 'text-amber-200',
        soft: 'bg-amber-400/10 text-amber-100 border-amber-300/20',
        active: 'bg-amber-300 text-zinc-950 shadow-[0_0_28px_rgba(251,191,36,0.24)]',
        inactive: 'text-zinc-400 hover:text-amber-100',
        rail: 'border-rose-300/15 bg-rose-950/14',
        caption: '高匹配 · 常听风格优先'
      };

  return (
    <main className={`${modeSurface.page} min-h-screen p-4 md:p-6 text-zinc-100 transition-colors duration-500`}>
      <div className="mx-auto grid max-w-[1480px] grid-cols-1 md:grid-cols-12 gap-4">

        {/* Header */}
        <header className={`col-span-1 md:col-span-12 flex flex-col items-stretch justify-between gap-3 rounded-2xl border ${modeSurface.panel} px-5 py-3 md:flex-row md:items-center`}>
          <div className="flex items-center gap-2.5">
            <img alt="Crossfadio 应用图标" className="h-7 w-7 rounded-lg" src={appMark} />
            <span className="text-lg font-semibold tracking-tight text-violet-200">Crossfadio</span>
          </div>
          {weatherContext ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-sky-500/15 bg-sky-950/20 px-3 py-2 text-xs text-zinc-300 md:max-w-[520px]">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                <span className="truncate text-zinc-400">{weatherContext.location}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-sky-100">
                <CloudSun className="h-3.5 w-3.5 shrink-0 text-amber-200" />
                <span>{weatherContext.tempC}°C</span>
                <span className="text-zinc-400">{weatherContext.desc}</span>
              </span>
              {geolocationIssue ? (
                <span
                  aria-label="天气定位提示"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-amber-200"
                  title={geolocationIssue}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="hidden md:inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('plan')}
              type="button"
            >
              <CalendarDays className="h-4 w-4" />
              今日计划
            </button>
            <button
              className="hidden md:inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('settings')}
              type="button"
            >
              <Settings2 className="h-4 w-4" />
              设置
            </button>
            <div className="relative" ref={ncmDropdownRef}>
              <button
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900"
                onClick={() => {
                  if (isDesktop) setShowNcmDropdown((v) => !v);
                  else setShowNcmSheet(true);
                }}
                type="button"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${session.hasCookie ? 'bg-green-400' : 'bg-red-400'}`}
                />
                {session.hasCookie ? '已登录' : '未登录'}
              </button>
              {isDesktop && showNcmDropdown ? (
                <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-56 rounded-xl border border-zinc-700 bg-zinc-950/95 p-3 shadow-xl">
                  <div className="flex flex-col gap-1.5 text-xs text-zinc-300">
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        try {
                          const qr = await createNcmQr();
                          setQrPayload({ key: qr.key, qrimg: qr.qrimg });
                          setError('');
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '创建二维码失败');
                        }
                      }}
                      type="button"
                    >
                      <QrCode className="h-4 w-4 shrink-0" />
                      二维码登录
                    </button>
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        if (!qrPayload?.key) return;
                        try {
                          const status = await checkNcmQr(qrPayload.key);
                          if (status.hint === 'forbidden') {
                            setError(status.message || '您没有访问权限，请联系管理员');
                            setTrackStatusText('登录失败：无访问权限');
                            setQrPayload(null);
                          } else if (status.hint === 'expired') {
                            setTrackStatusText('二维码已过期，请刷新');
                            setQrPayload(null);
                          } else {
                            setTrackStatusText(`扫码状态: ${status.hint}`);
                          }
                          if (status.token) {
                            setSseToken(status.token);
                          }
                          await refreshSession();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '扫码状态查询失败');
                        }
                      }}
                      type="button"
                    >
                      <ScanSearch className="h-4 w-4 shrink-0" />
                      检查状态
                    </button>
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        try {
                          await logoutNcm();
                          setSseToken(null);
                          await refreshSession();
                          setTrackStatusText('已登出 NCM');
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '登出失败');
                        }
                      }}
                      type="button"
                    >
                      <LogOut className="h-4 w-4 shrink-0" />
                      登出
                    </button>
                    {qrPayload ? (
                      <img
                        alt="ncm login qr"
                        className="mt-2 h-28 w-28 rounded border border-zinc-700 bg-white p-1"
                        src={qrPayload.qrimg}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
              {showNcmSheet ? (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                  onClick={() => setShowNcmSheet(false)}
                >
                  <div
                    className="w-[320px] max-w-[90vw] rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sm font-medium text-zinc-200">网易云登录</span>
                      <button
                        className="rounded-lg p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
                        onClick={() => setShowNcmSheet(false)}
                        type="button"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                    <div className="flex flex-col gap-2 text-sm">
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2.5 hover:border-zinc-400 transition"
                        onClick={async () => {
                          try {
                            const qr = await createNcmQr();
                            setQrPayload({ key: qr.key, qrimg: qr.qrimg });
                            setError('');
                          } catch (err) {
                            setError(err instanceof Error ? err.message : '创建二维码失败');
                          }
                        }}
                        type="button"
                      >
                        <QrCode className="h-4 w-4" />
                        二维码登录
                      </button>
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2.5 hover:border-zinc-400 transition"
                        onClick={async () => {
                          if (!qrPayload?.key) return;
                          try {
                            const status = await checkNcmQr(qrPayload.key);
                            if (status.hint === 'forbidden') {
                              setError(status.message || '您没有访问权限，请联系管理员');
                              setTrackStatusText('登录失败：无访问权限');
                              setQrPayload(null);
                            } else if (status.hint === 'expired') {
                              setTrackStatusText('二维码已过期，请刷新');
                              setQrPayload(null);
                            } else {
                              setTrackStatusText(`扫码状态: ${status.hint}`);
                            }
                            if (status.token) {
                              setSseToken(status.token);
                            }
                            await refreshSession();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : '扫码状态查询失败');
                          }
                        }}
                        type="button"
                      >
                        <ScanSearch className="h-4 w-4" />
                        检查状态
                      </button>
                      <button
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2.5 hover:border-zinc-400 transition"
                        onClick={async () => {
                          try {
                            await logoutNcm();
                            setSseToken(null);
                            await refreshSession();
                            setTrackStatusText('已登出 NCM');
                          } catch (err) {
                            setError(err instanceof Error ? err.message : '登出失败');
                          }
                        }}
                        type="button"
                      >
                        <LogOut className="h-4 w-4" />
                        登出
                      </button>
                      {qrPayload ? (
                        <img
                          alt="ncm login qr"
                          className="mt-2 w-56 h-56 self-center rounded-lg border border-zinc-600 bg-white p-1.5"
                          src={qrPayload.qrimg}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <section className={`col-span-1 md:col-span-12 rounded-2xl border ${modeSurface.rail} px-4 py-3`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className={`text-xs uppercase tracking-[0.18em] ${modeSurface.accent}`}>DJ 选歌模式</p>
              <p className="mt-1 text-sm text-zinc-400">{modeSurface.caption}</p>
            </div>
            <div className="inline-grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
              <button
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                  discoveryMode === 'explore' ? modeSurface.active : modeSurface.inactive
                }`}
                onClick={() => void handleDiscoveryModeChange('explore')}
                type="button"
              >
                <Compass className="h-4 w-4" />
                探索
              </button>
              <button
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                  discoveryMode === 'comfort' ? modeSurface.active : modeSurface.inactive
                }`}
                onClick={() => void handleDiscoveryModeChange('comfort')}
                type="button"
              >
                <Home className="h-4 w-4" />
                舒适区
              </button>
            </div>
          </div>
        </section>

        {/* Left column — player */}
        <section className="col-span-1 md:col-span-7 space-y-4">
          <NowPlayingHero
            coverImgUrl={currentTrack?.coverImgUrl ?? nowPlaying?.coverImgUrl ?? null}
            isLiked={isLiked}
            lyric={nowPlaying?.lyric ?? ''}
            onToggleLike={handleToggleLike}
            positionSec={positionSec}
            subtitle={currentTrack?.artists.join(' / ') ?? ''}
            title={currentTrack?.name ?? 'No Track'}
          />

          <PlaybackTimeline
            currentTrackId={currentTrackId}
            currentTrackName={currentTrack?.name}
            durationSec={durationSec}
            nextTrackId={nextTrack?.track.id ?? null}
            nextTrackName={nextTrack?.track.name}
            onSeek={handleSeek}
            positionSec={positionSec}
            timing={nowPlaying?.timing ?? null}
          />

          <TransportControls
            canPrev={canPrev}
            canSkip={canSkip}
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onPrev={handlePrev}
            onSkip={handleSkip}
          />

          {/* Daily Theme Banner */}
          {sseToken && (
            <div className={`rounded-xl border px-4 py-3 ${modeSurface.soft}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="text-xs font-medium uppercase tracking-wider">今日主题</span>
                </div>
                <button
                  aria-checked={dailyThemeEnabled}
                  aria-label="启用每日主题推荐"
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                    dailyThemeEnabled ? (discoveryMode === 'explore' ? 'bg-emerald-400' : 'bg-amber-300') : 'bg-zinc-700'
                  }`}
                  onClick={() => void handleDailyThemeToggle()}
                  role="switch"
                  type="button"
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      dailyThemeEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
              <p className="text-sm opacity-85">
                {dailyThemeEnabled
                  ? dailyTheme?.theme ?? '正在准备今日主题'
                  : '主题推荐已关闭，DJ 选曲和转场不会参考每日主题'}
              </p>
              {dailyThemeEnabled && dailyTheme && dailyTheme.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {dailyTheme.keywords.map((kw) => (
                    <span key={kw} className="rounded-full bg-black/20 px-2 py-0.5 text-xs opacity-80">
                      {kw}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* User Taste — collapsible */}
          {userTaste && (
             <div className={`rounded-xl border ${modeSurface.panel}`}>
              <button
                className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-zinc-800/30 transition rounded-xl"
                onClick={() => setTasteExpanded((v) => !v)}
                type="button"
              >
                <div className="flex items-center gap-2">
                  <Palette className={`h-3.5 w-3.5 ${modeSurface.accent}`} />
                  <span className={`text-xs font-medium uppercase tracking-wider ${modeSurface.accent}`}>我的品味</span>
                </div>
                {tasteExpanded ? (
                  <ChevronUp className="h-4 w-4 text-zinc-600" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-zinc-600" />
                )}
              </button>
              {tasteExpanded && (
                <div className="px-4 pb-3 pt-0">
                  <pre className="whitespace-pre-wrap text-xs text-zinc-400 leading-relaxed">{userTaste}</pre>
                </div>
              )}
            </div>
          )}


          <audio
            onEnded={onEnded}
            onError={onTrackMediaError}
            onLoadedMetadata={onLoadedMetadata}
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onTimeUpdate={onTimeUpdate}
            ref={audioRef}
          />
        </section>

        {/* Right column — queue + status */}
        <section className="col-span-1 md:col-span-5 flex flex-col gap-4">
          <QueuePanel
            currentIndex={currentIndex}
            nextId={nextTrack?.track.id ?? null}
            onDeleteIndex={handleDeleteTrack}
            onSelectIndex={handleSelectIndex}
            queue={queue}
          />

          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-3">
            {statusExpanded ? (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <StatusChip label="曲目" text={trackStatusText || '—'} />
                  <StatusChip color="cyan" label="DJ选歌" text={djStatusText || '空闲'} />
                  {djPickLog ? (
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-cyan-300/70 hover:text-cyan-200 transition"
                      onClick={() => setDjPickLogExpanded((v) => !v)}
                      type="button"
                    >
                      <span>{djPickLogExpanded ? '收起' : '日志'}</span>
                      <svg
                        className={`w-3 h-3 transition-transform ${djPickLogExpanded ? 'rotate-180' : ''}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  ) : null}
                  <StatusChip color="violet" label="过渡文案" text={segueStatusText || '空闲'} />
                  {segueScriptText ? (
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-violet-300/70 hover:text-violet-200 transition"
                      onClick={() => setSegueScriptExpanded((v) => !v)}
                      type="button"
                    >
                      <span>{segueScriptExpanded ? '收起' : '展开'}</span>
                      <svg
                        className={`w-3 h-3 transition-transform ${segueScriptExpanded ? 'rotate-180' : ''}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  ) : null}
                  {error ? <span className="text-xs text-red-300">{error}</span> : null}
                  {!isDesktop ? (
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
                      onClick={() => setStatusExpanded(false)}
                      type="button"
                    >
                      收起
                    </button>
                  ) : null}
                </div>
                {segueScriptText && segueScriptExpanded ? (
                  <div className="mt-2 rounded-lg border border-violet-800/40 bg-violet-950/20 px-3 py-2">
                    <p className="text-xs text-violet-200/80 leading-relaxed whitespace-pre-wrap">{segueScriptText}</p>
                  </div>
                ) : null}
                {djPickLog && djPickLogExpanded ? (
                  <div className="mt-2 rounded-lg border border-cyan-800/40 bg-cyan-950/10 px-3 py-2 space-y-2">
                    {djPickLog.selectedSay ? (
                      <p className="text-xs text-cyan-200/80 leading-relaxed">{djPickLog.selectedSay}</p>
                    ) : null}
                    {djPickLog.searchQueries.length > 0 ? (
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[10px] text-zinc-500 shrink-0">搜索词</span>
                        <span className="text-xs text-zinc-300">
                          {djPickLog.searchQueries.map((q, i) => (
                            <span key={q}>
                              {i > 0 ? '、' : ''}
                              <span className="text-cyan-300/80">{q}</span>
                            </span>
                          ))}
                        </span>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[10px] text-zinc-500">
                        红心采样 <span className="text-zinc-300">{djPickLog.likedSample.length}</span> 首
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        搜索命中 <span className="text-zinc-300">{djPickLog.searchedTracks.length}</span> 首
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        候选池 <span className="text-cyan-300">{djPickLog.totalCandidates}</span> 首
                      </span>
                    </div>
                    {djPickLog.searchedTracks.length > 0 ? (
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-zinc-500">搜索命中曲目</span>
                        <div className="text-[10px] text-zinc-400 leading-relaxed">
                          {djPickLog.searchedTracks.slice(0, 8).map((t) => (
                            <span key={t.id} className="mr-3 inline-block">
                              {t.name} <span className="text-zinc-600">— {t.artist}</span>
                            </span>
                          ))}
                          {djPickLog.searchedTracks.length > 8 ? (
                            <span className="text-zinc-600">… +{djPickLog.searchedTracks.length - 8}</span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {djPickLog.likedSample.length > 0 ? (
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-zinc-500">红心采样</span>
                        <div className="text-[10px] text-zinc-500 leading-relaxed">
                          {djPickLog.likedSample.slice(0, 6).map((t) => (
                            <span key={t.id} className="mr-2 inline-block">
                              {t.name}
                            </span>
                          ))}
                          {djPickLog.likedSample.length > 6 ? (
                            <span className="text-zinc-600">… +{djPickLog.likedSample.length - 6}</span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                  onClick={() => void loadLikedQueue()}
                  type="button"
                >
                  重新开始 DJ 模式
                </button>
              </>
            ) : (
              <button
                className="w-full flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition"
                onClick={() => setStatusExpanded(true)}
                type="button"
              >
                <span className="text-zinc-500">DJ：</span>
                <span className="text-cyan-300">{djStatusText || '空闲'}</span>
                <span className="text-zinc-600">　</span>
                <span className="text-zinc-500">过渡：</span>
                <span className="text-violet-200">{segueStatusText || '空闲'}</span>
                <span className="ml-auto text-zinc-600">展开</span>
              </button>
            )}
          </div>
        </section>

      </div>
    </main>
  );
}

function StatusChip({
  label,
  text,
  color = 'zinc'
}: {
  label: string;
  text: string;
  color?: 'zinc' | 'cyan' | 'violet';
}): JSX.Element {
  const textColor =
    color === 'cyan'
      ? 'text-cyan-300'
      : color === 'violet'
        ? 'text-violet-200'
        : 'text-zinc-200';
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-zinc-500">{label}：</span>
      <span className={textColor}>{text}</span>
    </span>
  );
}
