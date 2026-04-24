import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Filter, Volume2 } from 'lucide-react';
import { buildPlaybackTimeline } from '@renderer/audio/timeline';
import type { PlaybackTiming } from '@shared/schema';

type SegueStatus = 'idle' | 'generating' | 'ready' | 'degraded';

type PlaybackTimelineProps = {
  durationSec: number;
  positionSec: number;
  timing: PlaybackTiming | null;
  duckingHintSec?: number;
  currentTrackId: string | null;
  nextTrackId: string | null;
  segueScript?: string;
  segueStatus: SegueStatus;
};

const STATUS_LABEL: Record<SegueStatus, string> = {
  idle: '待触发',
  generating: '生成中',
  ready: 'TTS 已就绪',
  degraded: '降级'
};

const ORANGE_WAVE = [18, 30, 22, 44, 28, 58, 36, 50, 24, 68, 32, 46, 26, 60, 38, 52, 20, 42, 34, 56, 30, 48, 24, 40];
const PURPLE_WAVE = [20, 42, 28, 50, 34, 66, 24, 46, 38, 58, 30, 52, 36, 64, 26, 44, 32, 54, 22, 48, 34, 60, 28, 40];

export function PlaybackTimeline(props: PlaybackTimelineProps): JSX.Element {
  const [showSegueTooltip, setShowSegueTooltip] = useState(false);
  const timeline = props.timing
    ? buildPlaybackTimeline(props.durationSec, {
        positionSec: props.positionSec,
        timing: props.timing,
        duckingHintSec: props.duckingHintSec ?? 8
      })
    : null;
  const crossfadeRange = timeline?.ranges.find((range) => range.id === 'crossfade') ?? null;
  const crossfadePct =
    crossfadeRange && crossfadeRange.endSec > crossfadeRange.startSec
      ? Math.round(
          Math.min(
            100,
            Math.max(
              0,
              ((props.positionSec - crossfadeRange.startSec) / (crossfadeRange.endSec - crossfadeRange.startSec)) * 100
            )
          )
        )
      : 0;
  const timeToSegueSec = timeline ? Math.max(0, timeline.windowStartSec - props.positionSec) : 0;
  const script = (props.segueScript ?? '').trim();
  const tooltipText =
    script ||
    (props.segueStatus === 'degraded'
      ? '过渡文案不可用'
      : props.segueStatus === 'generating'
        ? '过渡文案生成中...'
        : '尚未触发过渡文案');

  useEffect(() => {
    setShowSegueTooltip(false);
  }, [props.currentTrackId, props.nextTrackId]);

  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">
            双 Deck 混音台
          </h3>
          <p className="mt-1 text-xs text-zinc-400">
            下一首 {props.nextTrackId ?? '未就绪'} · {STATUS_LABEL[props.segueStatus]}
          </p>
        </div>
        <div className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
          {timeline ? `${formatClock(timeline.positionSec)} / ${formatClock(timeline.durationSec)}` : '等待曲目'}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_150px_1fr] items-stretch gap-0">
        <DeckCard
          accent="orange"
          badge="A"
          meta={formatClock(props.positionSec)}
          title={props.currentTrackId ? `Track ${props.currentTrackId}` : 'Deck A'}
          wave={ORANGE_WAVE}
        />
        <div className="relative flex items-center justify-center">
          <div className="absolute left-0 h-px w-9 bg-gradient-to-r from-amber-400 to-transparent" />
          <div className="absolute right-0 h-px w-9 bg-gradient-to-l from-violet-400 to-transparent" />
          <div className="relative flex h-full min-h-36 w-full flex-col items-center justify-center border-y border-zinc-800 bg-gradient-to-r from-amber-500/10 via-zinc-900 to-violet-500/10">
            <p className="text-[11px] uppercase tracking-wide text-zinc-400">X-FADE</p>
            <p className="mt-1 text-4xl font-semibold text-amber-200">{props.timing?.crossfadeSec ?? 0}s</p>
            <p className="mt-1 text-xs text-zinc-400">交叉淡入淡出</p>
            <div className="mt-3 rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs text-zinc-300">
              {crossfadePct}%
            </div>
            <div className="relative mt-3">
              <button
                className="rounded-full border border-zinc-600 bg-zinc-950/80 px-3 py-1 text-[11px] text-zinc-200 transition hover:border-zinc-400"
                onClick={() => setShowSegueTooltip((value) => !value)}
                type="button"
              >
                查看过渡文案
              </button>
              {showSegueTooltip ? (
                <div
                  className="absolute bottom-[calc(100%+8px)] left-1/2 z-20 w-64 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-left text-xs text-zinc-100 shadow-xl"
                  role="tooltip"
                >
                  {tooltipText}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <DeckCard
          accent="purple"
          badge="B"
          meta={props.nextTrackId ? '预载中' : '--:--'}
          title={props.nextTrackId ? `Track ${props.nextTrackId}` : 'Deck B'}
          wave={PURPLE_WAVE}
        />
      </div>

      <div className="mt-4 grid grid-cols-4 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80 text-xs text-zinc-300">
        <StatusItem icon={<Clock3 className="h-4 w-4" />} label={`下一首将在 ${Math.round(timeToSegueSec)} 秒后切入`} />
        <StatusItem icon={<CheckCircle2 className="h-4 w-4 text-emerald-300" />} label="B Deck 已就绪" />
        <StatusItem icon={<Volume2 className="h-4 w-4" />} label="音量衰减 -7.2 dB" />
        <StatusItem icon={<Filter className="h-4 w-4" />} label="滤波切换中 LPF → HPF" />
      </div>
    </section>
  );
}

function DeckCard(props: {
  accent: 'orange' | 'purple';
  badge: string;
  title: string;
  meta: string;
  wave: number[];
}): JSX.Element {
  const isOrange = props.accent === 'orange';
  return (
    <div
      className={`rounded-xl border p-4 ${
        isOrange
          ? 'border-amber-500/60 bg-gradient-to-br from-amber-500/10 via-zinc-900 to-zinc-950'
          : 'border-violet-500/40 bg-gradient-to-br from-violet-500/10 via-zinc-900 to-zinc-950'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
            isOrange ? 'border-amber-400 text-amber-300' : 'border-violet-400 text-violet-300'
          }`}
        >
          {props.badge}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{props.title}</p>
          <p className="mt-0.5 text-xs text-zinc-400">{isOrange ? '当前播放' : '下一首'}</p>
        </div>
      </div>

      <div className="mt-5 flex h-16 items-center gap-1">
        {props.wave.map((height, index) => (
          <span
            className={`w-1 rounded-full ${isOrange ? 'bg-amber-400' : 'bg-violet-400'}`}
            key={index}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-400">{props.meta}</p>
    </div>
  );
}

function StatusItem(props: { icon: JSX.Element; label: string }): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 border-r border-zinc-800 px-3 py-2 last:border-r-0">
      <span className="shrink-0 text-zinc-500">{props.icon}</span>
      <span className="truncate">{props.label}</span>
    </div>
  );
}

function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '00:00';
  const rounded = Math.floor(totalSec);
  const minutes = Math.floor(rounded / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (rounded % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
