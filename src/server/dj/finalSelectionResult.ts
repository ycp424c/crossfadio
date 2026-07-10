import type { FinalPickDiagnostics } from '../music-agent/schema.js';

const MAX_RATIONALE_LENGTH = 1000;
const MAX_TRACK_ID_LENGTH = 200;
const MAX_TRACK_NAME_LENGTH = 300;
const MAX_TRACK_ARTIST_LENGTH = 300;
const MAX_TRACK_REASON_LENGTH = 1000;
const MAX_TRACK_SOURCE_LENGTH = 80;

export type FinalSelectionTrack = {
  id: string;
  name?: string;
  artist?: string;
  reason: string;
  source: string;
};

export type FinalSelectionDiagnostics = {
  targetCount?: number;
  requestedPickCount?: number;
  appendedCount: number;
  finalPickDiagnostics?: FinalPickDiagnostics;
  skippedPicks: FinalSelectionSkippedPick[];
};

export type FinalSelectionSkippedPick = {
  id?: string;
  name?: string;
  artist?: string;
  reason: 'id_excluded' | 'dedupe_excluded' | 'no_remaining_slots';
  dedupeKey?: string;
};

export type FinalSelectionResult = {
  tracks: FinalSelectionTrack[];
  rationale: string;
  proposedRationale?: string;
  diagnostics: FinalSelectionDiagnostics;
};

export function buildFinalSelectionResult(input: {
  tracks: FinalSelectionTrack[];
  proposedRationale?: string;
  diagnostics?: Omit<Partial<FinalSelectionDiagnostics>, 'appendedCount'>;
}): FinalSelectionResult {
  if (input.tracks.length === 0) {
    throw new Error('Final selection requires at least one appended track');
  }

  const tracks = input.tracks.map(normalizeTrack);
  const rationale = buildRationale(tracks);
  const proposedRationale = normalizeText(input.proposedRationale ?? '');

  return {
    tracks,
    rationale,
    ...(proposedRationale
      ? { proposedRationale: truncateText(proposedRationale, MAX_RATIONALE_LENGTH) }
      : {}),
    diagnostics: {
      ...(input.diagnostics?.targetCount !== undefined
        ? { targetCount: input.diagnostics.targetCount }
        : {}),
      ...(input.diagnostics?.requestedPickCount !== undefined
        ? { requestedPickCount: input.diagnostics.requestedPickCount }
        : {}),
      ...(input.diagnostics?.finalPickDiagnostics !== undefined
        ? { finalPickDiagnostics: input.diagnostics.finalPickDiagnostics }
        : {}),
      appendedCount: tracks.length,
      skippedPicks: input.diagnostics?.skippedPicks ?? []
    }
  };
}

function normalizeTrack(track: FinalSelectionTrack): FinalSelectionTrack {
  const normalizedId = normalizeText(track.id);
  const normalizedName = normalizeText(track.name ?? '');
  const normalizedArtist = normalizeText(track.artist ?? '');
  const normalizedReason = normalizeText(track.reason);
  const normalizedSource = normalizeText(track.source);

  assertNonBlank(normalizedId, 'id');
  assertNonBlank(normalizedReason, 'reason');
  assertNonBlank(normalizedSource, 'source');

  const id = truncateText(normalizedId, MAX_TRACK_ID_LENGTH);
  const name = normalizedName
    ? truncateText(normalizedName, MAX_TRACK_NAME_LENGTH)
    : id;
  const artist = truncateText(normalizedArtist, MAX_TRACK_ARTIST_LENGTH);
  const reason = truncateText(normalizedReason, MAX_TRACK_REASON_LENGTH);
  const source = truncateText(normalizedSource, MAX_TRACK_SOURCE_LENGTH);

  return {
    id,
    name,
    ...(artist ? { artist } : {}),
    reason,
    source
  };
}

function buildRationale(tracks: FinalSelectionTrack[]): string {
  const prefix = `本次实际补充 ${tracks.length} 首：`;
  const structuralLength = prefix.length + Math.max(0, tracks.length - 1) + tracks.length * 2 + 1;
  const contentBudget = MAX_RATIONALE_LENGTH - structuralLength;

  if (contentBudget < tracks.length) {
    return `${truncateText(prefix, MAX_RATIONALE_LENGTH - 2)}…。`;
  }

  const baseBudget = Math.floor(contentBudget / tracks.length);
  const remainder = contentBudget % tracks.length;
  const descriptions = tracks.map((track, index) =>
    renderTrack(track, baseBudget + (index < remainder ? 1 : 0))
  );
  return `${prefix}${descriptions.join('、')}。`;
}

function renderTrack(track: FinalSelectionTrack, contentBudget: number): string {
  const name = track.name ?? track.id;
  if (!track.artist) {
    return `《${truncateText(name, contentBudget)}》`;
  }

  let artistBudget = Math.floor(contentBudget / 2);
  let nameBudget = contentBudget - artistBudget;
  if (track.artist.length < artistBudget) {
    nameBudget += artistBudget - track.artist.length;
    artistBudget = track.artist.length;
  } else if (name.length < nameBudget) {
    artistBudget += nameBudget - name.length;
    nameBudget = name.length;
  }

  return `${truncateText(track.artist, artistBudget)}《${truncateText(name, nameBudget)}》`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return '';

  const contentBudget = maxLength - 1;
  let result = '';
  for (const codePoint of value) {
    if (result.length + codePoint.length > contentBudget) break;
    result += codePoint;
  }
  return `${result}…`;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function assertNonBlank(value: string, field: 'id' | 'reason' | 'source'): void {
  if (!value) {
    throw new Error(`Final selection track ${field} must not be blank`);
  }
}
