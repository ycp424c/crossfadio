import { finalPickSchema } from './schema.js';
import {
  areMusicTrackDedupeKeysSimilar,
  buildMusicTrackDedupeKey
} from './dedupe.js';
import type {
  FinalPick,
  MusicCandidate,
  MusicCandidateQualitySignals,
  MusicCandidateScores
} from './schema.js';
import {
  cloneCandidateProvenance,
  mergeCandidateProvenance
} from './candidate-provenance.js';
import { evaluateAdmission as evaluateAdmissionPolicy } from './selection-policy/admission.js';
import { evaluateFinal } from './selection-policy/final.js';
import type { SelectionDecisionRecorder } from './selection-policy/decision-trace.js';
import {
  toSelectionPolicyCandidate,
  type SelectionPhaseDecision,
  type SelectionPolicyContext
} from './selection-policy/types.js';
import { primaryArtistKey } from './artists.js';

export interface CandidatePoolOptions {
  maxCandidates?: number;
  selectionPolicyContext?: SelectionPolicyContext;
  selectionDecisionRecorder?: SelectionDecisionRecorder;
}

export type CandidatePoolRejectReason = 'pool_full';

export type CandidatePoolUpsertResult =
  | { status: 'inserted' }
  | { status: 'merged_by_id' }
  | { status: 'merged_by_dedupe' }
  | { status: 'merged_by_id_and_dedupe' }
  | { status: 'rejected'; reason: CandidatePoolRejectReason };

type CandidateDedupeInput = {
  name?: string | null;
  artist?: string | null;
};

type CandidatePoolEntry = {
  candidate: MusicCandidate;
  dedupeKeys: Set<string>;
};

export type FinalPickValidationOptions = {
  isCandidateEligible?: (candidate: MusicCandidate) => boolean;
  policyContext?: SelectionPolicyContext;
};

function cloneCandidate(candidate: MusicCandidate): MusicCandidate {
  return {
    ...candidate,
    sources: [...candidate.sources],
    ...(candidate.provenance ? { provenance: cloneCandidateProvenance(candidate.provenance) } : {}),
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores },
    ...(candidate.qualitySignals ? { qualitySignals: { ...candidate.qualitySignals } } : {})
  };
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function mergeScores(left: MusicCandidateScores, right: MusicCandidateScores): MusicCandidateScores {
  return {
    intentMatch: Math.max(left.intentMatch, right.intentMatch),
    tasteMatch: Math.max(left.tasteMatch, right.tasteMatch),
    timeFit: Math.max(left.timeFit, right.timeFit),
    contextFit: Math.max(left.contextFit, right.contextFit),
    novelty: Math.max(left.novelty, right.novelty),
    sourceConfidence: Math.max(left.sourceConfidence, right.sourceConfidence)
  };
}

function mergeCandidate(existing: MusicCandidate, incoming: MusicCandidate): MusicCandidate {
  const sources = mergeUnique(existing.sources, incoming.sources);
  return {
    ...existing,
    sources,
    provenance: mergeCandidateProvenance(existing, incoming, sources),
    evidence: mergeUnique(existing.evidence, incoming.evidence),
    scores: mergeScores(existing.scores, incoming.scores),
    ...qualitySignalsProperty(mergeCandidateQualitySignals(existing.qualitySignals, incoming.qualitySignals))
  };
}

function mergeCandidateQualitySignals(
  existing: MusicCandidateQualitySignals | undefined,
  incoming: MusicCandidateQualitySignals | undefined
): MusicCandidateQualitySignals | undefined {
  if (!existing) return incoming ? { ...incoming } : undefined;
  if (!incoming) return { ...existing };
  const merged: MusicCandidateQualitySignals = { ...existing, ...incoming };
  if (existing.noCopyrightRcmd || incoming.noCopyrightRcmd) merged.noCopyrightRcmd = true;
  if (existing.privilegeToast || incoming.privilegeToast) merged.privilegeToast = true;
  merged.copyright = stricterCopyright(existing.copyright, incoming.copyright);
  merged.privilegeSt = stricterPrivilegeSt(existing.privilegeSt, incoming.privilegeSt);
  merged.titlePollution = strongerTitlePollution(existing.titlePollution, incoming.titlePollution);
  return merged;
}

