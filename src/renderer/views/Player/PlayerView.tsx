import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  Clock,
  CloudSun,
  Compass,
  Home,
  LogOut,
  MapPin,
  MoreVertical,
  Music2,
  Palette,
  QrCode,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Volume2,
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
type ModeVisualConfig = {
  page: string;
  shell: string;
  panel: string;
  soft: string;
  accent: string;
  active: string;
  inactive: string;
  wave: string;
  title: string;
  caption: string;
  taste: string;
};

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
  const modeConfig = discoveryMode === 'explore'
    ? {
        page: 'bg-[radial-gradient(circle_at_14%_0%,rgba(20,184,166,0.22)_0%,transparent_30%),radial-gradient(circle_at_84%_18%,rgba(14,165,233,0.16)_0%,transparent_28%),linear-gradient(135deg,#031111_0%,#061019_48%,#020405_100%)]',
        shell: 'border-cyan-200/20 bg-black/45 shadow-[0_0_42px_rgba(34,211,238,0.10)]',
        panel: 'border-cyan-200/15 bg-slate-950/48',
        soft: 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100',
        accent: 'text-cyan-200',
        active: 'border-cyan-300/80 bg-cyan-400/18 text-cyan-50 shadow-[0_0_24px_rgba(45,212,191,0.28)]',
        inactive: 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-cyan-300/40 hover:text-cyan-100',
        wave: 'bg-cyan-300',
        title: '探索模式',
        caption: '一起探索更多未知的好歌',
        taste: '开放探索 · 风格扩展'
      }
    : {
        page: 'bg-[radial-gradient(circle_at_15%_0%,rgba(251,146,60,0.18)_0%,transparent_31%),radial-gradient(circle_at_78%_13%,rgba(244,63,94,0.13)_0%,transparent_29%),linear-gradient(135deg,#130d09_0%,#100f10_48%,#050505_100%)]',
        shell: 'border-orange-200/20 bg-black/44 shadow-[0_0_42px_rgba(251,146,60,0.10)]',
        panel: 'border-orange-200/14 bg-zinc-950/52',
        soft: 'border-rose-300/20 bg-rose-400/10 text-rose-100',
        accent: 'text-orange-200',
        active: 'border-orange-300/75 bg-orange-400/16 text-orange-50 shadow-[0_0_24px_rgba(251,146,60,0.24)]',
        inactive: 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-orange-300/40 hover:text-orange-100',
        wave: 'bg-rose-300',
        title: '舒适区模式',
        caption: '回到你喜欢的风格和熟悉的旋律',
        taste: '融合品味 · 高匹配'
      };
  const modeInfoCards = [
    {
      icon: <ShieldCheck className="h-4 w-4" />,
      label: '今日主题',
      value: dailyThemeEnabled ? dailyTheme?.theme ?? '春日里的生命守护' : '主题推荐已关闭'
    },
    {
      icon: <CloudSun className="h-4 w-4" />,
      label: '天气',
      value: weatherContext ? `${weatherContext.tempC}°C ${weatherContext.desc}` : '等待天气'
    },
    {
      icon: <Clock className="h-4 w-4" />,
      label: '时间',
      value: new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date())
    },
    {
      icon: <Sparkles className="h-4 w-4" />,
      label: 'DJ 偏好',
      value: modeConfig.taste
    }
  ];

  return (
    <main className={`${modeConfig.page} min-h-screen p-2 text-zinc-100 transition-colors duration-500 md:p-4`}>
      <div className={`mx-auto grid max-w-[1500px] grid-cols-1 gap-4 rounded-[18px] border p-3 backdrop-blur-xl md:grid-cols-12 md:p-5 ${modeConfig.shell}`}>

        {/* Header */}
        <header className={`col-span-1 flex flex-col items-stretch justify-between gap-3 rounded-xl border px-4 py-3 md:col-span-12 md:flex-row md:items-center ${modeConfig.panel}`}>
          <div className="flex items-center gap-2.5">
            <img alt="Crossfadio 应用图标" className="h-7 w-7 rounded-lg" src={appMark} />
            <span className="text-lg font-semibold tracking-tight text-zinc-50">Crossfadio</span>
          </div>
          {weatherContext ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-xs text-zinc-300 md:max-w-[520px]">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <MapPin className={`h-3.5 w-3.5 shrink-0 ${modeConfig.accent}`} />
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
              className="hidden items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/5 hover:text-zinc-100 md:inline-flex"
              onClick={() => onNavigate?.('plan')}
              type="button"
            >
              <CalendarDays className="h-4 w-4" />
              今日计划
            </button>
            <button
              className="hidden items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/5 hover:text-zinc-100 md:inline-flex"
              onClick={() => onNavigate?.('settings')}
              type="button"
            >
              <Settings2 className="h-4 w-4" />
              设置
            </button>
            <div className="relative" ref={ncmDropdownRef}>
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-300 transition hover:border-white/20 hover:bg-white/5"
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

        <section className="col-span-1 overflow-hidden rounded-xl px-2 py-4 md:col-span-12 md:px-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0">
              <h1 className={`text-2xl font-bold tracking-normal md:text-3xl ${modeConfig.accent}`}>
                {modeConfig.title}
              </h1>
              <p className="mt-2 text-sm text-zinc-400">{modeConfig.caption}</p>
            </div>
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="inline-grid w-full grid-cols-2 gap-1 rounded-xl border border-white/10 bg-black/25 p-1 md:w-[300px]">
                <button
                  className={`inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                    discoveryMode === 'explore' ? modeConfig.active : modeConfig.inactive
                  }`}
                  onClick={() => void handleDiscoveryModeChange('explore')}
                  type="button"
                >
                  <Compass className="h-4 w-4" />
                  探索
                </button>
                <button
                  className={`inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                    discoveryMode === 'comfort' ? modeConfig.active : modeConfig.inactive
                  }`}
                  onClick={() => void handleDiscoveryModeChange('comfort')}
                  type="button"
                >
                  <Home className="h-4 w-4" />
                  舒适区
                </button>
              </div>
              <SignalBars colorClass={modeConfig.wave} />
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {modeInfoCards.map((card) => (
              <ModeInfoCard
                icon={card.icon}
                key={card.label}
                label={card.label}
                modeConfig={modeConfig}
                value={card.value}
              />
            ))}
          </div>
        </section>

        {/* Left column — player */}
        <section className={`col-span-1 space-y-4 md:col-span-12 ${discoveryMode === 'comfort' ? 'xl:col-span-8' : 'xl:col-span-12'}`}>
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

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {sseToken ? (
              <TodayThemePanel
                dailyTheme={dailyTheme}
                dailyThemeEnabled={dailyThemeEnabled}
                discoveryMode={discoveryMode}
                modeConfig={modeConfig}
                onToggle={() => void handleDailyThemeToggle()}
              />
            ) : null}
            {userTaste ? (
              <TastePanel
                expanded={tasteExpanded}
                modeConfig={modeConfig}
                onToggle={() => setTasteExpanded((v) => !v)}
                userTaste={userTaste}
              />
            ) : null}
          </div>

          <div className={discoveryMode === 'comfort' ? 'xl:hidden' : ''}>
            <DjStatusDock
              djPickLog={djPickLog}
              djPickLogExpanded={djPickLogExpanded}
              djStatusText={djStatusText}
              error={error}
              isDesktop={isDesktop}
              modeConfig={modeConfig}
              onRestart={() => void loadLikedQueue()}
              onToggleDjPickLog={() => setDjPickLogExpanded((v) => !v)}
              onToggleSegueScript={() => setSegueScriptExpanded((v) => !v)}
              segueScriptExpanded={segueScriptExpanded}
              segueScriptText={segueScriptText}
              segueStatusText={segueStatusText}
              setStatusExpanded={setStatusExpanded}
              statusExpanded={statusExpanded}
              trackStatusText={trackStatusText}
            />
          </div>


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
        <section className={`col-span-1 flex-col gap-4 md:col-span-12 xl:col-span-4 ${discoveryMode === 'comfort' ? 'flex' : 'hidden xl:hidden'}`}>
          <QueuePanel
            currentIndex={currentIndex}
            nextId={nextTrack?.track.id ?? null}
            onDeleteIndex={handleDeleteTrack}
            onSelectIndex={handleSelectIndex}
            queue={queue}
          />

          <DjStatusDock
            djPickLog={djPickLog}
            djPickLogExpanded={djPickLogExpanded}
            djStatusText={djStatusText}
            error={error}
            isDesktop={isDesktop}
            modeConfig={modeConfig}
            onRestart={() => void loadLikedQueue()}
            onToggleDjPickLog={() => setDjPickLogExpanded((v) => !v)}
            onToggleSegueScript={() => setSegueScriptExpanded((v) => !v)}
            segueScriptExpanded={segueScriptExpanded}
            segueScriptText={segueScriptText}
            segueStatusText={segueStatusText}
            setStatusExpanded={setStatusExpanded}
            statusExpanded={statusExpanded}
            trackStatusText={trackStatusText}
          />
        </section>

      </div>
    </main>
  );
}

