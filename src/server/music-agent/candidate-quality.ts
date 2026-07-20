import { hasValidTrackIdentity } from './playback-eligibility.js';
import { resolveTitlePollution } from './rank.js';
import type { MusicCandidate } from './schema.js';
import { hasAutonomousLowQualityTitle } from './title-quality.js';

export type CandidateQualityFacts = {
  lyricStatus: 'available' | 'missing' | 'unknown';
  creditRoleCount: number;
  wikiTags: string[];
  albumName?: string | null;
};

export type CandidateQualityDecision = {
  tier: 'trusted' | 'acceptable' | 'suspicious';
  strongNegativeSignals: string[];
  supportingNegativeSignals: string[];
  positiveSignals: string[];
};

const INSTRUMENTAL_EVIDENCE_PATTERN = /(?:\binstrumental(?: version)?\b|\bno vocals?\b|纯音乐|无人声|伴奏版)/i;
const PLACEHOLDER_ARTIST_PATTERN = /^(?:unknown artist|unknown|various artists?|网络歌手|未知艺人|佚名|群星|群星合辑|v\.?\s*a\.?)$/i;
const SUSPICIOUS_TITLE_PATTERN = /(?:抖音热歌|网络热歌|车载(?:dj|音乐)?|(?:dj|舞曲)串烧|热歌合集|无损合集|karaoke|tribute|sped\s*up|slowed(?:\s*&\s*reverb)?)/i;

export function evaluateCandidateQuality(
  candidate: MusicCandidate,
  facts: CandidateQualityFacts
): CandidateQualityDecision {
  const strongNegativeSignals: string[] = [];
  const supportingNegativeSignals: string[] = [];
  const positiveSignals: string[] = [];
  const strongNegativeCategories = new Set<string>();
  const negativeCategories = new Set<string>();
  const quality = candidate.qualitySignals;
  const albumName = clean(facts.albumName) || clean(quality?.albumName);
  const instrumental = hasInstrumentalQualityEvidence(candidate, facts);
  const autonomousLowQualityTitle = hasAutonomousLowQualityTitle(candidate.name);
  const addStrongNegative = (signal: string, category: string): void => {
    strongNegativeSignals.push(signal);
    strongNegativeCategories.add(category);
    negativeCategories.add(category);
  };
  const addSupportingNegative = (signal: string, category: string): void => {
    supportingNegativeSignals.push(signal);
    negativeCategories.add(category);
  };

  if (quality?.noCopyrightRcmd === true) {
    addSupportingNegative('copyright_recommendation_blocked', 'recommendation');
  }
  if (resolveTitlePollution(candidate) === 'strong') {
    addStrongNegative('strong_title_pollution', 'title');
  }
  if (autonomousLowQualityTitle) {
    addStrongNegative('autonomous_low_quality_title', 'version');
  }
  if (PLACEHOLDER_ARTIST_PATTERN.test(clean(candidate.artist))) {
    addStrongNegative('placeholder_or_collection_artist', 'identity');
  }
  if (!hasValidTrackIdentity(candidate)) {
    addStrongNegative('malformed_track_identity', 'identity');
  }

  if (quality?.popularity !== undefined && quality.popularity < 15) {
    addSupportingNegative('very_low_popularity', 'popularity');
  }
  if (!albumName) {
    addSupportingNegative('missing_album', 'album');
  }
  if (SUSPICIOUS_TITLE_PATTERN.test(candidate.name)) {
    addSupportingNegative('suspicious_title_pattern', 'title');
  }
  if (facts.lyricStatus === 'missing' && !instrumental) {
    addSupportingNegative('missing_lyrics_for_vocal_track', 'lyrics');
  }
  if (facts.creditRoleCount <= 0) {
    addSupportingNegative('missing_credits', 'credits');
  }
  if (!quality || (quality.popularity === undefined && quality.copyright === undefined)) {
    addSupportingNegative('metadata_incomplete', 'metadata');
  }

  if (albumName) positiveSignals.push('normal_album');
  if (!PLACEHOLDER_ARTIST_PATTERN.test(clean(candidate.artist)) && hasValidTrackIdentity(candidate)) {
    positiveSignals.push('normal_artist');
  }
  if (quality?.copyright !== undefined && quality.copyright > 0) {
    positiveSignals.push('copyright_available');
  }
  if (quality?.popularity !== undefined && quality.popularity >= 15) {
    positiveSignals.push('established_popularity');
  }
  if (facts.creditRoleCount > 0) positiveSignals.push('credits_available');
  if (facts.wikiTags.length > 0) positiveSignals.push('wiki_evidence');
  if (facts.lyricStatus === 'available') positiveSignals.push('lyrics_available');
  if (instrumental) positiveSignals.push('instrumental_evidence');

  const tier = autonomousLowQualityTitle
    ? 'suspicious'
    : strongNegativeCategories.size > 0 && negativeCategories.size >= 2
    ? 'suspicious'
    : strongNegativeCategories.size === 0
      && supportingNegativeSignals.length === 0
      && positiveSignals.length >= 3
      ? 'trusted'
      : 'acceptable';

  return {
    tier,
    strongNegativeSignals,
    supportingNegativeSignals,
    positiveSignals
  };
}

function hasInstrumentalQualityEvidence(
  candidate: MusicCandidate,
  facts: CandidateQualityFacts
): boolean {
  return INSTRUMENTAL_EVIDENCE_PATTERN.test(candidate.name)
    || facts.wikiTags.some((tag) => INSTRUMENTAL_EVIDENCE_PATTERN.test(tag));
}

function clean(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? '';
}
