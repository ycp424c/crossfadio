import { ListMusic, X } from 'lucide-react';
import type { QueueTrackDto } from '@shared/schema';

type QueuePanelProps = {
  queue: QueueTrackDto[];
  currentIndex: number;
  nextId: string | null;
  onSelectIndex: (index: number) => void;
  onDeleteIndex: (index: number) => void;
};

export function QueuePanel(props: QueuePanelProps): JSX.Element {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
          <ListMusic className="h-5 w-5 text-cyan-300" />
          播放队列
        </h3>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-300">
          {props.queue.length} 首
        </span>
      </div>
      <ul className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
        {props.queue.map((track, index) => {
          const isCurrent = index === props.currentIndex;
          const isNext = track.id === props.nextId && !isCurrent;
          return (
            <li key={track.id} className="flex items-center gap-1">
              <button
                className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left text-sm transition ${
                  isCurrent
                    ? 'border-violet-400/70 bg-violet-500/15 text-violet-100'
                    : 'border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:border-zinc-600'
                }`}
                onClick={() => props.onSelectIndex(index)}
                type="button"
              >
                <div className="flex items-center gap-3">
                  {track.coverImgUrl ? (
                    <img
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-md object-cover"
                      src={track.coverImgUrl}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    #{index + 1} · {track.name} - {track.artists.join(' / ') || '未知歌手'}
                  </span>
                  {isCurrent ? <span className="shrink-0 text-xs text-violet-200">当前</span> : null}
                  {isNext ? <span className="shrink-0 text-xs text-cyan-300">下一首</span> : null}
                </div>
              </button>
              {!isCurrent ? (
                <button
                  className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-500 transition hover:border-zinc-600 hover:text-red-400"
                  onClick={() => props.onDeleteIndex(index)}
                  title="从队列移除"
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
