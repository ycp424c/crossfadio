import {
  chatDjMemoryProjectionSchema,
  selectionDjMemoryProjectionSchema,
  segueDjMemoryProjectionSchema,
  type DjMemoryProjectionFact,
  type SelectionDjMemoryProjection
} from '../../shared/dj-memory.js';
import {
  musicAgentRuntimeContextSchema,
  type MusicAgentRuntimeContext
} from '../music-agent/schema.js';
import type { DjMemorySnapshot } from './schema.js';

type ProjectionBudget = { maxFacts?: number; maxStringLength?: number };
type MusicAgentPersonalContext = NonNullable<MusicAgentRuntimeContext['personalDjContext']>;

const CHAT_RESERVED_FACT_KEYS = [
  'active_directive',
  'discovery_mode',
  'daily_theme',
  'current_moment',
  'weather'
] as const;

const SELECTION_RESERVED_FACT_KEYS = [
  'active_directive',
  'personal_context_summary',
  'personal_activity',
  'personal_energy',
  'personal_attention',
  'personal_mood',
  'personal_preferred_textures',
  'personal_avoid_textures',
  'personal_energy_curve',
  'personal_vocal_preference',
  'personal_novelty',
  'personal_music_hint',
  'discovery_mode',
  'daily_theme',
  'current_moment',
  'weather'
] as const;

const SEGUE_RESERVED_FACT_KEYS = [
  'segue_privacy_rule',
  'segue_tone',
  'daily_theme',
  'current_moment',
  'weather'
] as const;

export function projectDjMemoryForChat(snapshot: DjMemorySnapshot, budget: ProjectionBudget = {}) {
  return chatDjMemoryProjectionSchema.parse(base(snapshot, 'chat', trimFacts([
    ...directiveFacts(snapshot),
    ...selectionContextFacts(snapshot),
    ...preferenceFacts(snapshot),
    ...tasteFacts(snapshot),
    ...queueFacts(snapshot),
    ...configurationFacts(snapshot),
    ...sessionFacts(snapshot, new Set(['request_summary', 'queue_action'])),
    ...momentFacts(snapshot)
  ], budget, 48, CHAT_RESERVED_FACT_KEYS)));
}

export function projectDjMemoryForSelection(snapshot: DjMemorySnapshot, budget: ProjectionBudget = {}) {
  return selectionDjMemoryProjectionSchema.parse(base(snapshot, 'selection', trimFacts([
    ...explicitExclusionFacts(snapshot),
    ...temporaryExclusionFacts(snapshot),
    ...directiveFacts(snapshot),
    ...personalContextMusicFacts(snapshot),
    ...selectionContextFacts(snapshot),
    ...preferenceFacts(snapshot),
    ...episodeFacts(snapshot),
    ...tasteFacts(snapshot),
    ...queueFacts(snapshot),
    ...retrievalFacts(snapshot),
    ...configurationFacts(snapshot),
    ...sessionFacts(snapshot, new Set(['request_summary', 'selection_reason'])),
    ...momentFacts(snapshot)
  ], budget, 96, SELECTION_RESERVED_FACT_KEYS)));
}

export function projectDjMemoryForSegue(snapshot: DjMemorySnapshot, budget: ProjectionBudget = {}) {
  return segueDjMemoryProjectionSchema.parse(base(snapshot, 'segue', trimFacts([
    ...personalContextSegueFacts(snapshot),
    ...queueFacts(snapshot),
    ...configurationFacts(snapshot),
    ...sessionFacts(snapshot, new Set(['selection_reason', 'segue_summary'])),
    ...momentFacts(snapshot)
  ], budget, 32, SEGUE_RESERVED_FACT_KEYS)));
}

