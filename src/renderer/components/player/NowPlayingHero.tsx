type NowPlayingHeroProps = {
  trackId: string;
  title: string;
  subtitle: string;
  lyric: string;
  isLiked: boolean;
  onToggleLike: () => void;
};

export function NowPlayingHero(props: NowPlayingHeroProps): JSX.Element {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-zinc-100">{props.title}</h2>
          <p className="mt-1 text-sm text-zinc-400">{props.subtitle}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-zinc-500">NCM ID: {props.trackId}</p>
        </div>
        <button
          className={`rounded-full border px-3 py-1.5 text-sm transition ${
            props.isLiked
              ? 'border-violet-400/70 bg-violet-500/20 text-violet-200'
              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
          }`}
          onClick={props.onToggleLike}
          type="button"
        >
          {props.isLiked ? '已喜欢' : '喜欢'}
        </button>
      </div>
      <div className="mt-4 rounded-xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-950/80 to-cyan-950/40 p-4">
        <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-7 text-zinc-200">
          {props.lyric || '暂无歌词，已进入纯音乐播放模式。'}
        </p>
      </div>
    </section>
  );
}