function stricterCopyright(
  left: MusicCandidateQualitySignals['copyright'],
  right: MusicCandidateQualitySignals['copyright']
): MusicCandidateQualitySignals['copyright'] {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function stricterPrivilegeSt(
  left: MusicCandidateQualitySignals['privilegeSt'],
  right: MusicCandidateQualitySignals['privilegeSt']
): MusicCandidateQualitySignals['privilegeSt'] {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function strongerTitlePollution(
  left: MusicCandidateQualitySignals['titlePollution'],
  right: MusicCandidateQualitySignals['titlePollution']
): MusicCandidateQualitySignals['titlePollution'] {
  const rank = { none: 0, mild: 1, strong: 2 } as const;
  if (!left) return right;
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function qualitySignalsProperty(
  qualitySignals: MusicCandidateQualitySignals | undefined
): { qualitySignals?: MusicCandidateQualitySignals } {
  return qualitySignals ? { qualitySignals } : {};
}

export function buildCandidateDedupeKey(candidate: CandidateDedupeInput): string {
  return buildMusicTrackDedupeKey({ name: candidate.name, artist: primaryArtistKey(candidate.artist) });
}

export class CandidatePool {
  private readonly byId = new Map<string, CandidatePoolEntry>();
  private readonly replayCandidatesById = new Map<string, MusicCandidate>();
  private readonly idByDedupeKey = new Map<string, string>();
  private readonly canonicalIdByAliasId = new Map<string, string>();
  private readonly maxCandidates: number;
  private readonly selectionPolicyContext: SelectionPolicyContext;
  private readonly selectionDecisionRecorder: SelectionDecisionRecorder | undefined;

  constructor(options: CandidatePoolOptions = {}) {
    this.maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;
    this.selectionPolicyContext = options.selectionPolicyContext
      ?? { mode: 'autonomous', explicitlyRequested: false };
    this.selectionDecisionRecorder = options.selectionDecisionRecorder;
  }

  evaluateAdmission(candidate: MusicCandidate): SelectionPhaseDecision {
    const existingReplayCandidate = this.replayCandidatesById.get(candidate.id);
    this.replayCandidatesById.set(
      candidate.id,
      existingReplayCandidate ? mergeCandidate(existingReplayCandidate, candidate) : cloneCandidate(candidate)
    );
    const decision = evaluateAdmissionPolicy({
      candidate: toSelectionPolicyCandidate(candidate),
      context: this.selectionPolicyContext
    });
    this.selectionDecisionRecorder?.record({ candidateId: candidate.id, decision });
    return decision;
  }

  upsert(candidate: MusicCandidate): CandidatePoolUpsertResult {
    const dedupeKey = buildCandidateDedupeKey(candidate);

    const existingById = this.byId.get(candidate.id);
    const canonicalId = this.resolveCanonicalId(candidate.id);
    const existingByCanonicalId = canonicalId ? this.byId.get(canonicalId) : undefined;
    const dedupedId = this.findDedupedId(dedupeKey);
    const dedupedEntry = dedupedId ? this.byId.get(dedupedId) : undefined;
    const existingEntry = existingByCanonicalId ?? existingById;
    const existingEntryId = existingByCanonicalId && canonicalId ? canonicalId : candidate.id;

    if (existingEntry && dedupedId && dedupedEntry && dedupedId !== existingEntryId) {
      existingEntry.candidate = mergeCandidate(
        mergeCandidate(existingEntry.candidate, dedupedEntry.candidate),
        candidate
      );
      this.reassignDedupeKeys(dedupedEntry, existingEntryId, existingEntry);
      this.addDedupeKey(existingEntry, existingEntryId, dedupeKey);
      this.reassignAliases(dedupedId, existingEntryId);
      this.addAlias(candidate.id, existingEntryId);
      this.byId.delete(dedupedId);
      return { status: 'merged_by_id_and_dedupe' };
    }

    if (existingEntry) {
      existingEntry.candidate = mergeCandidate(existingEntry.candidate, candidate);
      this.addDedupeKey(existingEntry, existingEntryId, dedupeKey);
      this.addAlias(candidate.id, existingEntryId);
      return { status: 'merged_by_id' };
    }

    if (dedupedEntry && dedupedId) {
      dedupedEntry.candidate = mergeCandidate(dedupedEntry.candidate, candidate);
      this.addDedupeKey(dedupedEntry, dedupedId, dedupeKey);
      this.addAlias(candidate.id, dedupedId);
      return { status: 'merged_by_dedupe' };
    }

    if (this.byId.size >= this.maxCandidates) {
      return { status: 'rejected', reason: 'pool_full' };
    }

    this.byId.set(candidate.id, {
      candidate: cloneCandidate(candidate),
      dedupeKeys: new Set(dedupeKey ? [dedupeKey] : [])
    });
    if (dedupeKey) {
      this.idByDedupeKey.set(dedupeKey, candidate.id);
    }
    return { status: 'inserted' };
  }

  get(id: string): MusicCandidate | undefined {
    const canonicalId = this.resolveCanonicalId(id);
    const entry = canonicalId ? this.byId.get(canonicalId) : undefined;
    return entry ? cloneCandidate(entry.candidate) : undefined;
  }

  has(id: string): boolean {
    return this.resolveCanonicalId(id) !== undefined;
  }

  list(): MusicCandidate[] {
    return [...this.byId.values()].map((entry) => cloneCandidate(entry.candidate));
  }

  replayCandidates(): MusicCandidate[] {
    const candidates = new Map(
      [...this.replayCandidatesById.entries()].map(([id, candidate]) => [id, cloneCandidate(candidate)])
    );
    for (const candidate of this.list()) candidates.set(candidate.id, candidate);
    return [...candidates.values()];
  }

  count(): number {
    return this.byId.size;
  }

  mergeQualitySignals(id: string, qualitySignals: MusicCandidateQualitySignals | undefined): void {
    if (!qualitySignals) return;
    const canonicalId = this.resolveCanonicalId(id);
    const entry = canonicalId ? this.byId.get(canonicalId) : undefined;
    if (!entry) return;
    entry.candidate = {
      ...entry.candidate,
      qualitySignals: mergeCandidateQualitySignals(entry.candidate.qualitySignals, qualitySignals)
    };
  }

  topBy(fn: (candidate: MusicCandidate) => number, limit: number): MusicCandidate[] {
    return this.list()
      .sort((left, right) => fn(right) - fn(left))
      .slice(0, Math.max(0, limit));
  }

  validateFinalPicks(picks: FinalPick[], options: FinalPickValidationOptions = {}): FinalPick[] {
    return picks.map((pick) => {
      const parsedPick = finalPickSchema.parse(pick);
      const canonicalId = this.resolveCanonicalId(parsedPick.id);

      if (!canonicalId) {
        throw new Error(`Final pick ${parsedPick.id} is not in candidate pool`);
      }

      const candidate = this.byId.get(canonicalId)?.candidate;

      if (!candidate) {
        throw new Error(`Final pick ${parsedPick.id} is not in candidate pool`);
      }

      const reason = parsedPick.reason.trim();

      if (!reason) {
        throw new Error(`Final pick ${parsedPick.id} reason is blank`);
      }

      if (!candidate.sources.includes(parsedPick.source)) {
        throw new Error(`Final pick ${parsedPick.id} source mismatch: ${parsedPick.source}`);
      }

      const finalDecision = evaluateFinal({
        candidate: toSelectionPolicyCandidate(candidate),
        context: options.policyContext ?? { mode: 'autonomous', explicitlyRequested: false }
      });
      if (finalDecision.action === 'reject') {
        throw new Error(
          `Final pick ${parsedPick.id} is not policy eligible: ${finalDecision.reasonCodes.join(', ')}`
        );
      }

      if (options.isCandidateEligible && !options.isCandidateEligible(cloneCandidate(candidate))) {
        throw new Error(`Final pick ${parsedPick.id} is not eligible for final selection`);
      }

      return {
        ...parsedPick,
        id: canonicalId,
        name: candidate.name,
        artist: candidate.artist,
        reason,
        ...(candidate.qualitySignals ? { qualitySignals: { ...candidate.qualitySignals } } : {})
      };
    });
  }

  private resolveCanonicalId(id: string): string | undefined {
    const canonicalId = this.canonicalIdByAliasId.get(id) ?? id;

    return this.byId.has(canonicalId) ? canonicalId : undefined;
  }

  private addAlias(aliasId: string, canonicalId: string): void {
    if (aliasId !== canonicalId) {
      this.canonicalIdByAliasId.set(aliasId, canonicalId);
    }
  }

  private reassignAliases(fromId: string, toId: string): void {
    this.addAlias(fromId, toId);

    for (const [aliasId, canonicalId] of this.canonicalIdByAliasId.entries()) {
      if (canonicalId === fromId) {
        this.canonicalIdByAliasId.set(aliasId, toId);
      }
    }
  }

  private addDedupeKey(entry: CandidatePoolEntry, id: string, dedupeKey: string): void {
    if (!dedupeKey) return;
    entry.dedupeKeys.add(dedupeKey);
    this.idByDedupeKey.set(dedupeKey, id);
  }

  private reassignDedupeKeys(from: CandidatePoolEntry, id: string, to: CandidatePoolEntry): void {
    for (const key of from.dedupeKeys) {
      this.addDedupeKey(to, id, key);
    }
  }

  private findDedupedId(dedupeKey: string): string | undefined {
    if (!dedupeKey) return undefined;

    const exactId = this.idByDedupeKey.get(dedupeKey);
    if (exactId) return exactId;

    for (const [existingKey, id] of this.idByDedupeKey.entries()) {
      if (areMusicTrackDedupeKeysSimilar(dedupeKey, existingKey)) {
        return id;
      }
    }

    return undefined;
  }
}

export function validateFinalPicks(
  picks: FinalPick[],
  pool: CandidatePool,
  options: FinalPickValidationOptions = {}
): FinalPick[] {
  return pool.validateFinalPicks(picks, options);
}
