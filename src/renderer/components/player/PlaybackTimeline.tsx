import { buildPlaybackTimeline } from '@renderer/audio/timeline';
import type { PlaybackTiming } from '@shared/schema';

type PlaybackTimelineProps = {
  durationSec: number;
  positionSec: number;
  timing: PlaybackTiming | null;
  currentTrackId: string | null;
  nextTrackId: string | null;
  currentTrackName?: string;
  nextTrackName?: string;
  onSeek?: (positionSec: number) => void;
};

export function PlaybackTimeline(props: PlaybackTimelineProps): JSX.Element {
  const progressPct =
    props.durationSec > 0 ? (props.positionSec / props.durationSec) * 100 : 0;

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

  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
      {/* Progress bar row */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {formatClock(props.positionSec)}
        </span>
        <input
          aria-label="播放进度"
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-amber-400"
          max={props.durationSec || 0}
          min={0}
          onChange={(event) => props.onSeek?.(Number(event.target.value))}
          step={0.1}
          style={{
            background: `linear-gradient(90deg, #f59e0b 0%, #f59e0b ${progressPct}%, #27272a ${progressPct}%, #27272a 100%)`
          }}
          type="range"
          value={props.positionSec}
        />
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {formatClock(props.durationSec)}
        </span>
      </div>

      {/* A→B transition line */}
      {props.nextTrackId ? (
        <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden text-xs text-zinc-500">
          <span className="max-w-[160px] truncate text-amber-400/70">
            {props.currentTrackName ?? props.currentTrackId ?? 'A'}
          </span>
          <span className="shrink-0">——×——</span>
          <span className="max-w-[160px] truncate text-violet-400/70">
            {props.nextTrackName ?? props.nextTrackId}
          </span>
          <span className="shrink-0">· {Math.round(timeToSegueSec)}s 后切换</span>
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
