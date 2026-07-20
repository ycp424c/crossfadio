import {
  buildTrackExclusionAliases,
  buildTrackExclusionKey,
  createExplicitExclusion,
  exclusionSourceRefSchema,
  normalizeExclusionKey,
  revokeExplicitExclusionsByIdentity,
  type ExclusionSourceRef
} from '../store/explicit-exclusions.js';
import { savePreferenceEvidence } from '../store/preference-evidence.js';
import { createPendingExplicitTrackExclusion } from '../store/explicit-exclusion-resolutions.js';
import { resolveTrackIdentity, type ResolvedTrack } from '../ncm/resolver.js';
import type { NcmClient } from '../ncm/client.js';

export type MusicIntentSubject = {
  type: 'artist' | 'track';
  key: string;
  label: string;
  artist?: string;
};

export type SelectionIntent =
  | {
      type: 'preference_evidence';
      evidenceKind: 'expressed';
      subject: MusicIntentSubject;
      polarity: 'positive' | 'negative';
      strength: 'weak' | 'medium' | 'strong';
      revokeMatchingExclusion: false;
    }
  | {
      type: 'explicit_exclusion';
      subject: MusicIntentSubject;
      revokeMatchingExclusion: false;
    }
  | {
      type: 'explicit_request';
      subject: MusicIntentSubject;
      revokeMatchingExclusion: true;
    }
  | {
      type: 'active_directive';
      text: string;
      revokeMatchingExclusion: false;
    }
  | { type: 'none' };

export function parseSelectionIntent(input: string): SelectionIntent {
  const text = normalizeText(input);
  const reversal = text.match(/^(?:那)?还是放(.+)$/u);
  if (reversal && isGeneralizedTarget(reversal[1])) {
    return {
      type: 'active_directive',
      text,
      revokeMatchingExclusion: false
    };
  }
  if (reversal) {
    const subject = subjectFromLabel(reversal[1]);
    if (subject) {
      return {
        type: 'explicit_request',
        subject,
        revokeMatchingExclusion: true
      };
    }
  }
  const directRequest = text.match(/^(?:请)?(?:帮我)?(?:来|放|听|加)(?:一首|首|一曲)?(.+)$/u);
  if (directRequest && isGeneralizedTarget(directRequest[1])) {
    return {
      type: 'active_directive',
      text,
      revokeMatchingExclusion: false
    };
  }
  if (directRequest) {
    const subject = subjectFromLabel(directRequest[1]);
    if (subject) {
      return {
        type: 'explicit_request',
        subject,
        revokeMatchingExclusion: true
      };
    }
  }
  if (/(?:今天|现在|这会儿|接下来|这次|本次|下午|晚上|今晚|通勤时|工作时|写代码时)/u.test(text)) {
    return {
      type: 'active_directive',
      text,
      revokeMatchingExclusion: false
    };
  }
  const exclusion = text.match(/^(?:请)?(?:不要再放|别再放|屏蔽)(.+)$/u);
  if (exclusion) {
    const subject = subjectFromLabel(exclusion[1]);
    if (subject) {
      return {
        type: 'explicit_exclusion',
        subject,
        revokeMatchingExclusion: false
      };
    }
  }
  const dislike = text.match(/^(?:我)?(?:真的|很|有点)?不喜欢(.+)$/u);
  if (dislike) {
    const subject = subjectFromLabel(dislike[1]);
    if (subject) {
      return {
        type: 'preference_evidence',
        evidenceKind: 'expressed',
        subject,
        polarity: 'negative',
        strength: 'medium',
        revokeMatchingExclusion: false
      };
    }
  }
  return { type: 'none' };
}

