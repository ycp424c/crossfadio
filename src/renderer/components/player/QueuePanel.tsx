import { ListMusic, X } from 'lucide-react';
import type { QueueTrackDto } from '@shared/schema';
import type { DiscoveryMode } from '@shared/dj';

type QueuePanelProps = {
  queue: QueueTrackDto[];
  currentIndex: number;
  mode: DiscoveryMode;
  nextId: string | null;
  onSelectIndex: (index: number) => void;
  onDeleteIndex: (index: number) => void;
};

export function QueuePanel(props: QueuePanelProps): JSX.Element {
  const tone = props.mode === 'explore'
    ? {
        border: 'border-cyan-200/15',
        icon: 'text-cyan-200',
        currentBadge: 'border-cyan-300/70 bg-cyan-400/15 text-cyan-100',
        currentItem: 'border-cyan-300/30 bg-cyan-400/10 text-cyan-50',
        currentMeta: 'text-cyan-200'
      }
    : {
          border: 'border-orange-200/15',
          icon: 'text-orange-200',
          currentBadge: 'border-orange-300/70 bg-orange-400/15 text-orange-100',
          currentItem: 'border-orange-300/30 bg-orange-400/10 text-orange-50',
          currentMeta: 'text-orange-200'
        };

  return (
    <section className={`rounded-xl border bg-black/25 p-4 ${tone.border}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
          <ListMusic className={`h-5 w-5 ${tone.icon}`} />
          播放队列
        </h3>
        <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-zinc-300">
          {props.queue.length} 首
        </span>
      </div>
      {props.queue.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <ListMusic className="h-8 w-8 text-zinc-600" />
          <p className="text-sm text-zinc-400">队列还是空的</p>
          <p className="text-xs text-zinc-400">去「聊天」页告诉 DJ 你的心情，让它帮你挑几首</p>
        </div>
      ) : (
      <ul className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
        {props.queue.map((track, index) => {
          const isCurrent = index === props.currentIndex;
          const isNext = track.id === props.nextId && !isCurrent;
          return (
            <li key={`${track.id}-${index}`} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                  isCurrent
                    ? tone.currentBadge
                    : 'border-white/20 text-zinc-400'
                }`}
              >
                {index + 1}
              </span>
              <button
                className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left text-sm transition ${
                  isCurrent
                    ? tone.currentItem
                    : 'border-white/5 bg-white/[0.03] text-zinc-300 hover:border-white/15'
                }`}
                onClick={() => props.onSelectIndex(index)}
                type="button"
              >
                <div className="flex items-center gap-3">
                  {track.coverImgUrl ? (
                    <img
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-md object-cover"
                      src={track.coverImgUrl}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{track.name}</span>
                    <span className={`mt-1 block truncate text-xs ${isCurrent ? tone.currentMeta : 'text-zinc-500'}`}>
                      {isCurrent ? '当前播放' : isNext ? '下一首' : track.artists.join(' / ') || '未知歌手'}
                    </span>
                  </span>
                </div>
              </button>
              {!isCurrent ? (
                <button
                  aria-label={`从队列移除 ${track.name}`}
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-red-300"
                  onClick={() => props.onDeleteIndex(index)}
                  type="button"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );
}
