import { createHash } from 'node:crypto';
import { artistKeys } from './artists.js';
import type { CandidatePool, CandidatePoolRejectReason } from './candidates.js';
import type { NcmTrackLike } from './liked-recall.js';
import type {
  CandidateProvenance,
  CandidateProvenanceKind,
  CandidateSource,
  MusicAgentContextSummary,
  MusicCandidate,
  MusicCandidateQualitySignals,
  MusicCandidateScores
} from './schema.js';
import {
  cloneCandidateProvenance,
  provenanceForSource
} from './candidate-provenance.js';
import type { SelectionReasonCode } from './selection-policy/types.js';

const QUALITY_SOURCES = new Set<CandidateSource>(['playlist', 'search', 'style_expansion', 'trend']);

export type UpsertTracksResult = {
  added: number;
  inserted: number;
  mergedById: number;
  mergedByDedupe: number;
  mergedByIdAndDedupe: number;
  invalid: number;
  ineligible: number;
  ineligibleReasons: Partial<Record<SelectionReasonCode, number>>;
  rejectedByPool: number;
  rejectedReasons: Partial<Record<CandidatePoolRejectReason, number>>;
};

export type UpsertTracksOptions = {
  evidence: string;
  scores: MusicCandidateScores;
  scoreForTrack?: (track: NcmTrackLike) => MusicCandidateScores;
  maxAccepted?: number;
  provenance?: CandidateProvenance | CandidateProvenance[];
  provenanceKind?: CandidateProvenanceKind;
  provenanceDetail?: string;
};

export function emptyUpsertTracksResult(): UpsertTracksResult {
  return {
    added: 0,
    inserted: 0,
    mergedById: 0,
    mergedByDedupe: 0,
    mergedByIdAndDedupe: 0,
    invalid: 0,
    ineligible: 0,
    ineligibleReasons: {},
    rejectedByPool: 0,
    rejectedReasons: {}
  };
}

export function upsertTracks(
  pool: CandidatePool,
  tracks: NcmTrackLike[],
  source: CandidateSource,
  options: UpsertTracksOptions
): UpsertTracksResult {
  const result = emptyUpsertTracksResult();
  const maxAccepted = options.maxAccepted ?? Number.POSITIVE_INFINITY;
  for (const [trackIndex, track] of tracks.entries()) {
    if (result.added >= maxAccepted) break;
    const candidate = candidateFromTrack(track, source, {
      ...options,
      scores: options.scoreForTrack?.(track) ?? options.scores
    });
    if (!candidate) {
      pool.evaluateAdmission(replayCandidateFromMalformedTrack(
        track,
        source,
        options,
        trackIndex
      ));
      result.invalid += 1;
      continue;
    }
    const admission = pool.evaluateAdmission(candidate);
    if (admission.action === 'reject') {
      result.ineligible += 1;
      for (const reason of admission.reasonCodes) {
        result.ineligibleReasons[reason] = (result.ineligibleReasons[reason] ?? 0) + 1;
      }
      continue;
    }
    const upsertResult = pool.upsert(candidate);
    if (upsertResult.status === 'inserted') {
      result.added += 1;
      result.inserted += 1;
    } else if (upsertResult.status === 'merged_by_id') {
      result.added += 1;
      result.mergedById += 1;
    } else if (upsertResult.status === 'merged_by_dedupe') {
      result.added += 1;
      result.mergedByDedupe += 1;
    } else if (upsertResult.status === 'merged_by_id_and_dedupe') {
      result.added += 1;
      result.mergedByIdAndDedupe += 1;
    } else {
      result.rejectedByPool += 1;
      result.rejectedReasons[upsertResult.reason] = (result.rejectedReasons[upsertResult.reason] ?? 0) + 1;
    }
  }
  return result;
}

function replayCandidateFromMalformedTrack(
  track: NcmTrackLike,
  source: CandidateSource,
  options: UpsertTracksOptions,
  trackIndex: number
): MusicCandidate {
  const rawId = track.id === undefined || track.id === null ? '' : String(track.id).trim();
  const name = track.name?.trim() ?? '';
  const artist = (track.artists ?? []).map((item) => item.trim()).filter(Boolean).join(' / ');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ source, trackIndex, rawId, name, artist }))
    .digest('hex')
    .slice(0, 20);
  return {
    id: `invalid-${source}-${fingerprint}`,
    name,
    artist,
    sources: [source],
    provenance: candidateProvenanceFromOptions(source, options),
    evidence: [options.evidence],
    scores: { ...(options.scoreForTrack?.(track) ?? options.scores) },
    ...qualitySignalsProperty(track.qualitySignals ?? undefined)
  };
}

export function mergeUpsertTracksResult(target: UpsertTracksResult, source: UpsertTracksResult): void {
  target.added += source.added;
  target.inserted += source.inserted;
  target.mergedById += source.mergedById;
  target.mergedByDedupe += source.mergedByDedupe;
  target.mergedByIdAndDedupe += source.mergedByIdAndDedupe;
  target.invalid += source.invalid;
  target.ineligible += source.ineligible;
  target.rejectedByPool += source.rejectedByPool;
  for (const [reason, count] of Object.entries(source.rejectedReasons)) {
    if (!count) continue;
    const key = reason as CandidatePoolRejectReason;
    target.rejectedReasons[key] = (target.rejectedReasons[key] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(source.ineligibleReasons)) {
    if (!count) continue;
    const key = reason as SelectionReasonCode;
    target.ineligibleReasons[key] = (target.ineligibleReasons[key] ?? 0) + count;
  }
}

export function countCandidateArtistKeys(candidates: MusicCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const artist of artistKeys(candidate.artist)) {
      counts.set(artist, (counts.get(artist) ?? 0) + 1);
    }
  }
  return counts;
}

