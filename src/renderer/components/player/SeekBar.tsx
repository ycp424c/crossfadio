type SeekBarProps = {
  positionSec: number;
  durationSec: number;
  onSeek: (positionSec: number) => void;
};

export function SeekBar(props: SeekBarProps): JSX.Element {
  const durationSec = Math.max(0, props.durationSec);
  const positionSec = Math.min(Math.max(0, props.positionSec), durationSec || 0);
  const progressPct = durationSec > 0 ? (positionSec / durationSec) * 100 : 0;

  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-5 py-4">
      <div className="mb-2 flex items-center justify-between text-sm text-zinc-300">
        <span>{formatClock(positionSec)}</span>
        <span>{formatClock(durationSec)}</span>
      </div>
      <input
        aria-label="播放进度"
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-amber-400"
        max={durationSec || 0}
        min={0}
        onChange={(event) => props.onSeek(Number(event.target.value))}
        step={0.1}
        style={{
          background: `linear-gradient(90deg, #f59e0b 0%, #f59e0b ${progressPct}%, #27272a ${progressPct}%, #27272a 100%)`
        }}
        type="range"
        value={positionSec}
      />
    </section>
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
