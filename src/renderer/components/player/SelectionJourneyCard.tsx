import React from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  LoaderCircle,
  Music2
} from 'lucide-react';
import type { SelectionJourneySnapshot } from '@shared/selection';
import type { DiscoveryMode } from '@shared/dj';

export function SelectionJourneyCard({
  journey,
  expanded,
  historyPosition = 0,
  historyTotal = 1,
  mode,
  onNewer,
  onOlder,
  onToggle
}: {
  journey: SelectionJourneySnapshot;
  expanded: boolean;
  historyPosition?: number;
  historyTotal?: number;
  mode: DiscoveryMode;
  onNewer?(): void;
  onOlder?(): void;
  onToggle(): void;
}): JSX.Element {
  // 与播放器模式色对齐：探索 cyan / 舒适区 orange；violet 固定留给 AI 手记
  const tone = mode === 'explore'
    ? {
        border: 'border-cyan-200/15',
        heading: 'text-cyan-100',
        activeDot: 'bg-cyan-300',
        selectedPill: 'border-cyan-300/40 bg-cyan-400/10 text-cyan-100',
        pickCard: 'border-cyan-300/15 bg-cyan-950/15',
        pickText: 'text-cyan-100',
        pickReason: 'text-cyan-100/70'
      }
    : {
        border: 'border-orange-200/15',
        heading: 'text-orange-100',
        activeDot: 'bg-orange-300',
        selectedPill: 'border-orange-300/40 bg-orange-400/10 text-orange-100',
        pickCard: 'border-orange-300/15 bg-orange-950/20',
        pickText: 'text-orange-100',
        pickReason: 'text-orange-100/70'
      };
  return (
    <section className={`rounded-xl border bg-slate-950/48 p-4 ${tone.border}`} aria-label="选歌过程">
      <button
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span className={`inline-flex items-center gap-2 text-sm font-semibold ${tone.heading}`}>
            {journey.status === 'running'
              ? <LoaderCircle className="h-4 w-4 animate-spin" />
              : <CircleCheck className="h-4 w-4" />}
            这轮为什么这样选
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{journey.summary}</span>
        </span>
        {expanded
          ? <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
          : <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />}
      </button>

      {expanded ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
              <span>最近 24 小时</span>
              <span aria-hidden="true" className="h-3 w-px bg-white/10" />
              <span>第 {historyPosition + 1} / {historyTotal} 轮</span>
              <span aria-hidden="true" className="h-3 w-px bg-white/10" />
              <span>
                {new Intl.DateTimeFormat('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                }).format(new Date(journey.startedAt))}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              <button
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 disabled:opacity-30"
                disabled={historyPosition <= 0}
                onClick={onNewer}
                type="button"
              >
                <ChevronLeft className="h-3 w-3" />
                较新一轮
              </button>
              <button
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 disabled:opacity-30"
                disabled={historyPosition >= historyTotal - 1}
                onClick={onOlder}
                type="button"
              >
                更早一轮
                <ChevronRight className="h-3 w-3" />
              </button>
            </span>
          </div>

          <ol className="space-y-2">
            {journey.stages.slice(0, 5).map((stage) => (
              <li className="rounded-lg border border-white/10 bg-black/20 px-3 py-2" key={stage.stage}>
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${stage.status === 'active' ? tone.activeDot : stage.status === 'completed' ? 'bg-emerald-300' : 'bg-zinc-600'}`} />
                  <span className="text-xs font-medium text-zinc-200">{stage.title}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{stage.detail}</p>
              </li>
            ))}
          </ol>

          {journey.candidates.length > 0 ? (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">考虑过的候选</p>
              <div className="flex flex-wrap gap-2">
                {journey.candidates.slice(0, 8).map((candidate) => (
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${candidate.state === 'selected' ? tone.selectedPill : candidate.state === 'excluded' ? 'border-white/5 text-zinc-600 line-through' : 'border-white/10 text-zinc-400'}`}
                    key={candidate.id}
                  >
                    {candidate.name}{candidate.artist ? ` · ${candidate.artist}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {journey.selections.length > 0 ? (
            <div className="space-y-2">
              {journey.selections.slice(0, 5).map((pick) => (
                <div className={`rounded-lg border px-3 py-2 ${tone.pickCard}`} key={pick.trackId}>
                  <p className={`inline-flex items-center gap-2 text-xs font-medium ${tone.pickText}`}>
                    <Music2 className="h-3.5 w-3.5" />
                    {pick.trackName}{pick.artist ? ` · ${pick.artist}` : ''}
                  </p>
                  <p className={`mt-1 text-xs leading-relaxed ${tone.pickReason}`}>{pick.reason}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-lg border border-violet-300/15 bg-violet-950/15 px-3 py-2">
            <p className="text-[11px] font-medium text-violet-200">DJ 手记</p>
            <p className="mt-1 text-xs leading-relaxed text-violet-100/70">
              {journey.narration.status === 'polished'
                ? journey.narration.text
                : journey.narration.status === 'failed'
                  ? '这次先保留即时选歌说明。'
                  : 'DJ 手记正在润色，完成后会安静地更新在这里。'}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
