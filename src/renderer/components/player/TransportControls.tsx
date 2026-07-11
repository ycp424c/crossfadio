import { Pause, Play, Repeat2, Shuffle, SkipBack, SkipForward } from 'lucide-react';

type TransportControlsProps = {
  isPlaying: boolean;
  canPrev: boolean;
  canSkip: boolean;
  onPrev: () => void;
  onPlayPause: () => void;
  onSkip: () => void;
};

export function TransportControls(props: TransportControlsProps): JSX.Element {
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 px-5 py-4">
      <div className="flex items-center justify-center gap-2 sm:gap-5">
        <button
          aria-label="随机播放"
          className="hidden h-10 w-10 items-center justify-center rounded-full text-zinc-300 transition hover:bg-white/5 hover:text-cyan-200 sm:inline-flex"
          type="button"
        >
          <Shuffle className="h-4 w-4" />
        </button>
        <button
          aria-label="上一首"
          className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm ${
            props.canPrev
              ? 'text-zinc-200 hover:bg-white/5'
              : 'cursor-not-allowed text-zinc-600'
          }`}
          disabled={!props.canPrev}
          onClick={props.onPrev}
          type="button"
        >
          <SkipBack className="h-4 w-4" />
          <span className="hidden sm:inline">Prev</span>
        </button>
        <button
          aria-label={props.isPlaying ? '暂停' : '播放'}
          className="inline-flex min-h-11 min-w-11 h-14 w-14 items-center justify-center rounded-full border border-cyan-300/80 bg-black/35 text-cyan-50 shadow-[0_0_24px_rgba(45,212,191,0.30)] transition hover:bg-cyan-300/15"
          onClick={props.onPlayPause}
          type="button"
        >
          {props.isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="h-6 w-6 fill-current" />}
        </button>
        <button
          aria-label="下一首"
          className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm ${
            props.canSkip
              ? 'text-zinc-200 hover:bg-white/5'
              : 'cursor-not-allowed text-zinc-600'
          }`}
          disabled={!props.canSkip}
          onClick={props.onSkip}
          type="button"
        >
          <SkipForward className="h-4 w-4" />
          <span className="hidden sm:inline">Skip</span>
        </button>
        <button
          aria-label="循环模式"
          className="hidden h-10 w-10 items-center justify-center rounded-full text-zinc-300 transition hover:bg-white/5 hover:text-cyan-200 sm:inline-flex"
          type="button"
        >
          <Repeat2 className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
