import {
  MAX_SELECTION_JOURNEY_PICKS,
  selectionJourneySnapshotSchema,
  type SelectionDecision,
  type SelectionDecisionTrace,
  type SelectionJourneySnapshot,
  type SelectionJourneyStage
} from '../../shared/selection.js';
import type { SelectionReasonCode as PolicySelectionReasonCode } from '../music-agent/selection-policy/types.js';

export type SelectionJourneyCandidateFact = {
  id: string;
  name: string;
  artist: string;
  selectionReason?: string;
};

const STAGES: Array<{
  stage: SelectionJourneyStage;
  title: string;
  traceStages: SelectionDecision['stage'][];
  idleDetail: string;
}> = [
  {
    stage: 'understanding',
    title: '理解这一轮',
    traceStages: [],
    idleDetail: '先确认这一轮的目标和必须遵守的边界。'
  },
  {
    stage: 'recall',
    title: '寻找候选',
    traceStages: ['recall'],
    idleDetail: '从可用来源里寻找合适的候选曲目。'
  },
  {
    stage: 'filtering',
    title: '检查候选',
    traceStages: ['admission', 'ranking'],
    idleDetail: '检查播放资格、明确排除和近期反馈。'
  },
  {
    stage: 'balancing',
    title: '搭配这一轮',
    traceStages: ['batch'],
    idleDetail: '在连贯感和变化之间做整体搭配。'
  },
  {
    stage: 'finalizing',
    title: '确定选择',
    traceStages: ['final'],
    idleDetail: '完成最后校验并确定加入队列的曲目。'
  }
];

export const PUBLIC_SELECTION_REASON_COPY = {
  invalid_track_identity: '曲目信息不完整，暂时不加入这一轮。',
  copyright_unavailable: '当前版权状态不支持可靠播放，暂时不加入这一轮。',
  privilege_unavailable: '当前账号暂时无法播放这首歌。',
  privilege_notice: '这首歌当前有播放限制提示，暂时不加入这一轮。',
  admission_eligible: '候选通过了播放资格和明确排除检查。',
  explicit_request_soft_bypass: '这是你本轮明确点选的音乐，因此优先保留。',
  temporary_queue_exclusion: '这首歌仍在近期反馈后的 24 小时缓冲期内，本轮先不重复。',
  retrieval_cooldown: '近期这个搜索方向有效候选较少，本轮先换一条线索。',
  recall_included: '候选进入了这一轮的可选范围。',
  active_directive_match: '符合你当前给 DJ 的方向。',
  expressed_preference_match: '符合你明确表达过的偏好。',
  inferred_preference_match: '符合近期逐渐显现的收听偏好。',
  exposure_track: '这首歌近期已经听过，为其他选择留出空间。',
  exposure_artist: '这位艺人近期出现较多，本轮适当增加变化。',
  early_skip_track: '参考近期较早结束的播放，本轮降低这首歌的排序。',
  early_skip_artist: '参考近期较早结束的播放，本轮降低同艺人的重复。',
  early_skip_track_suppression: '这首歌仍在近期较早结束播放后的缓冲期内，本轮先避开。',
  early_skip_artist_suppression: '这位艺人仍在近期较早结束播放后的缓冲期内，本轮先避开。',
  upcoming_queue_track: '这首歌已出现在接下来的队列里，本轮不重复。',
  upcoming_queue_artist: '这位艺人已在接下来的队列里，本轮适当拉开间隔。',
  batch_primary_artist_repeat: '调整了同一艺人的连续出现，让这一轮更有变化。',
  batch_source_repeat: '调整了候选来源分布，避免这一轮过于单一。',
  batch_title_motif_repeat: '调整了相近标题主题的重复，让这一轮更有变化。',
  retrieval_pressure: '结合近期搜索效果，对候选排序做了软调整。',
  candidate_quality: '结合曲目版本和信息完整度，降低或排除了质量风险较高的候选。',
  semantic_compatibility: '结合歌曲内容与当前方向的契合度完成了排序。',
  trend_match: '这首歌与近期音乐趋势线索相符。',
  ranking_scored: '结合当前目标与近期反馈完成了排序。',
  batch_selected: '在艺人、来源和标题变化之间兼顾了这一轮的整体搭配。',
  final_eligible: '通过最后校验，加入这一轮选择。',
  explicit_track_exclusion: '遵守了你明确设置的曲目排除。',
  explicit_artist_exclusion: '遵守了你明确设置的艺人排除。',
  queue_track_idempotency: '该曲已在当前队列中，不重复加入。',
  queue_target_reached: '这一轮的队列目标已满足，不再重复加入。',
  played_track_idempotency: '该曲已经播放过，本轮不重复加入。'
} satisfies Record<PolicySelectionReasonCode, string>;