export function summarizeCandidateAdmission(result: UpsertTracksResult): string | null {
  const parts = [
    result.inserted > 0 ? `inserted=${result.inserted}` : '',
    result.mergedById > 0 ? `mergedById=${result.mergedById}` : '',
    result.mergedByDedupe > 0 ? `mergedByDedupe=${result.mergedByDedupe}` : '',
    result.mergedByIdAndDedupe > 0 ? `mergedByIdAndDedupe=${result.mergedByIdAndDedupe}` : '',
    result.invalid > 0 ? `invalid=${result.invalid}` : '',
    ineligibleSummary(result),
    rejectedByPoolSummary(result)
  ].filter(Boolean);

  return parts.length > 0 ? `candidate admission: ${parts.join('; ')}` : null;
}

export function rejectedPoolRecallProblems(
  result: Pick<UpsertTracksResult, 'rejectedByPool' | 'rejectedReasons'>
): string[] {
  const summary = rejectedByPoolSummary(result);
  return summary ? [`candidate admission: ${summary}`] : [];
}

export function candidateFromTrack(
  track: NcmTrackLike,
  source: CandidateSource,
  options: {
    evidence: string;
    scores: MusicCandidateScores;
    provenance?: CandidateProvenance | CandidateProvenance[];
    provenanceKind?: CandidateProvenanceKind;
    provenanceDetail?: string;
  }
): MusicCandidate | null {
  const id = track.id === undefined || track.id === null ? '' : String(track.id).trim();
  const name = track.name?.trim() ?? '';
  const artist = (track.artists ?? []).map((item) => item.trim()).filter(Boolean).join(' / ');
  if (!id || !name || !artist) return null;

  return {
    id,
    name,
    artist,
    sources: [source],
    provenance: candidateProvenanceFromOptions(source, options),
    evidence: [options.evidence],
    scores: { ...options.scores },
    ...qualitySignalsProperty(track.qualitySignals ?? undefined)
  };
}

function candidateProvenanceFromOptions(
  source: CandidateSource,
  options: {
    evidence: string;
    provenance?: CandidateProvenance | CandidateProvenance[];
    provenanceKind?: CandidateProvenanceKind;
    provenanceDetail?: string;
  }
): CandidateProvenance[] {
  if (options.provenance) {
    return cloneCandidateProvenance(Array.isArray(options.provenance) ? options.provenance : [options.provenance]);
  }
  return [provenanceForSource(source, {
    kind: options.provenanceKind,
    detail: options.provenanceDetail
  })];
}

export function usesExternalQuality(candidate: MusicCandidate): boolean {
  return candidate.sources.every((source) => QUALITY_SOURCES.has(source));
}

export function sourceScores(source: CandidateSource, context: MusicAgentContextSummary): MusicCandidateScores {
  const mode = context.discoveryMode;
  const base: MusicCandidateScores = {
    intentMatch: 0.62,
    tasteMatch: 0.58,
    timeFit: 0.55,
    contextFit: 0.35,
    novelty: 0.45,
    sourceConfidence: 0.58
  };

  if (source === 'liked') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.7, tasteMatch: 0.94, sourceConfidence: 0.88, novelty: 0.35 }
      : { ...base, intentMatch: 0.62, tasteMatch: 0.72, sourceConfidence: 0.68, novelty: 0.32 };
  }
  if (source === 'playlist') {
    return mode === 'comfort'
      ? { ...base, tasteMatch: 0.8, sourceConfidence: 0.78 }
      : { ...base, tasteMatch: 0.66, sourceConfidence: 0.62, novelty: 0.48 };
  }
  if (source === 'trend') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.54, tasteMatch: 0.46, novelty: 0.62, sourceConfidence: 0.58 }
      : { ...base, intentMatch: 0.66, tasteMatch: 0.52, novelty: 0.82, sourceConfidence: 0.7 };
  }
  if (source === 'style_expansion') {
    return mode === 'comfort'
      ? { ...base, intentMatch: 0.66, tasteMatch: 0.62, novelty: 0.58, sourceConfidence: 0.58 }
      : { ...base, intentMatch: 0.78, tasteMatch: 0.62, novelty: 0.8, sourceConfidence: 0.72 };
  }
  return mode === 'comfort'
    ? base
    : { ...base, intentMatch: 0.76, tasteMatch: 0.64, novelty: 0.78, sourceConfidence: 0.72 };
}

function rejectedByPoolSummary(result: Pick<UpsertTracksResult, 'rejectedByPool' | 'rejectedReasons'>): string {
  if (result.rejectedByPool === 0) return '';
  const reasons = Object.entries(result.rejectedReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return reasons
    ? `rejectedByPool=${result.rejectedByPool} (${reasons})`
    : `rejectedByPool=${result.rejectedByPool}`;
}

function ineligibleSummary(result: Pick<UpsertTracksResult, 'ineligible' | 'ineligibleReasons'>): string {
  if (result.ineligible === 0) return '';
  const reasons = Object.entries(result.ineligibleReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return reasons
    ? `ineligible=${result.ineligible} (${reasons})`
    : `ineligible=${result.ineligible}`;
}

function qualitySignalsProperty(
  qualitySignals: MusicCandidateQualitySignals | undefined
): { qualitySignals?: MusicCandidateQualitySignals } {
  return qualitySignals ? { qualitySignals: { ...qualitySignals } } : {};
}
