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
  getNcmSession,
  getNextTrack,
  getNowPlaying,
  logoutNcm
} from '@renderer/api';
import { getPrefetchDecision } from '@renderer/audio/prefetch';
import { NowPlayingHero } from '@renderer/components/player/NowPlayingHero';
import { QueuePanel } from '@renderer/components/player/QueuePanel';
import { TransportControls } from '@renderer/components/player/TransportControls';
import type { NextTrackResponse, NowPlayingResponse } from '@shared/schema';
import appMark from '@renderer/assets/image2/crossfadio-mark.svg';
import playerDesignRef from '@renderer/assets/image2/2026-04-23-player-v1.png';

const DEFAULT_QUEUE = '347230, 447925558, 186016';

type NcmSessionState = {
  hasCookie: boolean;
  profile: unknown | null;
};

export function PlayerView(): JSX.Element {
  const [queueInput, setQueueInput] = useState(DEFAULT_QUEUE);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingResponse | null>(null);
  const [nextTrack, setNextTrack] = useState<NextTrackResponse | null>(null);
  const [likedTrackIds, setLikedTrackIds] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [statusText, setStatusText] = useState('准备就绪');
  const [error, setError] = useState('');

  const [session, setSession] = useState<NcmSessionState>({ hasCookie: false, profile: null });
  const [qrPayload, setQrPayload] = useState<{ key: string; qrimg: string } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchTriggeredRef = useRef(false);

  const queueIds = useMemo(() => parseQueueInput(queueInput), [queueInput]);
  const currentTrackId = queueIds[currentIndex] ?? null;

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
  }, []);

  useEffect(() => {
    if (!currentTrackId) {
      setNowPlaying(null);
      return;
    }

    prefetchTriggeredRef.current = false;
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

  function handleSeek(event: React.ChangeEvent<HTMLInputElement>): void {
    const nextSec = Number(event.target.value);
    setPositionSec(nextSec);
    if (audioRef.current) {
      audioRef.current.currentTime = nextSec;
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
          <h1 className="inline-flex items-center gap-2 text-3xl font-semibold tracking-tight text-violet-200">
            <img alt="Crossfadio 应用图标" className="h-8 w-8 rounded-lg" src={appMark} />
            Crossfadio
          </h1>
          <p className="mt-1 text-xs text-zinc-400">M1-07 Player MVP</p>
          <nav className="mt-6 space-y-2 text-sm">
            <div className="inline-flex w-full items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-500/15 px-3 py-2 text-violet-100">
              <Radio className="h-4 w-4" />
              正在播放
            </div>
            <div className="inline-flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-zinc-300">
              <CalendarDays className="h-4 w-4" />
              今日计划
            </div>
            <div className="inline-flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-zinc-300">
              <Settings2 className="h-4 w-4" />
              设置
            </div>
          </nav>

          <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
            <p className="font-medium text-zinc-100">NCM 登录状态</p>
            <p className="mt-1">{session.hasCookie ? '已登录' : '未登录'}</p>
            <div className="mt-3 flex gap-2">
              <button
                className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 hover:border-zinc-500"
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
                <QrCode className="h-3.5 w-3.5" />
                二维码
              </button>
              <button
                className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 hover:border-zinc-500"
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
                <ScanSearch className="h-3.5 w-3.5" />
                状态
              </button>
              <button
                className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 hover:border-zinc-500"
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
                <LogOut className="h-3.5 w-3.5" />
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
                <p className="text-sm text-zinc-400">支持 play / pause / skip / prev / like</p>
              </div>
              <div className="text-right text-xs text-zinc-400">
                <p>{statusText}</p>
                {error ? <p className="mt-1 text-red-300">{error}</p> : null}
              </div>
            </div>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-zinc-400">队列 NCM IDs（逗号分隔）</span>
              <input
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-400"
                onChange={(event) => setQueueInput(event.target.value)}
                value={queueInput}
              />
            </label>
          </header>

          <NowPlayingHero
            isLiked={isLiked}
            lyric={nowPlaying?.lyric ?? ''}
            onToggleLike={handleToggleLike}
            subtitle={nowPlaying ? `直链已就绪 · ${nowPlaying.timing.crossfadeSec}s crossfade` : '等待加载'}
            title={currentTrackId ? `Track ${currentTrackId}` : 'No Track'}
            trackId={currentTrackId ?? '-'}
          />

          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
            <div className="flex items-center justify-between text-sm text-zinc-300">
              <span>{formatClock(positionSec)}</span>
              <span>{formatClock(durationSec)}</span>
            </div>
            <input
              className="mt-2 h-2 w-full cursor-pointer accent-violet-400"
              max={durationSec || 0}
              min={0}
              onChange={handleSeek}
              step={0.01}
              type="range"
              value={Math.min(positionSec, durationSec || 0)}
            />
          </section>

          <TransportControls
            canPrev={canPrev}
            canSkip={canSkip}
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onPrev={handlePrev}
            onSkip={handleSkip}
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
            queueIds={queueIds}
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

function parseQueueInput(value: string): string[] {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return '00:00';
  }

  const rounded = Math.floor(totalSec);
  const minutes = Math.floor(rounded / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (rounded % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