export function isPublicSelectionReasonCode(value: string): value is PolicySelectionReasonCode {
  return Object.hasOwn(PUBLIC_SELECTION_REASON_COPY, value);
}

export function publicSelectionReasonCopy(reasonCode: PolicySelectionReasonCode): string {
  return PUBLIC_SELECTION_REASON_COPY[reasonCode];
}

export function sanitizePublicSelectionReason(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const reason = value.replace(/\s+/g, ' ').trim();
  const normalized = reason.normalize('NFKC');
  if (reason.length < 6) return undefined;
  if (/^(?:ranked\s+(?:fallback|backfill|convergence)|fit|ok)$/iu.test(normalized)) {
    return undefined;
  }
  if (/(?:private\s+context|personal_dj_context|currentUserText|activeDirective|sourceRef|private_note|secret|https?:\/\/|[{}])/iu.test(normalized)) {
    return undefined;
  }
  if (/(?:你|用户).{0,12}(?:原话|说过|提到|告诉|分享|透露)|(?:手机号|微信号|住址|经纬度|身份证|真实姓名)/u.test(normalized)) {
    return undefined;
  }
  return reason.slice(0, 300);
}

const SYSTEM_REASON_COPY: Record<string, string> = {
  selection_failed: '这一轮没有得到可安全加入队列的结果。',
};

function publicReason(reasonCode: string): string {
  if (isPublicSelectionReasonCode(reasonCode)) return publicSelectionReasonCopy(reasonCode);
  return SYSTEM_REASON_COPY[reasonCode] ?? '依据当前可公开的选歌条件完成了这一步。';
}

const SELECTION_REASON_PRIORITY: PolicySelectionReasonCode[] = [
  'explicit_request_soft_bypass',
  'active_directive_match',
  'expressed_preference_match',
  'inferred_preference_match',
  'trend_match',
  'semantic_compatibility',
  'batch_selected',
  'final_eligible'
];

const POSITIVE_SELECTION_ACTIONS = new Set<SelectionDecision['action']>([
  'admitted',
  'recalled',
  'promoted',
  'ranked',
  'kept',
  'selected'
]);

function publicSelectionReason(
  decisions: SelectionDecision[],
  finalDecision: SelectionDecision
): string {
  const reasonCodes = new Set(decisions
    .filter((decision) => POSITIVE_SELECTION_ACTIONS.has(decision.action))
    .map((decision) => decision.reasonCode));
  const reasons = SELECTION_REASON_PRIORITY
    .filter((reasonCode) => reasonCodes.has(reasonCode))
    .slice(0, 3)
    .map(publicReason);
  return reasons.length > 0 ? reasons.join(' ') : publicReason(finalDecision.reasonCode);
}

function uniqueReasonCodes(decisions: SelectionDecision[]): string[] {
  return [...new Set(decisions.map((decision) => decision.reasonCode))].slice(0, 8);
}

function currentStageIndex(trace: SelectionDecisionTrace): number {
  let current = 0;
  for (let index = 1; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    if (trace.decisions.some((decision) => stage.traceStages.includes(decision.stage))) {
      current = index;
    }
  }
  return current;
}

