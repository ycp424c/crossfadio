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
    <section className="relative overflow-hidden rounded-xl border border-white/10 bg-black/30 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_25%,rgba(56,189,248,0.10),transparent_28%),radial-gradient(circle_at_15%_90%,rgba(20,184,166,0.08),transparent_30%)]" />
      <div className="pointer-events-none absolute right-8 top-8 hidden h-56 w-80 opacity-50 md:block">
        <svg className="h-full w-full" fill="none" viewBox="0 0 360 240">
          <path d="M8 158 56 126 92 164 130 96 178 72 226 82 258 42 318 86 350 110" stroke="rgba(148, 210, 230, .42)" strokeDasharray="2 8" />
          <path d="M78 204 112 176 98 134 152 104 198 112 232 74 292 28 340 76" stroke="rgba(148, 210, 230, .28)" strokeDasharray="2 8" />
          {[
            [56, 126],
            [130, 96],
            [226, 82],
            [258, 42],
            [112, 176],
            [198, 112]
          ].map(([cx, cy]) => (
            <circle cx={cx} cy={cy} fill="rgba(165, 243, 252, .72)" key={`${cx}-${cy}`} r="2" />
          ))}
        </svg>
      </div>
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:gap-8">
          <img
            alt="当前曲目封面"
            className="h-44 w-44 shrink-0 rounded-lg border border-white/15 object-cover shadow-2xl shadow-black/50"
            src={props.coverImgUrl ?? coverPlaceholder}
          />
          <div className="min-w-0 pt-1 md:max-w-xl">
            <p className="mb-3 text-sm font-semibold text-zinc-100">正在播放</p>
            <h2 className="text-3xl font-bold leading-tight tracking-normal text-zinc-50 md:text-4xl">{props.title}</h2>
            <p className="mt-3 truncate text-base text-zinc-300">{props.subtitle}</p>
            <div className="mt-6">
              <SyncedLyrics lyric={props.lyric} positionSec={props.positionSec} />
            </div>
          </div>
        </div>
        <button
          aria-label={props.isLiked ? '取消喜欢' : '喜欢'}
          className={`inline-flex shrink-0 items-center rounded-full border p-2 transition ${
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
