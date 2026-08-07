import { Heart } from 'lucide-react';
import { SyncedLyrics } from './SyncedLyrics';
import type { DiscoveryMode } from '@shared/dj';
import coverPlaceholder from '@renderer/assets/image2/cover-placeholder.svg';

type NowPlayingHeroProps = {
  title: string;
  subtitle: string;
  lyric: string;
  coverImgUrl?: string | null;
  positionSec: number;
  isLiked: boolean;
  mode: DiscoveryMode;
  onToggleLike: () => void;
};

export function NowPlayingHero(props: NowPlayingHeroProps): JSX.Element {
  return (
    <section className="relative overflow-hidden rounded-xl border border-white/10 bg-black/30 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] md:p-5">
      {/* 封面模糊放大做氛围底，替代纯装饰渐变 */}
      {props.coverImgUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-3xl"
          src={props.coverImgUrl}
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-black/20" />
      <div className="relative">
        <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:gap-8">
          <img
            alt="当前曲目封面"
            className="h-28 w-28 shrink-0 rounded-lg border border-white/15 object-cover shadow-2xl shadow-black/50 md:h-44 md:w-44"
            src={props.coverImgUrl ?? coverPlaceholder}
          />
          <div className="min-w-0 pt-1 md:max-w-xl">
            <p className="mb-3 text-sm font-semibold text-zinc-100">正在播放</p>
            <h2 className="pr-12 text-2xl font-bold leading-tight tracking-normal text-zinc-50 md:pr-0 md:text-4xl">{props.title}</h2>
            <p className="mt-3 truncate text-base text-zinc-300">{props.subtitle}</p>
            <div className="mt-6">
              <SyncedLyrics lyric={props.lyric} mode={props.mode} positionSec={props.positionSec} />
            </div>
          </div>
        </div>
        <button
          aria-label={props.isLiked ? '取消喜欢' : '喜欢'}
          className={`absolute right-0 top-0 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border p-2 transition ${
            props.isLiked
              ? 'border-rose-300/70 bg-rose-400/20 text-rose-200'
              : 'border-white/15 bg-black/30 text-zinc-300 hover:border-rose-300/50 hover:text-rose-200'
          }`}
          onClick={props.onToggleLike}
          type="button"
        >
          <Heart className={`h-4 w-4 ${props.isLiked ? 'fill-current' : ''}`} />
        </button>
      </div>
    </section>
  );
}
