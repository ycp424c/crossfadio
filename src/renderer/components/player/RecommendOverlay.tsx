import { useEffect, useState, useCallback } from 'react';
import { Loader2, Search, Check, X, ChevronDown } from 'lucide-react';
import { cancelRecommend } from '@renderer/sse/client';

type Phase = 'idle' | 'searching' | 'picking' | 'done' | 'error' | 'cancelled';

type JobState = {
  jobId: string;
  phase: Phase;
  candidateCount?: number;
  tracks?: Array<{ name: string; artist: string }>;
  reason?: string;
};

type RecommendEvent = { type: string; data: Record<string, unknown> };

export function RecommendOverlay({ recommendEvent }: { recommendEvent: RecommendEvent | null }): JSX.Element {
  const [job, setJob] = useState<JobState | null>(null);

  useEffect(() => {
    if (!recommendEvent) return;
    if (recommendEvent.type === 'chat.recommend.started') {
      setJob({ jobId: String(recommendEvent.data.jobId ?? ''), phase: 'searching' });
    } else if (recommendEvent.type === 'chat.recommend.progress') {
      const phase = String(recommendEvent.data.phase ?? '') as Phase;
      setJob((prev) => {
        if (!prev || prev.jobId !== String(recommendEvent.data.jobId ?? '')) return prev;
        return {
          ...prev,
          phase,
          candidateCount: typeof recommendEvent.data.candidateCount === 'number' ? recommendEvent.data.candidateCount : prev.candidateCount,
          tracks: Array.isArray(recommendEvent.data.tracks) ? (recommendEvent.data.tracks as Array<{ name: string; artist: string }>) : prev.tracks,
          reason: typeof recommendEvent.data.reason === 'string' ? recommendEvent.data.reason : prev.reason
        };
      });
    }
  }, [recommendEvent]);

  const handleCancel = useCallback(() => {
    if (job) {
      cancelRecommend(job.jobId);
      setJob((prev) => prev ? { ...prev, phase: 'cancelled' } : null);
    }
  }, [job]);

  // Auto-dismiss after done/error/cancelled
  useEffect(() => {
    if (job && (job.phase === 'done' || job.phase === 'error' || job.phase === 'cancelled')) {
      const timer = setTimeout(() => setJob(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [job]);

  if (!job) return <></>;

  const isActive = job.phase === 'searching' || job.phase === 'picking';

  return (
    <div className="fixed bottom-20 right-4 left-4 md:left-auto z-50 md:max-w-xs animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/90 backdrop-blur-md shadow-2xl shadow-black/40 px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Icon */}
          <div className="flex-shrink-0">
            {job.phase === 'searching' && <Search className="h-4 w-4 text-cyan-300 animate-spin" />}
            {job.phase === 'picking' && <ChevronDown className="h-4 w-4 text-cyan-300 animate-pulse" />}
            {job.phase === 'done' && <Check className="h-4 w-4 text-emerald-400" />}
            {job.phase === 'error' && <X className="h-4 w-4 text-red-400" />}
            {job.phase === 'cancelled' && <X className="h-4 w-4 text-zinc-400" />}
          </div>

          {/* Text */}
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-100 leading-snug">
              {job.phase === 'searching' && '正在搜索歌曲…'}
              {job.phase === 'picking' && job.candidateCount != null && (
                <>正在从 <span className="text-cyan-300 font-medium">{job.candidateCount}</span> 首候选中挑选…</>
              )}
              {job.phase === 'picking' && job.candidateCount == null && '正在挑选歌曲…'}
              {job.phase === 'done' && job.tracks && job.tracks.length > 0 && (
                <span>
                  已添加{' '}
                  <span className="text-emerald-400 font-medium">
                    {job.tracks.map((t) => t.name).join('、')}
                  </span>
                </span>
              )}
              {job.phase === 'error' && (
                <span className="text-red-400">{job.reason === 'no-candidates' ? '未找到匹配歌曲' : '推荐失败'}</span>
              )}
              {job.phase === 'cancelled' && <span className="text-zinc-400">已取消推荐</span>}
            </p>
            {job.tracks && job.tracks.length > 0 && (
              <p className="text-[10px] text-zinc-500 mt-0.5 truncate">
                {job.tracks.map((t) => `${t.name}（${t.artist}）`).join('、')}
              </p>
            )}
          </div>

          {/* Cancel button */}
          {isActive && (
            <button
              onClick={handleCancel}
              className="flex-shrink-0 rounded-md px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
