import React, { useEffect, useMemo, useRef } from 'react';
import { getActiveLyricIndex, parseSyncedLyrics } from '@renderer/audio/lyrics';
import { getUserScrollBehavior } from '@renderer/lib-motion';
import type { DiscoveryMode } from '@shared/dj';

type SyncedLyricsProps = {
  lyric: string;
  positionSec: number;
  mode: DiscoveryMode;
};

function scrollLyricLineIntoContainer(container: HTMLElement, line: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const centeredTop = container.scrollTop + lineRect.top - containerRect.top - container.clientHeight / 2 + lineRect.height / 2;
  const top = Math.min(maxScrollTop, Math.max(0, centeredTop));

  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ behavior: getUserScrollBehavior(), top });
    return;
  }

  container.scrollTop = top;
}

export function SyncedLyrics(props: SyncedLyricsProps): JSX.Element {
  const lines = useMemo(() => parseSyncedLyrics(props.lyric), [props.lyric]);
  const activeIndex = getActiveLyricIndex(lines, props.positionSec);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const activeLineClass = props.mode === 'explore'
    ? 'bg-cyan-300/10 text-cyan-100'
    : 'bg-orange-300/10 text-orange-100';

  useEffect(() => {
    if (activeIndex < 0) return;
    const container = scrollContainerRef.current;
    const activeLine = activeLineRef.current;
    if (!container || !activeLine) return;

    scrollLyricLineIntoContainer(container, activeLine);
  }, [activeIndex, lines]);

  if (lines.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
        <p className="text-sm leading-7 text-zinc-300">{props.lyric || '暂无歌词，已进入纯音乐播放模式。'}</p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 h-48 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-4 [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_12%,black_88%,transparent_100%)]"
      ref={scrollContainerRef}
      style={{ scrollbarWidth: 'none', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)' }}
    >
      <div className="space-y-2">
        {lines.map((line, index) => {
          const isActive = index === activeIndex;
          return (
            <div
              className={`rounded-lg px-3 py-1.5 text-sm leading-7 transition ${
                isActive
                  ? activeLineClass
                  : 'text-zinc-500'
              }`}
              key={`${index}-${line.timeSec}-${line.text}`}
              ref={isActive ? activeLineRef : undefined}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