export function buildSelectionJourney(input: {
  trace: SelectionDecisionTrace;
  candidates: SelectionJourneyCandidateFact[];
  revision: number;
  status: SelectionJourneySnapshot['status'];
  updatedAt: string;
  journeyVersion?: number;
  narration?: SelectionJourneySnapshot['narration'];
  activeStage?: SelectionJourneyStage;
}): SelectionJourneySnapshot {
  const narration = input.narration?.status === 'pending'
    && (input.status === 'failed' || input.status === 'superseded')
    ? { status: 'failed' as const }
    : input.narration
      ?? (input.status === 'failed' || input.status === 'superseded'
        ? { status: 'failed' as const }
        : { status: 'pending' as const });
  const explicitStageIndex = input.activeStage
    ? STAGES.findIndex((definition) => definition.stage === input.activeStage)
    : -1;
  const currentIndex = explicitStageIndex >= 0 ? explicitStageIndex : currentStageIndex(input.trace);
  const candidatesById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const decisionsByCandidate = new Map<string, SelectionDecision[]>();
  const latestFinalByCandidate = new Map<string, SelectionDecision>();
  for (const decision of input.trace.decisions) {
    if (!decision.candidateId) continue;
    const decisions = decisionsByCandidate.get(decision.candidateId) ?? [];
    decisions.push(decision);
    decisionsByCandidate.set(decision.candidateId, decisions);
    if (decision.stage === 'final') {
      latestFinalByCandidate.set(decision.candidateId, decision);
    }
  }

  const stages = STAGES.map((definition, index) => {
    const decisions = input.trace.decisions.filter((decision) => (
      definition.traceStages.includes(decision.stage)
    ));
    const status = input.status === 'completed'
      ? 'completed' as const
      : input.status === 'superseded'
        ? index <= currentIndex
          ? 'completed' as const
          : 'pending' as const
      : index < currentIndex
        ? 'completed' as const
        : index === currentIndex
          ? 'active' as const
          : 'pending' as const;
    const reasonCodes = uniqueReasonCodes([...decisions].reverse());
    return {
      stage: definition.stage,
      status,
      title: definition.title,
      detail: reasonCodes.length > 0 ? publicReason(reasonCodes[0]) : definition.idleDetail,
      reasonCodes
    };
  });

  const candidates = input.candidates.slice(0, 8).map((candidate) => {
    const decisions = decisionsByCandidate.get(candidate.id) ?? [];
    const latestFinal = latestFinalByCandidate.get(candidate.id);
    const actions = new Set(decisions.map((decision) => decision.action));
    const state = latestFinal?.action === 'selected'
      ? 'selected' as const
      : latestFinal?.action === 'rejected' || latestFinal?.action === 'skipped'
        ? 'excluded' as const
        : actions.has('rejected') || actions.has('suppressed') || actions.has('skipped')
        ? 'excluded' as const
        : 'considering' as const;
    return { id: candidate.id, name: candidate.name, artist: candidate.artist, state };
  });

  const selections = [...latestFinalByCandidate.values()]
    .filter((decision) => decision.action === 'selected')
    .flatMap((decision) => {
      if (!decision.candidateId) return [];
      const candidate = candidatesById.get(decision.candidateId);
      if (!candidate) return [];
      return [{
        trackId: candidate.id,
        trackName: candidate.name,
        artist: candidate.artist,
        reason: sanitizePublicSelectionReason(candidate.selectionReason)
          ?? publicSelectionReason(decisionsByCandidate.get(decision.candidateId) ?? [], decision)
      }];
    })
    .slice(0, MAX_SELECTION_JOURNEY_PICKS);

  return selectionJourneySnapshotSchema.parse({
    schemaVersion: 1,
    runId: input.trace.runId,
    journeyVersion: input.journeyVersion ?? 1,
    revision: input.revision,
    status: input.status,
    summary: input.status === 'running'
      ? '正在从可用曲目里寻找这轮最合适的选择。'
      : input.status === 'completed'
        ? '这一轮已经选好，下面是这次选择的主要依据。'
        : input.status === 'superseded'
          ? '队列已经发生变化，这一轮不再追加，避免覆盖你刚刚的选择。'
        : '这一轮没有完成，已保留目前可公开的选歌过程。',
    startedAt: input.trace.createdAt,
    updatedAt: input.updatedAt,
    ...(input.status === 'completed' || input.status === 'failed' || input.status === 'superseded'
      ? { completedAt: input.updatedAt }
      : {}),
    stages,
    candidates,
    selections,
    narration
  });
}