function SignalBars({ colorClass }: { colorClass: string }): JSX.Element {
  return (
    <div className="hidden h-9 items-center gap-1 px-2 md:flex" aria-hidden="true">
      {[10, 18, 26, 16, 30, 20, 12].map((height, index) => (
        <span
          className={`w-0.5 rounded-full ${colorClass}`}
          key={`${height}-${index}`}
          style={{ height }}
        />
      ))}
    </div>
  );
}

function ModeInfoCard({
  icon,
  label,
  modeConfig,
  value
}: {
  icon: JSX.Element;
  label: string;
  modeConfig: ModeVisualConfig;
  value: string;
}): JSX.Element {
  return (
    <div className={`min-w-0 rounded-lg border px-4 py-3 ${modeConfig.soft}`}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className={modeConfig.accent}>{icon}</span>
        <span className="text-zinc-400">{label}</span>
      </div>
      <p className="mt-1 truncate text-sm font-medium text-zinc-100">{value}</p>
    </div>
  );
}

function TodayThemePanel({
  dailyTheme,
  dailyThemeEnabled,
  discoveryMode,
  modeConfig,
  onToggle
}: {
  dailyTheme: { theme: string; keywords: string[] } | null;
  dailyThemeEnabled: boolean;
  discoveryMode: DiscoveryMode;
  modeConfig: ModeVisualConfig;
  onToggle: () => void;
}): JSX.Element {
  return (
    <section className={`relative min-h-[178px] overflow-hidden rounded-xl border p-5 ${modeConfig.soft}`}>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_55%_48%,rgba(255,255,255,0.12),transparent_35%),radial-gradient(circle_at_72%_62%,rgba(255,255,255,0.08),transparent_30%)]" />
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          <span className="text-sm font-semibold">今日主题</span>
        </div>
        <button
          aria-checked={dailyThemeEnabled}
          aria-label="启用每日主题推荐"
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
            dailyThemeEnabled
              ? discoveryMode === 'explore'
                ? 'bg-cyan-300'
                : 'bg-orange-300'
              : 'bg-zinc-700'
          }`}
          onClick={onToggle}
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
      <h2 className="relative mt-5 text-xl font-semibold leading-tight text-zinc-50">
        {dailyThemeEnabled ? dailyTheme?.theme ?? '正在准备今日主题' : '主题推荐已关闭'}
      </h2>
      <p className="relative mt-3 max-w-[28rem] text-sm leading-6 text-zinc-300/85">
        {dailyThemeEnabled
          ? '在春天，我们更懂得珍惜与守护。让音乐陪伴每一次呼吸。'
          : 'DJ 选曲和转场暂不参考每日主题。'}
      </p>
      {dailyThemeEnabled && dailyTheme && dailyTheme.keywords.length > 0 ? (
        <div className="relative mt-4 flex flex-wrap gap-2">
          {dailyTheme.keywords.map((kw) => (
            <span key={kw} className="rounded-md border border-white/10 bg-black/20 px-2.5 py-1 text-xs text-zinc-200">
              {kw}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TastePanel({
  expanded,
  modeConfig,
  onToggle,
  userTaste
}: {
  expanded: boolean;
  modeConfig: ModeVisualConfig;
  onToggle: () => void;
  userTaste: string;
}): JSX.Element {
  const tasteLines = userTaste
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const previewTags = tasteLines
    .flatMap((line) => line.split(/[，、,\/]/).map((item) => item.trim()))
    .filter(Boolean)
    .slice(0, 8);

  return (
    <section className={`min-h-[178px] rounded-xl border p-5 ${modeConfig.panel}`}>
      <button
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="flex items-center gap-2">
          <Palette className={`h-4 w-4 ${modeConfig.accent}`} />
          <span className={`text-sm font-semibold ${modeConfig.accent}`}>我的品味</span>
        </span>
        <span className="flex items-center gap-3 text-xs text-zinc-500">
          展开
          <MoreVertical className="h-4 w-4" />
        </span>
      </button>
      <p className="mt-3 text-xs text-zinc-500">偏好预览</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(previewTags.length > 0 ? previewTags : ['粤语为主', '治愈', '舒缓']).map((tag) => (
          <span key={tag} className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300">
            {tag}
          </span>
        ))}
      </div>
      {expanded ? (
        <pre className="mt-4 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-zinc-400">
          {userTaste}
        </pre>
      ) : null}
    </section>
  );
}

function DjStatusDock({
  djPickLog,
  djPickLogExpanded,
  djStatusText,
  error,
  isDesktop,
  modeConfig,
  onRestart,
  onToggleDjPickLog,
  onToggleSegueScript,
  segueScriptExpanded,
  segueScriptText,
  segueStatusText,
  setStatusExpanded,
  statusExpanded,
  trackStatusText
}: {
  djPickLog: DjPickLog | null;
  djPickLogExpanded: boolean;
  djStatusText: string;
  error: string;
  isDesktop: boolean;
  modeConfig: ModeVisualConfig;
  onRestart: () => void;
  onToggleDjPickLog: () => void;
  onToggleSegueScript: () => void;
  segueScriptExpanded: boolean;
  segueScriptText: string;
  segueStatusText: string;
  setStatusExpanded: (expanded: boolean) => void;
  statusExpanded: boolean;
  trackStatusText: string;
}): JSX.Element {
  return (
    <section className={`rounded-xl border p-3 ${modeConfig.panel}`}>
      {statusExpanded ? (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className={`inline-flex items-center gap-2 text-sm font-semibold ${modeConfig.accent}`}>
              <Activity className="h-4 w-4" />
              DJ 状态
            </span>
            <StatusChip label="曲目" text={trackStatusText || '—'} />
            <StatusChip color="cyan" label="DJ选歌" text={djStatusText || '空闲'} />
            {djPickLog ? (
              <button
                className="inline-flex items-center gap-1 text-xs text-cyan-300/80 transition hover:text-cyan-100"
                onClick={onToggleDjPickLog}
                type="button"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {djPickLogExpanded ? '收起' : '日志'}
              </button>
            ) : null}
            <StatusChip color="violet" label="过渡语音" text={segueStatusText || '空闲'} />
            {segueScriptText ? (
              <button
                className="inline-flex items-center gap-1 text-xs text-violet-300/80 transition hover:text-violet-100"
                onClick={onToggleSegueScript}
                type="button"
              >
                <Volume2 className="h-3.5 w-3.5" />
                {segueScriptExpanded ? '收起' : '展开'}
              </button>
            ) : null}
            {error ? <span className="text-xs text-red-300">{error}</span> : null}
            {!isDesktop ? (
              <button
                className="ml-auto text-xs text-zinc-500 transition hover:text-zinc-300"
                onClick={() => setStatusExpanded(false)}
                type="button"
              >
                收起
              </button>
            ) : null}
          </div>
          {segueScriptText && segueScriptExpanded ? (
            <div className="mt-3 rounded-lg border border-violet-300/15 bg-violet-950/20 px-3 py-2">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-violet-100/80">{segueScriptText}</p>
            </div>
          ) : null}
          {djPickLog && djPickLogExpanded ? (
            <div className="mt-3 space-y-2 rounded-lg border border-cyan-300/15 bg-cyan-950/10 px-3 py-2">
              {djPickLog.selectedSay ? (
                <p className="text-xs leading-relaxed text-cyan-100/80">{djPickLog.selectedSay}</p>
              ) : null}
              {djPickLog.searchQueries.length > 0 ? (
                <p className="text-xs text-zinc-400">
                  搜索词：<span className="text-cyan-200">{djPickLog.searchQueries.join('、')}</span>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
                <span>红心采样 <span className="text-zinc-300">{djPickLog.likedSample.length}</span> 首</span>
                <span>搜索命中 <span className="text-zinc-300">{djPickLog.searchedTracks.length}</span> 首</span>
                <span>候选池 <span className="text-cyan-300">{djPickLog.totalCandidates}</span> 首</span>
              </div>
            </div>
          ) : null}
          <button
            className={`mt-3 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition ${modeConfig.inactive}`}
            onClick={onRestart}
            type="button"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新生成
          </button>
        </>
      ) : (
        <button
          className="flex w-full items-center gap-2 text-xs text-zinc-400 transition hover:text-zinc-200"
          onClick={() => setStatusExpanded(true)}
          type="button"
        >
          <Music2 className={`h-4 w-4 ${modeConfig.accent}`} />
          <span>DJ：</span>
          <span className="text-cyan-300">{djStatusText || '空闲'}</span>
          <span className="text-zinc-600">/</span>
          <span>过渡：</span>
          <span className="text-violet-200">{segueStatusText || '空闲'}</span>
          <span className="ml-auto text-zinc-600">展开</span>
        </button>
      )}
    </section>
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
