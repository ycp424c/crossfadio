import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  LogOut,
  QrCode,
  Radio,
  ScanSearch,
  Settings2,
  Sparkles
} from 'lucide-react';
import {
  checkNcmQr,
  createNcmQr,
  getLikedQueue,
  getNcmSession,
  getNextTrack,
  getNowPlaying,
  logoutNcm,
  saveQueueState,
  triggerSegue
} from '@renderer/api';
import { getPrefetchDecision } from '@renderer/audio/prefetch';
import { NowPlayingHero } from '@renderer/components/player/NowPlayingHero';
import { PlaybackTimeline } from '@renderer/components/player/PlaybackTimeline';
import { QueuePanel } from '@renderer/components/player/QueuePanel';
import { SeekBar } from '@renderer/components/player/SeekBar';
import { TransportControls } from '@renderer/components/player/TransportControls';
import { onWsMessage } from '@renderer/ws/client';
import type { NextTrackResponse, NowPlayingResponse, QueueTrackDto } from '@shared/schema';
import appMark from '@renderer/assets/image2/crossfadio-mark.svg';
import playerDesignRef from '@renderer/assets/image2/2026-04-23-player-v1.png';

type NcmSessionState = {
  hasCookie: boolean;
  profile: unknown | null;
};

type PlayerViewProps = {
  onNavigate?: (tab: 'plan' | 'settings') => void;
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
  const [statusText, setStatusText] = useState('准备就绪');
  const [error, setError] = useState('');
  const [segueStatus, setSegueStatus] = useState<'idle' | 'generating' | 'ready' | 'degraded'>('idle');
  const [duckingHintSec, setDuckingHintSec] = useState(8);

  const [session, setSession] = useState<NcmSessionState>({ hasCookie: false, profile: null });
  const [qrPayload, setQrPayload] = useState<{ key: string; qrimg: string } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segueAudioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchTriggeredRef = useRef(false);
  const segueTriggeredRef = useRef(false);
  const applyingRemoteQueueRef = useRef(false);

  const queueIds = useMemo(() => queue.map((track) => track.id), [queue]);
  const currentTrack = queue[currentIndex] ?? null;
  const currentTrackId = currentTrack?.id ?? null;

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
    void loadLikedQueue();
  }, []);

  useEffect(() => {
    const unsub = onWsMessage((msg) => {
      if (msg.type === 'queue-updated') {
        const nextQueue: QueueTrackDto[] = Array.isArray(msg.queue)
          ? msg.queue
              .map((track) =>
                track && typeof track === 'object' && 'ncmId' in track
                  ? {
                      id: String((track as { ncmId: unknown }).ncmId),
                      name:
                        typeof (track as { name?: unknown }).name === 'string'
                          ? String((track as { name: unknown }).name)
                          : `Track ${(track as { ncmId: unknown }).ncmId}`,
                      artists: Array.isArray((track as { artists?: unknown }).artists)
                        ? (track as { artists: string[] }).artists
                        : [],
                      durationMs:
                        typeof (track as { durationMs?: unknown }).durationMs === 'number'
                          ? (track as { durationMs: number }).durationMs
                          : 0
                    }
                  : null
              )
              .filter((track): track is QueueTrackDto => track !== null)
          : [];
        const nextIndex = typeof msg.currentIndex === 'number' ? msg.currentIndex : 0;
        applyingRemoteQueueRef.current = true;
        setQueue(nextQueue);
        setCurrentIndex(nextIndex);
      } else if (msg.type === 'segue.delta') {
        const say = String(msg.say ?? '').trim();
        if (say) setStatusText(`DJ: ${say}`);
      } else if (msg.type === 'segue.tts-ready') {
        setSegueStatus('ready');
        const maybeDuckingHintSec =
          msg.segue && typeof msg.segue === 'object' && 'duckingHintSec' in msg.segue
            ? Number((msg.segue as { duckingHintSec: unknown }).duckingHintSec)
            : NaN;
        if (Number.isFinite(maybeDuckingHintSec) && maybeDuckingHintSec > 0) {
          setDuckingHintSec(maybeDuckingHintSec);
        }
        const audioUrl = typeof msg.audioUrl === 'string' ? msg.audioUrl : null;
        if (audioUrl) {
          segueAudioRef.current?.pause();
          const audio = new Audio(audioUrl);
          audio.volume = 0.75;
          segueAudioRef.current = audio;
          void audio.play().catch(() => {
            setStatusText('DJ 过渡语音已生成，等待用户交互后播放');
          });
        } else {
          setStatusText('DJ 过渡语音已生成（未配置 TTS）');
        }
      } else if (msg.type === 'segue.degraded') {
        setSegueStatus('degraded');
        setStatusText('DJ 过渡语音暂不可用');
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (applyingRemoteQueueRef.current) {
      applyingRemoteQueueRef.current = false;
      return;
    }
    void saveQueueState(queue, currentIndex).catch(() => {
      // Queue sync is best effort; playback should keep running locally.
    });
  }, [currentIndex, queue]);

  useEffect(() => {
    if (!currentTrackId) {
      setNowPlaying(null);
      return;
    }

    prefetchTriggeredRef.current = false;
    segueTriggeredRef.current = false;
    setSegueStatus('idle');
    setDuckingHintSec(8);
    setStatusText(`正在加载曲目 ${currentTrackId} ...`);

    void loadNowPlaying(currentTrackId);
    void refreshNextTrack(currentTrackId);
  }, [currentTrackId]);

  async function refreshSession(): Promise<void> {
    try {
      const payload = await getNcmSession();
      setSession({ hasCookie: payload.hasCookie, profile: payload.profile });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'session 请求失败');
    }
  }

  async function loadLikedQueue(): Promise<void> {
    try {
      const payload = await getLikedQueue(100);
      applyingRemoteQueueRef.current = true;
      setQueue(payload.tracks);
      setCurrentIndex(payload.currentIndex);
      setStatusText(`已加载红心歌单 ${payload.tracks.length} 首`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '红心歌单加载失败');
    }
  }

  async function loadNowPlaying(trackId: string): Promise<void> {
    try {
      const payload = await getNowPlaying(trackId);
      setNowPlaying(payload);
      setError('');

      if (audioRef.current) {
        audioRef.current.src = payload.url;
        audioRef.current.load();
      }

      setStatusText(`已加载 ${trackId}`);
    } catch (err) {
      setNowPlaying(null);
      setStatusText('加载失败');
      setError(err instanceof Error ? err.message : 'now 请求失败');
    }
  }

  async function refreshNextTrack(trackId: string): Promise<void> {
    if (queueIds.length === 0) {
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

  function handlePlayPause(): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
      return;
    }

    audio.pause();
  }

  function handlePrev(): void {
    setCurrentIndex((index) => Math.max(0, index - 1));
  }

  function handleSkip(): void {
    if (!queueIds.length) {
      return;
    }
    setCurrentIndex((index) => Math.min(queueIds.length - 1, index + 1));
  }

  function handleToggleLike(): void {
    if (!currentTrackId) {
      return;
    }

    setLikedTrackIds((ids) =>
      ids.includes(currentTrackId) ? ids.filter((id) => id !== currentTrackId) : [...ids, currentTrackId]
    );
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

    const decision = getPrefetchDecision(audio.currentTime, audio.duration || 0, {
      prefetchLeadSec: nowPlaying.timing.prefetchLeadSec,
      crossfadeSec: nowPlaying.timing.crossfadeSec,
      segueLeadSec: nowPlaying.timing.segueLeadSec
    });

    if (!prefetchTriggeredRef.current && decision.shouldPrefetchNext && currentTrackId) {
      prefetchTriggeredRef.current = true;
      setStatusText(`预取触发：d-${nowPlaying.timing.prefetchLeadSec}s`);
      void refreshNextTrack(currentTrackId);
    }

    const nextTrackId = nextTrack?.track.id ?? null;
    if (!segueTriggeredRef.current && decision.shouldTriggerSegue && currentTrackId && nextTrackId) {
      segueTriggeredRef.current = true;
      setSegueStatus('generating');
      setStatusText(`DJ 过渡语音生成中：${currentTrackId} → ${nextTrackId}`);
      void triggerSegue(currentTrackId, nextTrackId).catch((err) => {
        setError(err instanceof Error ? err.message : 'segue 请求失败');
      });
    }
  }

  function onLoadedMetadata(): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setDurationSec(audio.duration || 0);
  }

  function onEnded(): void {
    if (currentIndex < queueIds.length - 1) {
      setCurrentIndex((index) => index + 1);
      return;
    }
    setIsPlaying(false);
    setStatusText('播放完成');
  }

  const canPrev = currentIndex > 0;
  const canSkip = currentIndex < queueIds.length - 1;
  const isLiked = currentTrackId ? likedTrackIds.includes(currentTrackId) : false;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#1f2b5e_0%,#080b14_35%,#070a12_100%)] p-6 text-zinc-100">
      <div className="mx-auto grid max-w-[1480px] grid-cols-12 gap-4">
        <aside className="col-span-2 rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-violet-200">
            <img alt="Crossfadio 应用图标" className="h-7 w-7 rounded-lg" src={appMark} />
            Crossfadio
          </h1>
          <p className="mt-0.5 text-xs text-zinc-400">M1-07 Player MVP</p>
          <nav className="mt-6 space-y-2 text-sm">
            <div className="inline-flex w-full items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-500/15 px-3 py-2 text-violet-100">
              <Radio className="h-4 w-4" />
              正在播放
            </div>
            <button
              className="inline-flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('plan')}
              type="button"
            >
              <CalendarDays className="h-4 w-4" />
              今日计划
            </button>
            <button
              className="inline-flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('settings')}
              type="button"
            >
              <Settings2 className="h-4 w-4" />
              设置
            </button>
          </nav>

          <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
            <p className="font-medium text-zinc-100">NCM 登录状态</p>
            <p className="mt-1">{session.hasCookie ? '已登录' : '未登录'}</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <button
                className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs hover:border-zinc-500"
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
                className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs hover:border-zinc-500"
                onClick={async () => {
                  if (!qrPayload?.key) {
                    return;
                  }
                  try {
                    const status = await checkNcmQr(qrPayload.key);
                    setStatusText(`扫码状态: ${status.hint}`);
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
                className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs hover:border-zinc-500"
                onClick={async () => {
                  try {
                    await logoutNcm();
                    await refreshSession();
                    setStatusText('已登出 NCM');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : '登出失败');
                  }
                }}
                type="button"
              >
                <LogOut className="h-4 w-4 shrink-0" />
                登出
              </button>
            </div>
            {qrPayload ? (
              <img
                alt="ncm login qr"
                className="mt-3 h-28 w-28 rounded border border-zinc-700 bg-white p-1"
                src={qrPayload.qrimg}
              />
            ) : null}
          </section>
        </aside>

        <section className="col-span-7 space-y-4">
          <header className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-3xl font-semibold">正在播放</h2>
                <p className="text-sm text-zinc-400">红心歌单动态队列 · 支持进度拖动</p>
              </div>
              <div className="text-right text-xs text-zinc-400">
                <p>{statusText}</p>
                {error ? <p className="mt-1 text-red-300">{error}</p> : null}
              </div>
            </div>
            <button
              className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 transition hover:border-zinc-500"
              onClick={() => void loadLikedQueue()}
              type="button"
            >
              重新读取网易红心歌单
            </button>
          </header>

          <NowPlayingHero
            isLiked={isLiked}
            lyric={nowPlaying?.lyric ?? ''}
            onToggleLike={handleToggleLike}
            positionSec={positionSec}
            subtitle={nowPlaying ? `直链已就绪 · ${nowPlaying.timing.crossfadeSec}s crossfade` : '等待加载'}
            title={currentTrack?.name ?? 'No Track'}
            trackId={currentTrackId ?? '-'}
          />

          <SeekBar durationSec={durationSec} onSeek={handleSeek} positionSec={positionSec} />

          <TransportControls
            canPrev={canPrev}
            canSkip={canSkip}
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onPrev={handlePrev}
            onSkip={handleSkip}
          />

          <PlaybackTimeline
            currentTrackId={currentTrackId}
            duckingHintSec={duckingHintSec}
            durationSec={durationSec}
            nextTrackId={nextTrack?.track.id ?? null}
            positionSec={positionSec}
            segueStatus={segueStatus}
            timing={nowPlaying?.timing ?? null}
          />

          <audio
            onEnded={onEnded}
            onLoadedMetadata={onLoadedMetadata}
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onTimeUpdate={onTimeUpdate}
            ref={audioRef}
          />
        </section>

        <section className="col-span-3 space-y-4">
          <QueuePanel
            currentIndex={currentIndex}
            nextId={nextTrack?.track.id ?? null}
            onSelectIndex={setCurrentIndex}
            queue={queue}
          />
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 text-sm text-zinc-300">
            <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
              <Sparkles className="h-5 w-5 text-violet-300" />
              Image2 视觉稿
            </h3>
            <p className="mt-2 text-xs text-zinc-400">当前实现对齐 2026-04-23-player-v1 设计方向。</p>
            <img alt="Image2 Player 视觉稿" className="mt-3 rounded-xl border border-zinc-800" src={playerDesignRef} />
          </section>
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 text-sm text-zinc-300">
            <h3 className="text-lg font-semibold text-zinc-100">预取状态</h3>
            <p className="mt-2">下一首: {nextTrack?.track.id ?? '未就绪'}</p>
            <p className="mt-1">prefetch: {nowPlaying?.timing.prefetchLeadSec ?? '-'}s</p>
            <p className="mt-1">segue: {nowPlaying?.timing.segueLeadSec ?? '-'}s</p>
            <p className="mt-1">crossfade: {nowPlaying?.timing.crossfadeSec ?? '-'}s</p>
          </section>
        </section>
      </div>
    </main>
  );
}
