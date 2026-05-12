import { Heart } from 'lucide-react';
import { SyncedLyrics } from './SyncedLyrics';
import coverPlaceholder from '@renderer/assets/image2/cover-placeholder.svg';

type NowPlayingHeroProps = {
  title: string;
  subtitle: string;
  lyric: string;
  coverImgUrl?: string | null;
  positionSec: number;
  isLiked: boolean;
  onToggleLike: () => void;
};

export function NowPlayingHero(props: NowPlayingHeroProps): JSX.Element {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <img
            alt="当前曲目封面"
            className="h-32 w-32 shrink-0 rounded-xl border border-white/10 object-cover shadow-2xl shadow-black/40"
            src={props.coverImgUrl ?? coverPlaceholder}
          />
          <div className="min-w-0">
            <h2 className="text-lg md:text-xl font-semibold leading-tight text-zinc-100">{props.title}</h2>
            <p className="mt-1 truncate text-sm text-zinc-400">{props.subtitle}</p>
          </div>
        </div>
        <button
          aria-label={props.isLiked ? '取消喜欢' : '喜欢'}
          className={`shrink-0 inline-flex items-center rounded-full border p-2 transition ${
            props.isLiked
              ? 'border-violet-400/70 bg-violet-500/20 text-violet-200'
              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
          }`}
          onClick={props.onToggleLike}
          type="button"
        >
          <Heart className={`h-4 w-4 ${props.isLiked ? 'fill-current' : ''}`} />
        </button>
      </div>
      <SyncedLyrics lyric={props.lyric} positionSec={props.positionSec} />
    </section>
  );
}
