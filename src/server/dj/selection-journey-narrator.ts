import { z } from 'zod';
import type { LlmCompleteOptions, LlmMessage, LlmResponse } from '../llm/client.js';
import {
  MAX_SELECTION_JOURNEY_PICKS,
  selectionDecisionTraceSchema,
  selectionJourneySnapshotSchema,
  type SelectionDecisionTrace,
  type SelectionJourneySnapshot
} from '../../shared/selection.js';
import {
  isPublicSelectionReasonCode,
  publicSelectionReasonCopy,
  sanitizePublicSelectionReason
} from './selection-journey.js';
import type { SelectionReasonCode } from '../music-agent/selection-policy/types.js';

export const PUBLIC_NARRATION_TONE_TAGS = [
  'warm',
  'playful',
  'calm',
  'crisp',
  'reflective',
  'energetic'
] as const;

const publicToneTags = new Set<string>(PUBLIC_NARRATION_TONE_TAGS);
const narrationTextSchema = z.string().trim().min(1).max(1200);

export const SELECTION_NARRATION_TEMPLATES = [
  'selection_flow',
  'track_spotlight',
  'journey_recap'
] as const;

const narrationPlanSchema = z.object({
  template: z.enum(SELECTION_NARRATION_TEMPLATES),
  tone: z.enum(PUBLIC_NARRATION_TONE_TAGS),
  selections: z.array(z.object({
    entityId: z.string().trim().min(1).max(300),
    reasonCodes: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
    reasonText: z.string().trim().min(6).max(120)
  }).strict()).min(1).max(MAX_SELECTION_JOURNEY_PICKS),
  runReasonCodes: z.array(z.string().trim().min(1).max(200)).max(4)
}).strict().superRefine((plan, context) => {
  if (new Set(plan.selections.map((selection) => selection.entityId)).size !== plan.selections.length) {
    context.addIssue({ code: 'custom', message: 'duplicate entityIds' });
  }
  for (const selection of plan.selections) {
    if (new Set(selection.reasonCodes).size !== selection.reasonCodes.length) {
      context.addIssue({ code: 'custom', message: 'duplicate reasonCodes' });
    }
  }
  if (
    new Set(plan.selections.map((selection) => narrationReasonDedupeKey(selection.reasonText))).size
    !== plan.selections.length
  ) {
    context.addIssue({ code: 'custom', message: 'duplicate reasonTexts' });
  }
  if (new Set(plan.runReasonCodes).size !== plan.runReasonCodes.length) {
    context.addIssue({ code: 'custom', message: 'duplicate runReasonCodes' });
  }
});

export type SelectionJourneyNarrationPlan = z.infer<typeof narrationPlanSchema>;

export type SelectionNarrationEntity = {
  id: string;
  name: string;
  artist: string;
};

export type SelectionJourneyNarrationFacts = {
  runId: string;
  journeyVersion: number;
  summary: string;
  djPersona: string;
  toneTags: string[];
  selectionReasonOptions: Array<{ entityId: string; allowedReasonCodes: SelectionReasonCode[] }>;
  runReasonCodes: SelectionReasonCode[];
  stages: SelectionJourneySnapshot['stages'];
  candidates: SelectionJourneySnapshot['candidates'];
  selections: SelectionJourneySnapshot['selections'];
};

const NARRATABLE_SELECTION_ACTIONS = new Set([
  'admitted',
  'recalled',
  'promoted',
  'ranked',
  'selected'
]);

// These reasons describe the whole completed batch when the Trace records them
// without a candidateId. Candidate-scoped occurrences never cross entities.
const NARRATABLE_RUN_REASON_CODES = new Set<SelectionReasonCode>([
  'batch_selected',
  'queue_target_reached'
]);

const PROCEDURAL_NARRATION_REASON_CODES = [
  'admission_eligible',
  'recall_included',
  'ranking_scored',
  'batch_selected',
  'final_eligible'
] as const satisfies readonly SelectionReasonCode[];

export type SelectionJourneyNarrationClient = {
  complete(messages: LlmMessage[], options?: LlmCompleteOptions): Promise<LlmResponse>;
};

