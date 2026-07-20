import {
  selectionJourneySseEventSchema,
  type SelectionJourneySnapshot
} from '../shared/selection.js';

export type PlayerSelectionJourneyState = {
  journeys: SelectionJourneySnapshot[];
  selectedRunId: string | null;
};

export function parsePlayerSelectionJourney(payload: unknown): SelectionJourneySnapshot | null {
  const parsed = selectionJourneySseEventSchema.safeParse(payload);
  return parsed.success ? parsed.data.snapshot : null;
}

export function mergePlayerSelectionJourney(
  current: SelectionJourneySnapshot | null,
  incoming: SelectionJourneySnapshot
): SelectionJourneySnapshot {
  if (!current) return incoming;
  if (current.runId === incoming.runId) {
    if (incoming.journeyVersion !== current.journeyVersion) {
      return incoming.journeyVersion > current.journeyVersion ? incoming : current;
    }
    return incoming.revision > current.revision ? incoming : current;
  }
  return Date.parse(incoming.startedAt) > Date.parse(current.startedAt) ? incoming : current;
}

export function mergePlayerSelectionJourneyHistory(
  current: SelectionJourneySnapshot[],
  incoming: SelectionJourneySnapshot,
  limit = 20
): SelectionJourneySnapshot[] {
  const existingIndex = current.findIndex((journey) => journey.runId === incoming.runId);
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    const merged = mergePlayerSelectionJourney(existing, incoming);
    if (merged === existing) return current;
  }

  return [
    ...current.filter((journey) => journey.runId !== incoming.runId),
    incoming
  ]
    .sort((left, right) => {
      const startedAtDifference = Date.parse(right.startedAt) - Date.parse(left.startedAt);
      return startedAtDifference || right.runId.localeCompare(left.runId);
    })
    .slice(0, Math.max(1, limit));
}

export function mergePlayerSelectionJourneyHistoryRestore(
  current: PlayerSelectionJourneyState,
  incoming: readonly SelectionJourneySnapshot[],
  limit = 20
): PlayerSelectionJourneyState {
  const journeys = incoming.reduce(
    (history, journey) => mergePlayerSelectionJourneyHistory(history, journey, limit),
    current.journeys
  );
  const selectedRunId = current.selectedRunId
    && journeys.some((journey) => journey.runId === current.selectedRunId)
      ? current.selectedRunId
      : journeys[0]?.runId ?? null;
  return { journeys, selectedRunId };
}

export function restorePlayerSelectionJourneyRecoverySnapshot(
  current: PlayerSelectionJourneyState,
  authoritative: readonly SelectionJourneySnapshot[],
  limit = 20
): PlayerSelectionJourneyState {
  const journeys = authoritative.reduce(
    (history, journey) => mergePlayerSelectionJourneyHistory(history, journey, limit),
    [] as SelectionJourneySnapshot[]
  );
  const selectedRunId = current.selectedRunId
    && journeys.some((journey) => journey.runId === current.selectedRunId)
      ? current.selectedRunId
      : journeys[0]?.runId ?? null;
  return { journeys, selectedRunId };
}

export function applyPlayerSelectionJourneySnapshot(
  current: PlayerSelectionJourneyState,
  incoming: SelectionJourneySnapshot,
  limit = 20
): PlayerSelectionJourneyState {
  const incomingWasKnown = current.journeys.some((journey) => journey.runId === incoming.runId);
  const journeys = mergePlayerSelectionJourneyHistory(current.journeys, incoming, limit);
  const currentSelectionExists = current.selectedRunId !== null
    && journeys.some((journey) => journey.runId === current.selectedRunId);
  const incomingIsNewLatest = !incomingWasKnown && journeys[0]?.runId === incoming.runId;
  const selectedRunId = !currentSelectionExists
    ? journeys[0]?.runId ?? null
    : current.selectedRunId === incoming.runId || !incomingIsNewLatest
      ? current.selectedRunId
      : incoming.runId;
  return { journeys, selectedRunId };
}
