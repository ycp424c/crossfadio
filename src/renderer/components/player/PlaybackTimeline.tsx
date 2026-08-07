import { buildPlaybackTimeline } from '@renderer/audio/timeline';
import type { PlaybackTiming } from '@shared/schema';
import type { DiscoveryMode } from '@shared/dj';

type PlaybackTimelineProps = {
  durationSec: number;
  positionSec: number;
  timing: PlaybackTiming | null;
  currentTrackId: string | null;
  nextTrackId: string | null;
  mode: DiscoveryMode;
  currentTrackName?: string;
  nextTrackName?: string;
  onSeek?: (positionSec: number) => void;
};

export function PlaybackTimeline(props: PlaybackTimelineProps): JSX.Element {
  const progressPct =
    props.durationSec > 0 ? Math.min(100, (props.positionSec / props.durationSec) * 100) : 0;

  const timeline = props.timing
    ? buildPlaybackTimeline(props.durationSec, {
        positionSec: props.positionSec,
        timing: props.timing,
        duckingHintSec: 8
      })
    : null;

  // A→B: seconds until the segue window opens
  const timeToSegueSec = timeline
    ? Math.max(0, timeline.windowStartSec - props.positionSec)
    : 0;

  const fillClass = props.mode === 'explore' ? 'bg-cyan-300' : 'bg-orange-300';

  return (
    <section className="rounded-xl border border-white/10 bg-black/20 px-5 py-4">
      <div className="flex items-center gap-4">
        <span className="shrink-0 text-sm tabular-nums text-zinc-300">
          {formatClock(props.positionSec)}
        </span>
        <div className="relative flex h-8 flex-1 items-center">
          <input
            aria-label="播放进度"
            className="peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
            max={props.durationSec || 0}
            min={0}
            onChange={(event) => props.onSeek?.(Number(event.target.value))}
            step={0.1}
            type="range"
            value={props.positionSec}
          />
          <div className="h-1.5 w-full overflow-visible rounded-full bg-zinc-700/80 peer-focus-visible:ring-2 peer-focus-visible:ring-white/60 peer-focus-visible:ring-offset-4 peer-focus-visible:ring-offset-zinc-950">
            <div
              className={`h-full rounded-full ${fillClass} transition-[width] duration-300 ease-linear`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-zinc-300">
          {formatClock(props.durationSec)}
        </span>
      </div>

      {props.nextTrackId ? (
        <div className="mt-2 flex items-center gap-2 overflow-hidden text-xs text-zinc-500">
          <span className="max-w-[40vw] truncate text-zinc-300 md:max-w-[220px]">
            {props.currentTrackName ?? props.currentTrackId ?? 'A'}
          </span>
          <span className={`shrink-0 ${props.mode === 'explore' ? 'text-cyan-300' : 'text-orange-300'}`}>A→B</span>
          <span className="max-w-[40vw] truncate text-zinc-300 md:max-w-[220px]">
            {props.nextTrackName ?? props.nextTrackId}
          </span>
          <span className="shrink-0">{Math.round(timeToSegueSec)} 秒后切换</span>
        </div>
      ) : null}
    </section>
  );
}

function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '00:00';
  const rounded = Math.floor(totalSec);
  const minutes = Math.floor(rounded / 60).toString().padStart(2, '0');
  const seconds = (rounded % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
