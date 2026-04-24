import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, RefreshCw, Loader2, ChevronRight, Zap } from 'lucide-react';
import { getTodayPlan, regeneratePlan, replanSegment } from '@renderer/api';
import type { PlanOutput, PlanSegment } from '@renderer/api';

type Status = 'idle' | 'loading' | 'regenerating';

export function PlanView(): JSX.Element {
  const [plan, setPlan] = useState<PlanOutput | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [replanningId, setReplanningId] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const result = await getTodayPlan();
      setPlan(result.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setStatus('idle');
    }
  }, []);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  async function handleRegenerate(): Promise<void> {
    setStatus('regenerating');
    setError(null);
    try {
      const result = await regeneratePlan();
      setPlan(result.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新生成失败');
    } finally {
      setStatus('idle');
    }
  }

  async function handleReplanSegment(segmentId: string): Promise<void> {
    setReplanningId(segmentId);
    try {
      const result = await replanSegment(segmentId);
      setPlan(result.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重排失败');
    } finally {
      setReplanningId(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-zinc-400" />
          <h1 className="text-lg font-semibold">今日电台</h1>
          {plan && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
              {plan.date}
            </span>
          )}
        </div>
        <button
          onClick={handleRegenerate}
          disabled={status !== 'idle'}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        >
          {status === 'regenerating' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          重新规划
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {status === 'loading' && (
          <div className="flex h-48 items-center justify-center text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {plan && (
          <>
            {plan.narrative && (
              <p className="mb-4 text-sm italic text-zinc-400">{plan.narrative}</p>
            )}

            <div className="space-y-3">
              {plan.segments.map((seg) => (
                <SegmentCard
                  key={seg.id}
                  segment={seg}
                  isReplanning={replanningId === seg.id}
                  onReplan={() => handleReplanSegment(seg.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SegmentCard({
  segment,
  isReplanning,
  onReplan
}: {
  segment: PlanSegment;
  isReplanning: boolean;
  onReplan: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const energyColor =
    segment.energyPct >= 60
      ? 'bg-orange-500'
      : segment.energyPct >= 40
        ? 'bg-indigo-500'
        : 'bg-teal-600';

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      {/* Segment header */}
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className={`h-2 w-2 rounded-full flex-shrink-0 ${energyColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{segment.label}</span>
            <span className="text-xs text-zinc-500">{segment.timeRange}</span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {segment.mood} · {segment.tracks.length} 首 · 能量 {segment.energyPct}%
          </div>
        </div>
        <ChevronRight
          className={`h-4 w-4 text-zinc-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Track list */}
      {expanded && (
        <div className="border-t border-zinc-800">
          <ul className="divide-y divide-zinc-800/60">
            {segment.tracks.map((track, i) => (
              <li key={i} className="px-4 py-2.5">
                <p className="text-sm text-zinc-200">{track.query}</p>
                {track.reason && (
                  <p className="mt-0.5 text-xs text-zinc-500">{track.reason}</p>
                )}
              </li>
            ))}
          </ul>

          {/* Replan button */}
          <div className="border-t border-zinc-800 px-4 py-2">
            <button
              onClick={(e) => { e.stopPropagation(); onReplan(); }}
              disabled={isReplanning}
              className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition"
            >
              {isReplanning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              重排这个时段
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