export function buildSelectionJourneyNarrationFacts(input: {
  journey: SelectionJourneySnapshot;
  trace: SelectionDecisionTrace;
  djPersona: string;
  toneTags: string[];
  entityWhitelist: SelectionNarrationEntity[];
}): SelectionJourneyNarrationFacts {
  const journey = selectionJourneySnapshotSchema.parse(input.journey);
  const trace = selectionDecisionTraceSchema.parse(input.trace);
  if (journey.runId !== trace.runId) throw new Error('narration_trace_run_mismatch');

  const whitelist = new Map(input.entityWhitelist.map((entity) => [entity.id, entity]));
  for (const candidate of journey.candidates) {
    assertWhitelistedEntity(candidate.id, candidate.name, candidate.artist, whitelist);
  }
  for (const selection of journey.selections) {
    assertWhitelistedEntity(selection.trackId, selection.trackName, selection.artist, whitelist);
    if (!trace.decisions.some((decision) => (
      decision.stage === 'final'
      && decision.action === 'selected'
      && decision.candidateId === selection.trackId
    ))) {
      throw new Error('narration_selection_not_in_trace');
    }
  }

  const traceReasons = new Set(trace.decisions.map((decision) => decision.reasonCode));
  for (const reasonCode of journey.stages.flatMap((stage) => stage.reasonCodes)) {
    if (!traceReasons.has(reasonCode)) throw new Error('narration_reason_not_in_trace');
  }

  const selectionReasonOptions = journey.selections.map((selection) => ({
    entityId: selection.trackId,
    allowedReasonCodes: [...new Set(trace.decisions.flatMap((decision) => (
      decision.candidateId === selection.trackId
      && NARRATABLE_SELECTION_ACTIONS.has(decision.action)
      && isPublicSelectionReasonCode(decision.reasonCode)
        ? [decision.reasonCode]
        : []
    )))]
  }));
  const runReasonCodes = [...new Set(trace.decisions.flatMap((decision) => (
    decision.candidateId === undefined
      && isPublicSelectionReasonCode(decision.reasonCode)
      && NARRATABLE_RUN_REASON_CODES.has(decision.reasonCode)
      ? [decision.reasonCode]
      : []
  )))];

  return {
    runId: journey.runId,
    journeyVersion: journey.journeyVersion,
    summary: journey.summary,
    djPersona: input.djPersona.trim().slice(0, 4_000),
    toneTags: [...new Set(input.toneTags.filter((tag) => publicToneTags.has(tag)))].slice(0, 6),
    selectionReasonOptions,
    runReasonCodes,
    stages: structuredClone(journey.stages),
    candidates: structuredClone(journey.candidates),
    selections: structuredClone(journey.selections)
  };
}

export async function narrateSelectionJourney(input: {
  client: SelectionJourneyNarrationClient;
  journey: SelectionJourneySnapshot;
  trace: SelectionDecisionTrace;
  djPersona: string;
  toneTags: string[];
  entityWhitelist: SelectionNarrationEntity[];
  signal?: AbortSignal;
}): Promise<string> {
  const facts = buildSelectionJourneyNarrationFacts(input);
  const response = await input.client.complete(buildNarrationMessages(facts), {
    temperature: 0.7,
    maxTokens: 800,
    responseFormat: { type: 'json_object' },
    thinking: { type: 'disabled' },
    signal: input.signal
  });
  const plan = parseNarrationPlan(response.content);
  validateNarrationPlan(plan, facts);
  const rendered = narrationTextSchema.safeParse(renderNarrationPlan(plan, facts));
  if (!rendered.success) throw new Error('invalid_narration_plan');
  return rendered.data;
}

function buildNarrationMessages(facts: SelectionJourneyNarrationFacts): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 Crossfadio 的 DJ 手记编辑。',
        '你只负责从受控选项中编排一份手记计划，正文由服务端渲染。',
        `template 只能是：${SELECTION_NARRATION_TEMPLATES.join(', ')}。`,
        `tone 只能是：${PUBLIC_NARRATION_TONE_TAGS.join(', ')}。`,
        `selections 必须包含 1 到 ${MAX_SELECTION_JOURNEY_PICKS} 首本轮实际选择的歌曲。`,
        '输出 selections 必须逐一覆盖输入 selections 中的全部歌曲，不得遗漏。',
        'selections[].entityId 只能选择 selectionReasonOptions 中真实存在的 entityId。',
        '每个 selections[].reasonCodes 只能选择同一 entityId 的 allowedReasonCodes，不能跨歌曲借用理由。',
        '每个 selections[].reasonText 必须用简体中文忠实改写对应 selections[].reason，只保留具体音乐特征、当下场景和队列衔接信息。',
        '不同歌曲的 reasonText 必须分别依据各自理由撰写，不得复用同一句万能文案。',
        'reasonCodes 只用于事实溯源；不得把“进入候选、完成排序、通过校验”等流程状态冒充 reasonText。',
        'runReasonCodes 只能选择顶层 runReasonCodes 列表中的原值。',
        '只输出严格 JSON：{"template":"...","tone":"...","selections":[{"entityId":"...","reasonCodes":["..."],"reasonText":"..."}],"runReasonCodes":[]}。',
        '不得输出自由文本、额外字段、实体名称、生活信息或推理过程。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(facts)
    }
  ];
}

function parseNarrationPlan(content: string): SelectionJourneyNarrationPlan {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new Error('invalid_narration_plan');
  }
  const parsed = narrationPlanSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid_narration_plan');
  return parsed.data;
}

