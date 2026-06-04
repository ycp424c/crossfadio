import type { MusicCandidate } from './schema.js';

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase();
}

export function scoreCandidate(candidate: MusicCandidate): number {
  const { scores } = candidate;

  const score = (
    scores.intentMatch * 0.3 +
    scores.tasteMatch * 0.2 +
    scores.timeFit * 0.15 +
    scores.planFit * 0.1 +
    scores.sourceConfidence * 0.1 +
    scores.novelty * 0.15 -
    scores.recentPenalty -
    scores.skipPenalty
  );

  return Math.max(0, score);
}

export function diversifyCandidates(candidates: MusicCandidate[], limit: number): MusicCandidate[] {
  const sorted = [...candidates].sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
  const selected: MusicCandidate[] = [];
  const usedArtists = new Set<string>();
  const target = Math.max(0, limit);

  for (const candidate of sorted) {
    if (selected.length >= target) {
      break;
    }

    const artist = primaryArtist(candidate.artist);

    if (usedArtists.has(artist)) {
      continue;
    }

    selected.push({
      ...candidate,
      sources: [...candidate.sources],
      evidence: [...candidate.evidence],
      scores: { ...candidate.scores }
    });
    usedArtists.add(artist);
  }

  return selected;
}
