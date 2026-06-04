import { finalPickSchema } from './schema.js';
import type { FinalPick, MusicCandidate, MusicCandidateScores } from './schema.js';

export interface CandidatePoolOptions {
  maxCandidates?: number;
  bannedArtists?: string[];
  bannedTrackIds?: string[];
}

type CandidatePoolEntry = {
  candidate: MusicCandidate;
  dedupeKey: string;
};

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function primaryArtist(artist: string): string {
  return artist.split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)[0]?.trim() ?? artist.trim();
}

function artistParts(artist: string): string[] {
  return artist
    .split(/\s*(?:\/|,|，|&| feat\.?| ft\.?| with )\s*/i)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function cloneCandidate(candidate: MusicCandidate): MusicCandidate {
  return {
    ...candidate,
    sources: [...candidate.sources],
    evidence: [...candidate.evidence],
    scores: { ...candidate.scores }
  };
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function mergeScores(left: MusicCandidateScores, right: MusicCandidateScores): MusicCandidateScores {
  return {
    intentMatch: Math.max(left.intentMatch, right.intentMatch),
    tasteMatch: Math.max(left.tasteMatch, right.tasteMatch),
    timeFit: Math.max(left.timeFit, right.timeFit),
    planFit: Math.max(left.planFit, right.planFit),
    novelty: Math.max(left.novelty, right.novelty),
    recentPenalty: Math.max(left.recentPenalty, right.recentPenalty),
    skipPenalty: Math.max(left.skipPenalty, right.skipPenalty),
    sourceConfidence: Math.max(left.sourceConfidence, right.sourceConfidence)
  };
}

function mergeCandidate(existing: MusicCandidate, incoming: MusicCandidate): MusicCandidate {
  return {
    ...existing,
    sources: mergeUnique(existing.sources, incoming.sources),
    evidence: mergeUnique(existing.evidence, incoming.evidence),
    scores: mergeScores(existing.scores, incoming.scores)
  };
}

export function buildCandidateDedupeKey(candidate: MusicCandidate): string {
  return `${normalizeText(candidate.name)}::${normalizeText(primaryArtist(candidate.artist))}`;
}

export class CandidatePool {
  private readonly byId = new Map<string, CandidatePoolEntry>();
  private readonly idByDedupeKey = new Map<string, string>();
  private readonly bannedArtists: Set<string>;
  private readonly bannedTrackIds: Set<string>;
  private readonly maxCandidates: number;

  constructor(options: CandidatePoolOptions = {}) {
    this.maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;
    this.bannedArtists = new Set((options.bannedArtists ?? []).map((artist) => normalizeText(artist)));
    this.bannedTrackIds = new Set(options.bannedTrackIds ?? []);
  }

  upsert(candidate: MusicCandidate): void {
    if (this.isBanned(candidate)) {
      return;
    }

    const dedupeKey = buildCandidateDedupeKey(candidate);
    const existingById = this.byId.get(candidate.id);
    const dedupedId = this.idByDedupeKey.get(dedupeKey);
    const targetEntry = existingById ?? (dedupedId ? this.byId.get(dedupedId) : undefined);

    if (targetEntry) {
      targetEntry.candidate = mergeCandidate(targetEntry.candidate, candidate);
      return;
    }

    if (this.byId.size >= this.maxCandidates) {
      return;
    }

    this.byId.set(candidate.id, {
      candidate: cloneCandidate(candidate),
      dedupeKey
    });
    this.idByDedupeKey.set(dedupeKey, candidate.id);
  }

  get(id: string): MusicCandidate | undefined {
    const entry = this.byId.get(id);
    return entry ? cloneCandidate(entry.candidate) : undefined;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): MusicCandidate[] {
    return [...this.byId.values()].map((entry) => cloneCandidate(entry.candidate));
  }

  count(): number {
    return this.byId.size;
  }

  topBy(fn: (candidate: MusicCandidate) => number, limit: number): MusicCandidate[] {
    return this.list()
      .sort((left, right) => fn(right) - fn(left))
      .slice(0, Math.max(0, limit));
  }

  validateFinalPicks(picks: FinalPick[]): FinalPick[] {
    return picks.map((pick) => {
      const parsedPick = finalPickSchema.parse(pick);
      const candidate = this.byId.get(parsedPick.id)?.candidate;

      if (!candidate) {
        throw new Error(`Final pick ${parsedPick.id} is not in candidate pool`);
      }

      if (!candidate.sources.includes(parsedPick.source)) {
        throw new Error(`Final pick ${parsedPick.id} source mismatch: ${parsedPick.source}`);
      }

      return { ...parsedPick };
    });
  }

  private isBanned(candidate: MusicCandidate): boolean {
    if (this.bannedTrackIds.has(candidate.id)) {
      return true;
    }

    return artistParts(candidate.artist).some((artist) => this.bannedArtists.has(artist));
  }
}

export function validateFinalPicks(picks: FinalPick[], pool: CandidatePool): FinalPick[] {
  return pool.validateFinalPicks(picks);
}
