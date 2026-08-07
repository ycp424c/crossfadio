import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { DiscoveryMode } from '@shared/dj';

type TransportControlsProps = {
  isPlaying: boolean;
  canPrev: boolean;
  canSkip: boolean;
  mode: DiscoveryMode;
  onPrev: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
};

export function TransportControls(props: TransportControlsProps): JSX.Element {
  const tone = props.mode === 'explore'
    ? {
        play: 'border-cyan-300/80 text-cyan-50 shadow-[0_0_20px_rgba(45,212,191,0.22)] hover:bg-cyan-300/15',
        hover: 'hover:text-cyan-200'
      }
    : {
        play: 'border-orange-300/80 text-orange-50 shadow-[0_0_20px_rgba(251,146,60,0.20)] hover:bg-orange-300/15',
        hover: 'hover:text-orange-200'
      };

  return (
    <section className="rounded-xl border border-white/10 bg-black/20 px-5 py-4">
      <div className="flex items-center justify-center gap-3 sm:gap-6">
        <button
          aria-label="上一首"
          className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm transition ${
            props.canPrev
              ? `text-zinc-200 hover:bg-white/5 ${tone.hover}`
              : 'cursor-not-allowed text-zinc-500'
          }`}
          disabled={!props.canPrev}
          onClick={props.onPrev}
          type="button"
        >
          <SkipBack className="h-4 w-4" />
          <span className="hidden sm:inline">上一首</span>
        </button>
        <button
          aria-label={props.isPlaying ? '暂停' : '播放'}
          className={`inline-flex h-14 w-14 items-center justify-center rounded-full border bg-black/35 transition ${tone.play}`}
          onClick={props.onPlayPause}
          type="button"
        >
          {props.isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="h-6 w-6 fill-current" />}
        </button>
        <button
          aria-label="下一首"
          className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm transition ${
            props.canSkip
              ? `text-zinc-200 hover:bg-white/5 ${tone.hover}`
              : 'cursor-not-allowed text-zinc-500'
          }`}
          disabled={!props.canSkip}
          onClick={props.onSkip}
          type="button"
        >
          <SkipForward className="h-4 w-4" />
          <span className="hidden sm:inline">下一首</span>
        </button>
      </div>
    </section>
  );
}
