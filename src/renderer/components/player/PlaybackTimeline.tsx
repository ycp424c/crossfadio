import { Activity, RadioTower, Waves } from 'lucide-react';
import { buildPlaybackTimeline } from '@renderer/audio/timeline';
import type { PlaybackTiming } from '@shared/schema';

type SegueStatus = 'idle' | 'generating' | 'ready' | 'degraded';

type PlaybackTimelineProps = {
  durationSec: number;
  positionSec: number;
  timing: PlaybackTiming | null;
  duckingHintSec?: number;
  nextTrackId: string | null;
  segueStatus: SegueStatus;
};

const STATUS_LABEL: Record<SegueStatus, string> = {
  idle: '待触发',
  generating: '生成中',
  ready: 'TTS 已就绪',
  degraded: '降级'
};

export function PlaybackTimeline(props: PlaybackTimelineProps): JSX.Element {
  const timeline = props.timing
    ? buildPlaybackTimeline(props.durationSec, {
        positionSec: props.positionSec,
        timing: props.timing,
        duckingHintSec: props.duckingHintSec ?? 8
      })
    : null;

  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Waves className="h-5 w-5 text-cyan-300" />
            动态编排 Timeline
          </h3>
          <p className="mt-1 text-xs text-zinc-400">
            下一首 {props.nextTrackId ?? '未就绪'} · {STATUS_LABEL[props.segueStatus]}
          </p>
        </div>
        <div className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
          {timeline ? `${formatClock(timeline.positionSec)} / ${formatClock(timeline.durationSec)}` : '等待曲目'}
        </div>
      </div>

      <div className="mt-5">
        <div className="relative h-12 rounded-xl border border-zinc-800 bg-zinc-900/80 shadow-inner shadow-black/30">
          <div
            className="absolute inset-y-0 left-0 rounded-l-xl bg-gradient-to-r from-cyan-400/20 via-violet-400/20 to-amber-300/20"
            style={{ width: `${timeline?.progressPct ?? 0}%` }}
          />
          {timeline?.ranges.map((range) => (
            <div
              className={`absolute top-2 h-8 rounded-md border ${
                range.id === 'crossfade'
                  ? 'border-amber-300/40 bg-amber-300/15'
                  : 'border-cyan-300/40 bg-cyan-300/15'
              }`}
              key={range.id}
              style={{ left: `${range.startPct}%`, width: `${range.widthPct}%` }}
              title={`${range.label}: ${formatClock(range.startSec)}-${formatClock(range.endSec)}`}
            />
          ))}
          {timeline?.events.map((event) => (
            <div
              className="absolute top-1/2 h-8 w-px -translate-y-1/2 bg-zinc-100/80"
              key={event.id}
              style={{ left: `${event.pct}%` }}
              title={`${event.label}: ${formatClock(event.atSec)}`}
            >
              <span className="absolute left-1 top-0 rounded bg-zinc-950/90 px-1.5 py-0.5 text-[10px] text-zinc-200">
                {event.label}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-zinc-300">
          <Metric icon={<RadioTower className="h-3.5 w-3.5" />} label="Segue" value={eventLabel(timeline, 'segue')} />
          <Metric icon={<Activity className="h-3.5 w-3.5" />} label="Prefetch" value={eventLabel(timeline, 'prefetch')} />
          <Metric icon={<Waves className="h-3.5 w-3.5" />} label="X-Fade" value={eventLabel(timeline, 'crossfade')} />
        </div>
      </div>
    </section>
  );
}

function Metric(props: { icon: JSX.Element; label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="flex items-center gap-1.5 text-zinc-400">
        {props.icon}
        {props.label}
      </div>
      <div className="mt-1 font-medium text-zinc-100">{props.value}</div>
    </div>
  );
}

function eventLabel(timeline: ReturnType<typeof buildPlaybackTimeline> | null, id: string): string {
  const event = timeline?.events.find((item) => item.id === id);
  return event ? formatClock(event.atSec) : '--:--';
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
