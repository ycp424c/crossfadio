import { getDb } from './db.js';

export type MusicQueryStatsRecord = {
  user_id: string;
  normalized_query: string;
  display_query: string;
  source: string;
  searched_count: number;
  result_count: number;
  added_count: number;
  selected_count: number;
  last_used_order: number;
  last_used_at: string;
  updated_at: string;
};

export type MusicQueryFunnelStatInput = {
  query: string;
  normalizedQuery: string;
  source: string;
  searchedCount: number;
  resultCount: number;
  addedCount: number;
  selectedCount: number;
};

export function getUserQueryStats(userId: string): MusicQueryStatsRecord[] {
  return getDb()
    .prepare<[string], MusicQueryStatsRecord>(
      `SELECT user_id, normalized_query, display_query, source,
              searched_count, result_count, added_count, selected_count,
              last_used_order, last_used_at, updated_at
       FROM music_query_stats
       WHERE user_id = ?
       ORDER BY last_used_order DESC, updated_at DESC`
    )
    .all(userId);
}

export function recordMusicQueryFunnel(userId: string, entries: MusicQueryFunnelStatInput[]): void {
  const validEntries = entries
    .filter((entry) => entry.query.trim() && entry.normalizedQuery.trim() && entry.searchedCount > 0)
    .map((entry) => ({
      ...entry,
      query: entry.query.trim(),
      normalizedQuery: entry.normalizedQuery.trim(),
      searchedCount: Math.max(0, Math.floor(entry.searchedCount)),
      resultCount: Math.max(0, Math.floor(entry.resultCount)),
      addedCount: Math.max(0, Math.floor(entry.addedCount)),
      selectedCount: Math.max(0, Math.floor(entry.selectedCount))
    }));

  if (validEntries.length === 0) return;

  const db = getDb();
  const transaction = db.transaction(() => {
    let nextOrder = getNextUserQueryOrder(userId);
    const statement = db.prepare(
      `INSERT INTO music_query_stats (
         user_id, normalized_query, display_query, source,
         searched_count, result_count, added_count, selected_count,
         last_used_order, last_used_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, normalized_query, source) DO UPDATE SET
         display_query = excluded.display_query,
         searched_count = music_query_stats.searched_count + excluded.searched_count,
         result_count = music_query_stats.result_count + excluded.result_count,
         added_count = music_query_stats.added_count + excluded.added_count,
         selected_count = music_query_stats.selected_count + excluded.selected_count,
         last_used_order = excluded.last_used_order,
         last_used_at = datetime('now'),
         updated_at = datetime('now')`
    );

    for (const entry of validEntries) {
      nextOrder += 1;
      statement.run(
        userId,
        entry.normalizedQuery,
        entry.query,
        entry.source,
        entry.searchedCount,
        entry.resultCount,
        entry.addedCount,
        entry.selectedCount,
        nextOrder
      );
    }
  });

  transaction();
}

function getNextUserQueryOrder(userId: string): number {
  const row = getDb()
    .prepare<[string], { max_order: number | null }>(
      `SELECT MAX(last_used_order) AS max_order FROM music_query_stats WHERE user_id = ?`
    )
    .get(userId);
  return row?.max_order ?? 0;
}
