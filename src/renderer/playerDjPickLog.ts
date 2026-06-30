import {
  getDjPickDoneAddedCount,
  getDjPickDoneTrackNames
} from './playerDjRefill';

type DjTrackSample = { id: string; name: string; artist: string };

type DjSelectedTrack = DjTrackSample & {
  reason: string;
  source: string;
};

export type DjPickLog = {
  likedSample: DjTrackSample[];
  searchQueries: string[];
  searchedTracks: DjTrackSample[];
  selectedTracks: DjSelectedTrack[];
  searchResultCount: number;
  searchRepeatedCount: number;
  searchAddedCount: number;
  searchSelectedCount: number;
  totalCandidates: number;
  selectedSay: string;
};

type DjQueryFunnelEntry = {
  searchedCount: number;
  resultCount: number;
  uniqueResultCount: number;
  addedCount: number;
  selectedCount: number;
};

function numericField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function queryFunnelEntries(value: unknown): DjQueryFunnelEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): DjQueryFunnelEntry | null => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    return {
      searchedCount: numericField(record.searchedCount),
      resultCount: numericField(record.resultCount),
      uniqueResultCount: numericField(record.uniqueResultCount) || numericField(record.resultCount),
      addedCount: numericField(record.addedCount),
      selectedCount: numericField(record.selectedCount)
    };
  }).filter((entry): entry is DjQueryFunnelEntry => entry !== null);
}

export function buildDjPickDebugLog(data: Record<string, unknown>): DjPickLog {
  const queryFunnel = queryFunnelEntries(data.queryFunnel);
  return {
    likedSample: Array.isArray(data.likedSample) ? data.likedSample as DjTrackSample[] : [],
    searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries as string[] : [],
    searchedTracks: Array.isArray(data.searchedTracks) ? data.searchedTracks as DjTrackSample[] : [],
    selectedTracks: Array.isArray(data.selectedTracks) ? data.selectedTracks as DjSelectedTrack[] : [],
    searchResultCount: queryFunnel.reduce((sum, entry) => sum + entry.uniqueResultCount, 0),
    searchRepeatedCount: queryFunnel.reduce((sum, entry) => sum + Math.max(0, entry.searchedCount - 1), 0),
    searchAddedCount: queryFunnel.reduce((sum, entry) => sum + entry.addedCount, 0),
    searchSelectedCount: queryFunnel.reduce((sum, entry) => sum + entry.selectedCount, 0),
    totalCandidates: numericField(data.totalCandidates),
    selectedSay: typeof data.selectedSay === 'string' ? data.selectedSay : ''
  };
}

export function buildDjPickDoneLog(data: Record<string, unknown>): DjPickLog | null {
  const trackNames = getDjPickDoneTrackNames(data);
  const trackIds = Array.isArray(data.trackIds)
    ? data.trackIds.map((id) => String(id))
    : [];
  const addedCount = getDjPickDoneAddedCount(data);
  if (trackNames.length === 0 && addedCount === 0) return null;

  return {
    likedSample: [],
    searchQueries: [],
    searchedTracks: [],
    selectedTracks: trackNames.map((name, index) => ({
      id: trackIds[index] ?? `added-${index + 1}`,
      name,
      artist: '',
      reason: '已加入队列',
      source: 'done'
    })),
    searchResultCount: 0,
    searchRepeatedCount: 0,
    searchAddedCount: 0,
    searchSelectedCount: 0,
    totalCandidates: typeof data.totalCandidates === 'number' ? data.totalCandidates : 0,
    selectedSay: addedCount > 0 ? `本次补充 ${addedCount} 首。` : ''
  };
}
