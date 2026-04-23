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
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="flex items-center justify-center gap-3">
        <button
          className={`rounded-xl border px-4 py-2 text-sm ${
            props.canPrev
              ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500'
              : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
          }`}
          disabled={!props.canPrev}
          onClick={props.onPrev}
          type="button"
        >
          Prev
        </button>
        <button
          className="rounded-xl border border-amber-400/70 bg-amber-500/20 px-5 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/30"
          onClick={props.onPlayPause}
          type="button"
        >
          {props.isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          className={`rounded-xl border px-4 py-2 text-sm ${
            props.canSkip
              ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500'
              : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
          }`}
          disabled={!props.canSkip}
          onClick={props.onSkip}
          type="button"
        >
          Skip
        </button>
      </div>
    </section>
  );
}
