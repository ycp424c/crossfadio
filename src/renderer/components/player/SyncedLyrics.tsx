import { useEffect, useMemo, useRef } from 'react';
import { getActiveLyricIndex, parseSyncedLyrics } from '@renderer/audio/lyrics';

type SyncedLyricsProps = {
  lyric: string;
  positionSec: number;
};

export function SyncedLyrics(props: SyncedLyricsProps): JSX.Element {
  const lines = useMemo(() => parseSyncedLyrics(props.lyric), [props.lyric]);
  const activeIndex = getActiveLyricIndex(lines, props.positionSec);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex]);

  if (lines.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-950/80 to-cyan-950/40 p-4">
        <p className="text-sm leading-7 text-zinc-300">{props.lyric || '暂无歌词，已进入纯音乐播放模式。'}</p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 h-40 overflow-y-auto rounded-xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-950/80 to-cyan-950/40 p-4 [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: 'none' }}
    >
      <div className="space-y-2">
        {lines.map((line, index) => {
          const isActive = index === activeIndex;
          return (
            <div
              className={`rounded-lg px-3 py-1.5 text-sm leading-7 transition ${
                isActive
                  ? 'bg-cyan-300/10 text-cyan-100 shadow-[0_0_24px_rgba(103,232,249,0.12)]'
                  : 'text-zinc-500'
              }`}
              key={`${index}-${line.timeSec}-${line.text}`}
              ref={isActive ? activeRef : undefined}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
