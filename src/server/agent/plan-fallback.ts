import type { PlanOutput } from './schema.js';
import type { PlaylistEntry } from '../user-corpus/loader.js';

type SegmentId = 'morning' | 'work' | 'evening' | 'late-night';

type SegmentConfig = {
  id: SegmentId;
  label: string;
  timeRange: string;
  mood: string;
  energyPct: number;
  tags: string[];
};

const SEGMENT_DEFAULTS: SegmentConfig[] = [
  { id: 'morning', label: '早晨', timeRange: '07:00–09:00', mood: '清醒', energyPct: 45, tags: ['morning', 'indie', 'calm'] },
  { id: 'work', label: '工作', timeRange: '09:00–17:30', mood: '专注', energyPct: 55, tags: ['focus', 'instrumental', 'lofi'] },
  { id: 'evening', label: '傍晚', timeRange: '17:30–21:00', mood: '放松', energyPct: 40, tags: ['chill', 'ambient'] },
  { id: 'late-night', label: '深夜', timeRange: '21:00–02:00', mood: '沉浸', energyPct: 25, tags: ['sleep', 'ambient', 'instrumental'] }
];

/**
 * Generates a minimal plan when LLM is unavailable.
 * Scores playlists against each segment by tag overlap + energy fit,
 * then emits one placeholder track per segment.
 */
export function buildFallbackPlan(date: string, playlists: PlaylistEntry[]): PlanOutput {
  const segments = SEGMENT_DEFAULTS.map((seg) => {
    const best = pickBestPlaylist(seg, playlists);
    return {
      id: seg.id,
      label: seg.label,
      timeRange: seg.timeRange,
      mood: seg.mood,
      energyPct: seg.energyPct,
      tracks: best
        ? [{ query: `playlist:${best.id}`, reason: `来自歌单《${best.name}》的${seg.mood}推荐` }]
        : [{ query: `${seg.mood} music`, reason: '自动推荐' }]
    };
  });

  return {
    mode: 'plan',
    date,
    segments,
    narrative: '（自动生成的兜底计划，LLM 不可用时启用）'
  };
}

function pickBestPlaylist(seg: SegmentConfig, playlists: PlaylistEntry[]): PlaylistEntry | null {
  if (playlists.length === 0) return null;

  const scored = playlists.map((p) => ({
    playlist: p,
    score: scorePlaylist(p, seg)
  }));

  scored.sort((a, b) => b.score - a.score || a.playlist.priority - b.playlist.priority);
  return scored[0].score > 0 ? scored[0].playlist : null;
}

function scorePlaylist(playlist: PlaylistEntry, seg: SegmentConfig): number {
  let score = 0;

  // +2 per matching segment id
  if (playlist.segments.includes(seg.id)) score += 2;

  // +1 per matching tag
  const playlistTags = playlist.tags.map((t) => t.toLowerCase());
  for (const tag of seg.tags) {
    if (playlistTags.includes(tag.toLowerCase())) score += 1;
  }

  // +1 if energy range contains segment energy
  if (playlist.energyRange) {
    const [lo, hi] = playlist.energyRange;
    const energy = seg.energyPct;
    // energyRange in playlists.json uses 0-1 scale OR 0-100 — detect by magnitude
    const normalised = hi <= 1 ? [lo * 100, hi * 100] : [lo, hi];
    if (energy >= normalised[0] && energy <= normalised[1]) score += 1;
  }

  return score;
}
