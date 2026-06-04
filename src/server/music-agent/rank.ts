import type { MusicCandidate } from './schema.js';

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase();
}

export function scoreCandidate(candidate: MusicCandidate): number {
  const { scores } = candidate;

  return (
    scores.intentMatch * 0.3 +
    scores.tasteMatch * 0.2 +
    scores.timeFit * 0.15 +
    scores.planFit * 0.2 +
    scores.novelty * 0.05 +
    scores.sourceConfidence * 0.1 -
    scores.recentPenalty -
    scores.skipPenalty
  );
}

export function diversifyCandidates(candidates: MusicCandidate[], limit: number): MusicCandidate[] {
  const remaining = [...candidates].sort((left, right) => scoreCandidate(right) - scoreCandidate(left));
  const selected: MusicCandidate[] = [];
  const usedArtists = new Set<string>();
  const target = Math.max(0, limit);

  while (selected.length < target && remaining.length > 0) {
    const diverseIndex = remaining.findIndex((candidate) => !usedArtists.has(primaryArtist(candidate.artist)));
    const nextIndex = diverseIndex === -1 ? 0 : diverseIndex;
    const [next] = remaining.splice(nextIndex, 1);

    selected.push({
      ...next,
      sources: [...next.sources],
      evidence: [...next.evidence],
      scores: { ...next.scores }
    });
    usedArtists.add(primaryArtist(next.artist));
  }

  return selected;
}