export function projectDjMemoryToMusicAgentRuntime(
  projection: SelectionDjMemoryProjection,
  input: {
    request: MusicAgentRuntimeContext['request'];
    userText?: string;
    actionQueries?: string[];
  }
): MusicAgentRuntimeContext {
  const parsed = selectionDjMemoryProjectionSchema.parse(projection);
  const factsByKey = new Map<string, DjMemoryProjectionFact[]>();
  for (const fact of parsed.facts) {
    const facts = factsByKey.get(fact.key) ?? [];
    facts.push(fact);
    factsByKey.set(fact.key, facts);
  }
  const currentMoment = stringValue(factsByKey.get('current_moment')?.[0]);
  const [daypart = '', ...localTimeParts] = currentMoment.split(/\s+/);
  const personalSummary = stringValue(factsByKey.get('personal_context_summary')?.[0]);
  const preferredTextures = arrayValue(factsByKey.get('personal_preferred_textures')?.[0]);
  const avoidTextures = arrayValue(factsByKey.get('personal_avoid_textures')?.[0]);
  const energyCurve = enumValue(
    stringValue(factsByKey.get('personal_energy_curve')?.[0]),
    ['downshift', 'steady', 'uplift', 'mixed'] as const
  );
  const vocalPreference = enumValue(
    stringValue(factsByKey.get('personal_vocal_preference')?.[0]),
    ['vocal', 'instrumental', 'mixed', 'unknown'] as const
  );
  const novelty = enumValue(
    stringValue(factsByKey.get('personal_novelty')?.[0]),
    ['comfort', 'balanced', 'explore'] as const
  );
  const activity = stringValue(factsByKey.get('personal_activity')?.[0]);
  const energy = enumValue(
    stringValue(factsByKey.get('personal_energy')?.[0]),
    ['low', 'medium', 'high'] as const
  );
  const attention = enumValue(
    stringValue(factsByKey.get('personal_attention')?.[0]),
    ['low_distraction', 'normal', 'high_stimulation'] as const
  );
  const mood = stringValue(factsByKey.get('personal_mood')?.[0]);
  const currentState = {
    ...(activity ? { activity } : {}),
    ...(energy ? { energy } : {}),
    ...(attention ? { attention } : {}),
    ...(mood ? { mood } : {})
  };
  const musicHints = (factsByKey.get('personal_music_hint') ?? [])
    .map(musicHintFromFact)
    .filter((hint): hint is MusicAgentPersonalContext['musicHints'][number] => hint !== null);
  const discoveryMode = enumValue(
    stringValue(factsByKey.get('discovery_mode')?.[0]),
    ['explore', 'comfort'] as const
  ) ?? 'explore';
  const dailyThemeParts = arrayValue(factsByKey.get('daily_theme')?.[0]);
  const dailyTheme = dailyThemeParts.length > 0
    ? `${dailyThemeParts[0]}${dailyThemeParts.length > 1 ? `（${dailyThemeParts.slice(1).join('、')}）` : ''}`
    : '';
  const actionQueries = Array.from(new Set(
    (input.actionQueries ?? []).map((query) => compact(query, 160)).filter(Boolean)
  )).slice(0, 6);

  return musicAgentRuntimeContextSchema.parse({
    request: input.request,
    discoveryMode,
    currentUserText: input.request === 'chat-recommend' ? compact(input.userText ?? '', 600) : '',
    ...(actionQueries.length > 0 ? { actionQueries } : {}),
    currentMoment: {
      localTime: localTimeParts.join(' ') || parsed.assembledAt,
      daypart,
      weather: stringValue(factsByKey.get('weather')?.[0]) || null,
      ...(dailyTheme ? { dailyTheme } : {})
    },
    activeDirective: stringValue(factsByKey.get('active_directive')?.[0]),
    tasteSummary: joinFactValues(factsByKey.get('taste_profile'), 900),
    recentPreferenceSummary: joinFactsWithEntity(factsByKey.get('preference_evidence'), 600),
    recentPlaySignals: joinFactsWithEntity(factsByKey.get('listening_episode'), 700),
    queueStateSummary: joinFactsWithEntity([
      ...(factsByKey.get('current_track') ?? []),
      ...(factsByKey.get('upcoming_track') ?? [])
    ], 700),
    ...(personalSummary ? {
      personalDjContext: {
        summary: personalSummary,
        ...(Object.keys(currentState).length > 0 ? { currentState } : {}),
        musicGuidance: {
          preferredTextures,
          avoidTextures,
          ...(energyCurve ? { energyCurve } : {}),
          ...(vocalPreference ? { vocalPreference } : {}),
          ...(novelty ? { novelty } : {})
        },
        musicHints,
        segueGuidance: { privacyRule: '' },
        trend: []
      }
    } : {}),
    bannedSummary: joinFactsWithEntity([
      ...(factsByKey.get('explicit_exclusion') ?? []),
      ...(factsByKey.get('temporary_queue_exclusion') ?? [])
    ], 600)
  });
}

function base(snapshot: DjMemorySnapshot, purpose: 'chat' | 'selection' | 'segue', facts: DjMemoryProjectionFact[]) {
  return {
    schemaVersion: 1 as const,
    snapshotId: snapshot.metadata.snapshotId,
    assembledAt: snapshot.metadata.assembledAt,
    sources: snapshot.metadata.sources,
    purpose,
    facts
  };
}

function queueFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  const facts: DjMemoryProjectionFact[] = [];
  if (snapshot.queue.currentTrack) facts.push(trackFact('current_track', snapshot.queue.currentTrack));
  for (const track of snapshot.queue.upcoming) facts.push(trackFact('upcoming_track', track));
  return facts;
}

function trackFact(key: 'current_track' | 'upcoming_track', track: DjMemorySnapshot['queue']['upcoming'][number]): DjMemoryProjectionFact {
  return {
    key,
    value: [track.name, ...track.artists].filter(Boolean),
    entity: { type: 'track', key: track.id, ...(track.name ? { label: track.name } : {}) },
    sourceId: 'queue'
  };
}

function directiveFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.activeDirective ? [{
    key: 'active_directive', value: snapshot.activeDirective.text, sourceId: 'active_directive',
    expiresAt: snapshot.activeDirective.expiresAt
  }] : [];
}

function selectionContextFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return [{
    key: 'discovery_mode',
    value: snapshot.selectionContext.discoveryMode,
    sourceId: 'selection_context'
  }];
}

function explicitExclusionFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.explicitExclusions.map((item) => ({
    key: 'explicit_exclusion',
    value: item.displayName ?? item.entityKey,
    entity: { type: item.entityType, key: item.entityKey, ...(item.displayName ? { label: item.displayName } : {}) },
    sourceId: item.id
  }));
}

function temporaryExclusionFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.temporaryExclusions.map((item) => ({
    key: 'temporary_queue_exclusion', value: [item.name, ...item.artists].filter(Boolean),
    entity: { type: 'track', key: item.id, ...(item.name ? { label: item.name } : {}) },
    sourceId: item.id, expiresAt: item.expiresAt
  }));
}

function episodeFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.listeningEpisodes.map((item) => ({
    key: 'listening_episode',
    value: `${item.outcome ?? 'open'}:${item.listenedMs}/${item.durationMs ?? 'unknown'}`,
    entity: { type: 'track', key: item.trackId, label: item.trackName },
    sourceId: item.id,
    observedAt: item.startedAt
  }));
}

function preferenceFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.preferences.map((item) => ({
    key: 'preference_evidence', value: `${item.polarity}:${item.kind}:${item.score}`,
    entity: { type: item.subjectType, key: item.subjectKey },
    sourceId: item.id, observedAt: item.observedAt
  }));
}

function tasteFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.tasteProfile ? [{
    key: 'taste_profile', value: snapshot.tasteProfile.summary, sourceId: snapshot.tasteProfile.id,
    observedAt: snapshot.tasteProfile.generatedAt
  }] : [];
}

function personalContextMusicFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  const context = snapshot.personalContext;
  if (!context) return [];
  const fact = (key: string, value: DjMemoryProjectionFact['value']): DjMemoryProjectionFact => ({
    key,
    value,
    sourceId: context.id,
    expiresAt: context.expiresAt
  });
  const currentState = context.currentState;
  return [
    fact('personal_context_summary', context.summary),
    ...(currentState.activity ? [fact('personal_activity', currentState.activity)] : []),
    ...(currentState.energy ? [fact('personal_energy', currentState.energy)] : []),
    ...(currentState.attention ? [fact('personal_attention', currentState.attention)] : []),
    ...(currentState.mood ? [fact('personal_mood', currentState.mood)] : []),
    fact('personal_preferred_textures', context.musicGuidance.preferredTextures ?? []),
    fact('personal_avoid_textures', context.musicGuidance.avoidTextures ?? []),
    ...(context.musicGuidance.energyCurve
      ? [fact('personal_energy_curve', context.musicGuidance.energyCurve)]
      : []),
    ...(context.musicGuidance.vocalPreference
      ? [fact('personal_vocal_preference', context.musicGuidance.vocalPreference)]
      : []),
    ...(context.musicGuidance.novelty
      ? [fact('personal_novelty', context.musicGuidance.novelty)]
      : []),
    ...context.musicHints.map((hint) => fact('personal_music_hint', [
      hint.kind,
      hint.label,
      hint.strength,
      hint.reason
    ]))
  ];
}

function personalContextSegueFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  const context = snapshot.personalContext;
  if (!context) return [];
  return [
    ...(context.segueGuidance.tone ? [{
      key: 'segue_tone', value: context.segueGuidance.tone, sourceId: context.id, expiresAt: context.expiresAt
    } satisfies DjMemoryProjectionFact] : []),
    {
      key: 'segue_privacy_rule', value: context.segueGuidance.privacyRule,
      sourceId: context.id, expiresAt: context.expiresAt
    }
  ];
}

function retrievalFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.retrievalHistory.map((item, index) => ({
    key: 'retrieval_attempt', value: `${item.query}:${item.selectedCount}`,
    sourceId: `retrieval:${index}`, observedAt: item.attemptedAt
  }));
}

function configurationFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return snapshot.configuration.flatMap((item) => {
    const value = serializeCompact(item.value);
    return value ? [{ key: 'dj_configuration', value, sourceId: item.id }] : [];
  });
}

function sessionFacts(snapshot: DjMemorySnapshot, kinds: Set<string>): DjMemoryProjectionFact[] {
  return snapshot.sessionLog.filter((item) => kinds.has(item.kind)).map((item) => ({
    key: 'session_continuity', value: item.text, sourceId: item.id, observedAt: item.occurredAt
  }));
}

function momentFacts(snapshot: DjMemorySnapshot): DjMemoryProjectionFact[] {
  return [
    { key: 'current_moment', value: `${snapshot.currentMoment.daypart} ${snapshot.currentMoment.localTime}`, sourceId: 'current_moment' },
    ...(snapshot.selectionContext.dailyTheme ? [{
      key: 'daily_theme',
      value: [
        snapshot.selectionContext.dailyTheme.theme,
        ...snapshot.selectionContext.dailyTheme.keywords
      ],
      sourceId: 'daily_theme'
    } satisfies DjMemoryProjectionFact] : []),
    ...(snapshot.weather ? [{
      key: 'weather', value: `${snapshot.weather.tempC}°C ${snapshot.weather.desc}`, sourceId: 'weather'
    } satisfies DjMemoryProjectionFact] : [])
  ];
}

function trimFacts(
  facts: DjMemoryProjectionFact[],
  budget: ProjectionBudget,
  schemaMax: number,
  reservedKeys: readonly string[] = []
): DjMemoryProjectionFact[] {
  const maxFacts = Math.max(0, Math.min(budget.maxFacts ?? schemaMax, schemaMax));
  const maxStringLength = Math.max(1, Math.min(budget.maxStringLength ?? 1000, 1000));
  const reservedIndexes = new Set<number>();
  const reservedFacts: DjMemoryProjectionFact[] = [];
  for (const key of reservedKeys) {
    facts.forEach((fact, index) => {
      if (fact.key !== key || reservedIndexes.has(index)) return;
      reservedIndexes.add(index);
      reservedFacts.push(fact);
    });
  }
  const prioritizedFacts = [
    ...reservedFacts,
    ...facts.filter((_fact, index) => !reservedIndexes.has(index))
  ];
  return prioritizedFacts.slice(0, maxFacts).map((fact) => ({
    ...fact,
    ...(typeof fact.value === 'string' ? { value: fact.value.slice(0, maxStringLength) } : {}),
    ...(Array.isArray(fact.value) ? {
      value: fact.value.slice(0, 20).map((value) => value.slice(0, Math.min(maxStringLength, 300)))
    } : {})
  }));
}

function serializeCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return ''; }
}

function stringValue(fact: DjMemoryProjectionFact | undefined): string {
  if (!fact || fact.value === undefined || fact.value === null) return '';
  return typeof fact.value === 'string' ? fact.value : Array.isArray(fact.value)
    ? fact.value.join(' ')
    : String(fact.value);
}

function arrayValue(fact: DjMemoryProjectionFact | undefined): string[] {
  return fact && Array.isArray(fact.value) ? fact.value : [];
}

function musicHintFromFact(
  fact: DjMemoryProjectionFact
): MusicAgentPersonalContext['musicHints'][number] | null {
  const [kind, label, strength, reason] = arrayValue(fact);
  const parsedKind = enumValue(kind ?? '', ['artist', 'track', 'style', 'scene'] as const);
  const parsedStrength = enumValue(strength ?? '', ['weak', 'medium', 'strong'] as const);
  if (!parsedKind || !label || !parsedStrength || !reason) return null;
  return { kind: parsedKind, label, strength: parsedStrength, reason };
}

function joinFactValues(facts: DjMemoryProjectionFact[] | undefined, maxLength: number): string {
  return compact((facts ?? []).map(stringValue).filter(Boolean).join('\n'), maxLength);
}

function joinFactsWithEntity(facts: DjMemoryProjectionFact[] | undefined, maxLength: number): string {
  return compact((facts ?? []).map((fact) => [
    fact.entity?.key,
    fact.entity?.label,
    stringValue(fact)
  ].filter(Boolean).join(':')).join('\n'), maxLength);
}

function compact(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function enumValue<const T extends readonly string[]>(value: string, allowed: T): T[number] | undefined {
  return allowed.includes(value) ? value as T[number] : undefined;
}
