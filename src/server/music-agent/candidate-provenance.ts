import type { CandidateProvenance, CandidateProvenanceKind, CandidateSource, MusicCandidate } from './schema.js';

const DEFAULT_PROVENANCE_BY_SOURCE: Record<CandidateSource, CandidateProvenanceKind> = {
  liked: 'liked',
  playlist: 'playlist',
  plan: 'plan',
  search: 'exact_recall',
  style_expansion: 'style_expansion',
  trend: 'trend_recall'
};

export type CandidateProvenanceInput = {
  kind?: CandidateProvenanceKind;
  source?: CandidateSource;
  detail?: string;
};

export function provenanceForSource(
  source: CandidateSource,
  input: CandidateProvenanceInput = {}
): CandidateProvenance {
  return {
    kind: input.kind ?? DEFAULT_PROVENANCE_BY_SOURCE[source],
    source: input.source ?? source,
    ...(input.detail ? { detail: input.detail } : {})
  };
}

export function candidateProvenance(candidate: Pick<MusicCandidate, 'sources' | 'provenance'>): CandidateProvenance[] {
  if (candidate.provenance && candidate.provenance.length > 0) {
    return cloneCandidateProvenance(candidate.provenance);
  }
  return candidate.sources.map((source) => provenanceForSource(source));
}

export function cloneCandidateProvenance(provenance: readonly CandidateProvenance[] | undefined): CandidateProvenance[] {
  return (provenance ?? []).map((entry) => ({ ...entry }));
}

export function mergeCandidateProvenance(
  existing: Pick<MusicCandidate, 'sources' | 'provenance'>,
  incoming: Pick<MusicCandidate, 'sources' | 'provenance'>,
  mergedSources: CandidateSource[]
): CandidateProvenance[] {
  const merged = uniqueProvenance([
    ...candidateProvenance(existing),
    ...candidateProvenance(incoming)
  ]);
  return merged.length > 0 ? merged : mergedSources.map((source) => provenanceForSource(source));
}

export function candidateProvenanceLabels(candidate: Pick<MusicCandidate, 'sources' | 'provenance'>): string[] {
  return candidateProvenance(candidate).map((entry) => entry.kind);
}

function uniqueProvenance(provenance: CandidateProvenance[]): CandidateProvenance[] {
  const seen = new Set<string>();
  const unique: CandidateProvenance[] = [];
  for (const entry of provenance) {
    const key = `${entry.kind}\u0000${entry.source}\u0000${entry.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...entry });
  }
  return unique;
}