function validateNarrationPlan(
  plan: SelectionJourneyNarrationPlan,
  facts: SelectionJourneyNarrationFacts
): void {
  const allowedReasonsByEntity = new Map(facts.selectionReasonOptions.map((option) => (
    [option.entityId, new Set(option.allowedReasonCodes)]
  )));
  for (const selection of plan.selections) {
    const allowedReasons = allowedReasonsByEntity.get(selection.entityId);
    if (!allowedReasons) throw new Error('narration_entity_not_whitelisted');
    if (selection.reasonCodes.some((reasonCode) => (
      !isPublicSelectionReasonCode(reasonCode) || !allowedReasons.has(reasonCode)
    ))) {
      throw new Error('narration_reason_not_allowed_for_entity');
    }
    if (
      !sanitizePublicSelectionReason(selection.reasonText)
      || !isChineseNarrationReason(selection.reasonText)
      || isProceduralOnlyNarrationReason(selection.reasonText)
    ) {
      throw new Error('invalid_narration_text');
    }
  }
  if (plan.selections.length !== facts.selections.length) {
    throw new Error('invalid_narration_plan');
  }
  const allowedRunReasons = new Set(facts.runReasonCodes);
  if (plan.runReasonCodes.some((reasonCode) => (
    !isPublicSelectionReasonCode(reasonCode) || !allowedRunReasons.has(reasonCode)
  ))) {
    throw new Error('narration_run_reason_not_allowed');
  }
}

function renderNarrationPlan(
  plan: SelectionJourneyNarrationPlan,
  facts: SelectionJourneyNarrationFacts
): string {
  const selectionById = new Map(facts.selections.map((selection) => [selection.trackId, selection]));
  const selectedFacts = plan.selections.map((plannedSelection) => {
    const selection = selectionById.get(plannedSelection.entityId)!;
    return {
      selection,
      reasonText: trimNarrationReasonPunctuation(plannedSelection.reasonText)
    };
  });
  const entities = selectedFacts.map(({ selection }) => {
    return `「${selection.trackName}」${selection.artist ? `— ${selection.artist}` : ''}`;
  });
  const entityText = entities.join('、');
  const reasonText = renderNarrationReasons(selectedFacts, plan.runReasonCodes);

  if (plan.template === 'track_spotlight') {
    return `${toneLead(plan.tone)}${entities[0]}放到这一轮的中心。${reasonText}，接下来让它带着队列继续往前。`;
  }
  if (plan.template === 'journey_recap') {
    return `从候选一路筛到最后，这轮留下了${entityText}。${reasonText}，这就是这次选择想保留的听感。`;
  }
  return `${toneLead(plan.tone)}${entityText}自然地接进队列。${reasonText}，希望这一段既顺耳，也保留一点被认真挑过的惊喜。`;
}

function renderNarrationReasons(
  selections: Array<{
    selection: SelectionJourneySnapshot['selections'][number];
    reasonText: string;
  }>,
  runReasonCodes: string[]
): string {
  const selectionText = selections.length === 1
    ? selections[0]!.reasonText
    : selections.map(({ selection, reasonText }) => (
      `「${selection.trackName}」是因为${reasonText}`
    )).join('；');
  const runText = renderReasonCodes(runReasonCodes);
  return [selectionText, runText].filter(Boolean).join('，同时');
}

function toneLead(tone: SelectionJourneyNarrationPlan['tone']): string {
  return ({
    warm: '这轮想把',
    playful: '这轮就把',
    calm: '这轮会把',
    crisp: '这轮把',
    reflective: '回看这一轮，我把',
    energetic: '这轮先把'
  } as const)[tone];
}

function renderReasonCodes(reasonCodes: string[]): string {
  const phrases = reasonCodes.flatMap((reasonCode) => (
    isPublicSelectionReasonCode(reasonCode)
      ? [publicSelectionReasonCopy(reasonCode).replace(/[。！？!?]+$/u, '')]
      : []
  ));
  return [...new Set(phrases)].slice(0, 2).join('，也');
}

function narrationReasonDedupeKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[\s。！？!?，,；;：:、]+/gu, '');
}

function trimNarrationReasonPunctuation(value: string): string {
  return value.replace(/[。！？!?，,；;：:]+$/u, '');
}

function isChineseNarrationReason(value: string): boolean {
  return (value.match(/\p{Script=Han}/gu)?.length ?? 0) >= 4;
}

function isProceduralOnlyNarrationReason(value: string): boolean {
  let remaining = narrationReasonDedupeKey(value);
  for (const reasonCode of PROCEDURAL_NARRATION_REASON_CODES) {
    remaining = remaining.replaceAll(
      narrationReasonDedupeKey(publicSelectionReasonCopy(reasonCode)),
      ''
    );
  }
  remaining = remaining.replace(/(?:因为|也|同时|并且|以及|所以|这首歌|本轮|这一轮)+/gu, '');
  return remaining.length === 0;
}

function assertWhitelistedEntity(
  id: string,
  name: string,
  artist: string,
  whitelist: Map<string, SelectionNarrationEntity>
): void {
  const allowed = whitelist.get(id);
  if (!allowed || allowed.name !== name || allowed.artist !== artist) {
    throw new Error('narration_entity_not_whitelisted');
  }
}
