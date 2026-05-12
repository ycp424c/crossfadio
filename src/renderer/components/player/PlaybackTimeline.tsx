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
    <section className="rounded-xl border border-white/10 bg-black/20 px-5 py-4">
      <div className="flex items-center gap-4">
        <span className="shrink-0 text-sm tabular-nums text-zinc-300">
          {formatClock(props.positionSec)}
        </span>
        <div className="relative h-8 flex-1">
          <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center gap-[3px] overflow-hidden">
            {Array.from({ length: 96 }).map((_, index) => {
              const active = (index / 95) * 100 <= progressPct;
              const height = 6 + ((index * 7) % 18);
              return (
                <span
                  className={`w-0.5 shrink-0 rounded-full ${active ? 'bg-cyan-300' : 'bg-zinc-700/80'}`}
                  key={index}
                  style={{ height }}
                />
              );
            })}
          </div>
          <input
            aria-label="播放进度"
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
            max={props.durationSec || 0}
            min={0}
            onChange={(event) => props.onSeek?.(Number(event.target.value))}
            step={0.1}
            type="range"
            value={props.positionSec}
          />
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
          <span className="shrink-0 text-cyan-300">A→B</span>
          <span className="max-w-[40vw] truncate text-zinc-300 md:max-w-[220px]">
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
