import { primaryArtistKey } from '../artists.js';
import type { MusicCandidate } from '../schema.js';
import type { SelectionPhaseDecision } from './types.js';

const TITLE_DIVERSITY_MOTIFS = [
  { key: 'afternoon', pattern: /(?:午後|午后|下午|\bafternoon\b|\bno\s+gogo\b)/i }
] as const;

export type BatchPolicyOptions = {
  maxPerSource?: number;
  blockedTitleMotifs?: ReadonlySet<string>;
  recordDecision?: (candidate: MusicCandidate, decision: SelectionPhaseDecision) => void;
};

export function selectDiverseBatch(
  candidates: MusicCandidate[],
  limit: number,
  options: BatchPolicyOptions = {}
): MusicCandidate[] {
  const target = Math.max(0, limit);
  const selected: MusicCandidate[] = [];
  const deferredBySource: MusicCandidate[] = [];
  const deferredByArtist: MusicCandidate[] = [];
  const state = createBatchState(options.blockedTitleMotifs);
  const maxPerSource = Math.max(1, options.maxPerSource ?? Math.ceil(Math.max(1, target) / 2));

  for (const candidate of candidates) {
    if (selected.length >= target) break;
    const decision = evaluateBatch({ candidate, state, maxPerSource });
    options.recordDecision?.(candidate, decision);
    if (decision.action === 'select') {
      selected.push(cloneCandidate(candidate));
      rememberCandidate(state, candidate);
    } else if (decision.reasonCodes.length === 1 && decision.reasonCodes[0] === 'batch_source_repeat') {
      deferredBySource.push(candidate);
    } else if (
      decision.reasonCodes.length === 1
      && decision.reasonCodes[0] === 'batch_primary_artist_repeat'
    ) {
      deferredByArtist.push(candidate);
    }
  }

  for (const candidate of deferredBySource) {
    if (selected.length >= target) break;
    const decision = evaluateBatch({ candidate, state, maxPerSource: Number.POSITIVE_INFINITY });
    options.recordDecision?.(candidate, decision);
    if (decision.action !== 'select') {
      if (decision.reasonCodes[0] === 'batch_primary_artist_repeat') {
        deferredByArtist.push(candidate);
      }
      continue;
    }
    selected.push(cloneCandidate(candidate));
    rememberCandidate(state, candidate);
  }

  const retriedArtistIds = new Set<string>();
  for (const candidate of deferredByArtist) {
    if (selected.length >= target) break;
    if (retriedArtistIds.has(candidate.id)) continue;
    retriedArtistIds.add(candidate.id);
    const decision = evaluateBatch({
      candidate,
      state,
      maxPerSource: Number.POSITIVE_INFINITY,
      allowPrimaryArtistRepeat: true
    });
    options.recordDecision?.(candidate, decision);
    if (decision.action !== 'select') continue;
    selected.push(cloneCandidate(candidate));
    rememberCandidate(state, candidate);
  }

  return selected;
}

type BatchState = {
  primaryArtists: Set<string>;
  titleMotifs: Set<string>;
  sourceCounts: Map<string, number>;
};

export function evaluateBatch(input: {
  candidate: MusicCandidate;
  state: BatchState;
  maxPerSource: number;
  allowPrimaryArtistRepeat?: boolean;
}): SelectionPhaseDecision {
  const primaryArtist = primaryArtistKey(input.candidate.artist);
  if (
    !input.allowPrimaryArtistRepeat
    && primaryArtist
    && input.state.primaryArtists.has(primaryArtist)
  ) {
    return { phase: 'batch', action: 'defer', reasonCodes: ['batch_primary_artist_repeat'] };
  }
  if (candidateTitleMotifKeys(input.candidate).some((motif) => input.state.titleMotifs.has(motif))) {
    return { phase: 'batch', action: 'defer', reasonCodes: ['batch_title_motif_repeat'] };
  }
  const source = input.candidate.sources[0] ?? 'unknown';
  if ((input.state.sourceCounts.get(source) ?? 0) >= input.maxPerSource) {
    return { phase: 'batch', action: 'defer', reasonCodes: ['batch_source_repeat'] };
  }
  return { phase: 'batch', action: 'select', reasonCodes: ['batch_selected'] };
}

export function candidateTitleMotifKeys(candidate: Pick<MusicCandidate, 'name'>): string[] {
  const normalized = candidate.name.normalize('NFKC').toLowerCase();
  return TITLE_DIVERSITY_MOTIFS
    .filter((motif) => motif.pattern.test(normalized))
    .map((motif) => motif.key);
}

function createBatchState(blockedTitleMotifs: ReadonlySet<string> | undefined): BatchState {
  return {
    primaryArtists: new Set(),
    titleMotifs: new Set(blockedTitleMotifs ?? []),
    sourceCounts: new Map()
  };
}

function rememberCandidate(state: BatchState, candidate: MusicCandidate): void {
  const primaryArtist = primaryArtistKey(candidate.artist);
  if (primaryArtist) state.primaryArtists.add(primaryArtist);
  for (const motif of candidateTitleMotifKeys(candidate)) state.titleMotifs.add(motif);
  const source = candidate.sources[0] ?? 'unknown';
  state.sourceCounts.set(source, (state.sourceCounts.get(source) ?? 0) + 1);
}

function cloneCandidate(candidate: MusicCandidate): MusicCandidate {
  return {
    ...candidate,
    sources: [...candidate.sources],
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores },
    ...(candidate.provenance ? { provenance: candidate.provenance.map((item) => ({ ...item })) } : {}),
    ...(candidate.qualitySignals ? { qualitySignals: { ...candidate.qualitySignals } } : {})
  };
}