export async function applySelectionIntent(input: {
  userId: string;
  text: string;
  sourceRef: ExclusionSourceRef;
  occurredAt?: string;
  ncmClient?: NcmClient;
}): Promise<{
  intent: SelectionIntent;
  revokedExclusionIds: string[];
  createdExclusionId?: string;
  trackResolution?: 'resolved' | 'pending_resolution';
  preferenceEvidenceId?: string;
}> {
  const intent = parseSelectionIntent(input.text);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const sourceRef = exclusionSourceRefSchema.parse(input.sourceRef);
  const resolution = (intent.type === 'explicit_exclusion' || intent.type === 'explicit_request')
    && intent.subject.type === 'track'
    && input.ncmClient
    ? await resolveTrackIdentity({
        title: intent.subject.label,
        artist: intent.subject.artist
      }, input.ncmClient)
    : null;
  const resolvedTrack = resolution?.status === 'resolved' ? resolution.track : null;

  if (intent.type === 'explicit_request' && intent.revokeMatchingExclusion) {
    const identity = intent.subject.type === 'track'
      ? trackIntentIdentity(intent.subject, resolvedTrack)
      : { exactKeyGroups: [[intent.subject.key]], fallbackAliasKeys: [] };
    const revoked = revokeExplicitExclusionsByIdentity({
      userId: input.userId,
      entityType: intent.subject.type,
      ...identity,
      ...(intent.subject.type === 'track'
        ? {
            compatiblePendingTrack: {
              title: intent.subject.label,
              artist: intent.subject.artist ?? resolvedTrack?.artists[0] ?? null
            }
          }
        : {}),
      sourceRef,
      revokedAt: occurredAt
    });
    return {
      intent,
      revokedExclusionIds: revoked.map((item) => item.id)
    };
  }

  if (intent.type === 'explicit_exclusion') {
    const trackIdentity = intent.subject.type === 'track' && resolvedTrack
      ? {
          entityKey: buildTrackExclusionKey({
            provider: 'ncm',
            providerId: resolvedTrack.ncmId,
            title: resolvedTrack.name,
            primaryArtist: resolvedTrack.artists[0] ?? ''
          }),
          provider: 'ncm',
          providerId: resolvedTrack.ncmId,
          displayName: resolvedTrack.name,
          aliases: trackIntentKeys(intent.subject, resolvedTrack)
        }
      : intent.subject.type === 'track'
        ? {
          entityKey: `unresolved:${intent.subject.key}`,
          provider: null,
          providerId: null,
          displayName: intent.subject.label,
          aliases: [intent.subject.key]
        }
        : {
          entityKey: intent.subject.key,
          provider: null,
          providerId: null,
          displayName: intent.subject.label
        };
    const created = intent.subject.type === 'track' && !resolvedTrack
      ? createPendingExplicitTrackExclusion({
          userId: input.userId,
          entityKey: trackIdentity.entityKey,
          displayName: intent.subject.label,
          aliases: [intent.subject.key],
          sourceKind: 'listener_instruction',
          sourceRef,
          queryTitle: intent.subject.label,
          queryArtist: intent.subject.artist,
          createdAt: occurredAt
        })
      : createExplicitExclusion({
          userId: input.userId,
          entityType: intent.subject.type,
          ...trackIdentity,
          sourceKind: 'listener_instruction',
          sourceRef,
          createdAt: occurredAt
        });
    return {
      intent,
      revokedExclusionIds: [],
      createdExclusionId: created.exclusion.id,
      ...(intent.subject.type === 'track'
        ? { trackResolution: resolvedTrack ? 'resolved' as const : 'pending_resolution' as const }
        : {})
    };
  }

  if (intent.type === 'preference_evidence') {
    const evidence = savePreferenceEvidence({
      userId: input.userId,
      evidenceKind: intent.evidenceKind,
      subjectType: intent.subject.type,
      subjectKey: intent.subject.key,
      polarity: intent.polarity,
      strength: intent.strength,
      confidence: 1,
      sourceKind: 'listener_instruction',
      sourceRefs: [toPreferenceSourceRef(sourceRef)],
      observedAt: occurredAt,
      extractorVersion: 'selection-intent-v1',
      payload: { subjectLabel: intent.subject.label }
    });
    return {
      intent,
      revokedExclusionIds: [],
      preferenceEvidenceId: evidence.id
    };
  }

  return { intent, revokedExclusionIds: [] };
}

function trackIntentKeys(subject: MusicIntentSubject, resolved: ResolvedTrack | null): string[] {
  if (!resolved) return [subject.key];
  return [
    subject.key,
    ...buildTrackExclusionAliases({
      provider: 'ncm',
      providerId: resolved.ncmId,
      title: resolved.name,
      primaryArtist: resolved.artists[0] ?? ''
    })
  ];
}

function trackIntentIdentity(
  subject: MusicIntentSubject,
  resolved: ResolvedTrack | null
): { exactKeyGroups: string[][]; fallbackAliasKeys: string[] } {
  if (!resolved) {
    return { exactKeyGroups: [], fallbackAliasKeys: [subject.key] };
  }
  const aliases = buildTrackExclusionAliases({
    provider: 'ncm',
    providerId: resolved.ncmId,
    title: resolved.name,
    primaryArtist: resolved.artists[0] ?? ''
  });
  const providerKey = aliases.find((key) => key.startsWith('ncm:'));
  return {
    exactKeyGroups: [
      providerKey ? [providerKey] : [],
      aliases.filter((key) => key !== providerKey)
    ],
    fallbackAliasKeys: [subject.key]
  };
}

function subjectFromLabel(raw: string): MusicIntentSubject | null {
  const label = raw
    .trim()
    .replace(/[。！？!?.]+$/gu, '')
    .replace(/[啊呀呢吧]+$/gu, '')
    .trim();
  if (!label) return null;
  const quotedTrack = label.match(/^《(.+?)》(?:\s*[-—–]\s*(.+))?$/u);
  const unquotedTrack = label.match(/^(.+?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/u);
  const track = quotedTrack ?? unquotedTrack;
  const entityLabel = track?.[1]?.trim() ?? label;
  const artist = track?.[2]?.trim() || undefined;
  return {
    type: track ? 'track' : 'artist',
    key: track && artist
      ? buildTrackExclusionKey({ title: entityLabel, primaryArtist: artist })
      : normalizeExclusionKey(entityLabel),
    label: entityLabel,
    ...(artist ? { artist } : {})
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isGeneralizedTarget(raw: string): boolean {
  const target = raw.trim().replace(/[。！？!?.啊呀呢吧]+$/gu, '').trim();
  if (/^(?:点|一些|几首|更多|多点)/u.test(target)) return true;
  if (/(?:歌|音乐|曲风|风格)$/u.test(target)) return true;
  return /^(?:摇滚|民谣|电子|流行|古典|爵士|说唱|嘻哈|华语|粤语|英文|日语|韩语|city pop|r&b)$/iu.test(target);
}

function toPreferenceSourceRef(sourceRef: ExclusionSourceRef): {
  messageId?: number;
  sourceId?: string;
} {
  if (sourceRef.messageId !== undefined) return { messageId: sourceRef.messageId };
  if (sourceRef.sourceId !== undefined) return { sourceId: sourceRef.sourceId };
  if (sourceRef.actionId !== undefined) return { sourceId: `action:${sourceRef.actionId}` };
  throw new Error('selection_intent_source_ref_missing');
}
