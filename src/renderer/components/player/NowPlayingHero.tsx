import { Heart, Music2 } from 'lucide-react';
import { SyncedLyrics } from './SyncedLyrics';
import coverPlaceholder from '@renderer/assets/image2/cover-placeholder.svg';

type NowPlayingHeroProps = {
  trackId: string;
  title: string;
  subtitle: string;
  lyric: string;
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
            alt="当前曲目封面占位图"
            className="h-24 w-24 rounded-xl border border-zinc-700/70 object-cover"
            src={coverPlaceholder}
          />
          <div>
            <div className="mb-2 inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-100">
              <Music2 className="h-3.5 w-3.5" />
              DJ Deck A
            </div>
            <h2 className="text-2xl font-semibold text-zinc-100">{props.title}</h2>
            <p className="mt-1 text-sm text-zinc-400">{props.subtitle}</p>
            <p className="mt-1 text-xs uppercase tracking-wide text-zinc-500">NCM ID: {props.trackId}</p>
          </div>
        </div>
        <button
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
            props.isLiked
              ? 'border-violet-400/70 bg-violet-500/20 text-violet-200'
              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
          }`}
          onClick={props.onToggleLike}
          type="button"
        >
          <Heart className={`h-4 w-4 ${props.isLiked ? 'fill-current' : ''}`} />
          {props.isLiked ? '已喜欢' : '喜欢'}
        </button>
      </div>
      <SyncedLyrics lyric={props.lyric} positionSec={props.positionSec} />
    </section>
  );
}
