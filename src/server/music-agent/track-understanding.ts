import { z } from 'zod';
import { candidateSourceSchema, musicCandidateQualitySignalsSchema } from './schema.js';

export const lyricsSelectionModeSchema = z.enum(['off', 'shadow', 'enforce_fit', 'enforce_all']);

export const semanticLevelSchema = z.enum(['low', 'medium', 'high', 'unknown']);

export const trackSemanticProfileSchema = z.object({
  genres: z.array(z.string().max(48)).max(8),
  moods: z.array(z.string().max(48)).max(8),
  energy: semanticLevelSchema,
  aggression: semanticLevelSchema,
  vocalIntensity: semanticLevelSchema,
  lyricThemes: z.array(z.string().max(80)).max(8),
  language: z.string().max(24)
}).strict();

export const trackAssessmentEvidenceSchema = z.object({
  claim: z.string().max(160),
  source: z.enum([
    'wiki_tag',
    'lyric_analysis',
    'lyric_and_genre_analysis',
    'platform_metadata'
  ])
}).strict();

export const trackAssessmentConfidenceSchema = z.object({
  genres: z.number().min(0).max(1),
  moods: z.number().min(0).max(1),
  energy: z.number().min(0).max(1),
  aggression: z.number().min(0).max(1),
  vocalIntensity: z.number().min(0).max(1),
  lyricThemes: z.number().min(0).max(1),
  language: z.number().min(0).max(1)
}).strict();

export const trackAssessmentSchema = z.object({
  id: z.string().min(1),
  profile: trackSemanticProfileSchema,
  confidence: trackAssessmentConfidenceSchema,
  evidence: z.array(trackAssessmentEvidenceSchema).max(12)
}).strict();

const preparedLyricEvidenceBaseSchema = z.object({
  sampleMode: z.enum(['full', 'stratified', 'none']),
  credits: z.record(z.array(z.string())),
  lineCount: z.number().int().nonnegative(),
  hasTranslation: z.boolean(),
  repeatedHookCount: z.number().int().nonnegative(),
  sampledCharCount: z.number().int().nonnegative(),
  sampledLines: z.array(z.object({
    position: z.enum(['opening', 'early', 'middle', 'late', 'ending', 'hook']),
    text: z.string(),
    translation: z.string().optional(),
    repeatCount: z.number().int().positive().optional()
  }).strict())
}).strict();

export const preparedLyricEvidenceSchema = z.discriminatedUnion('lyricStatus', [
  preparedLyricEvidenceBaseSchema.extend({
    lyricHash: z.string(),
    lyricStatus: z.literal('available')
  }).strict(),
  preparedLyricEvidenceBaseSchema.extend({
    lyricHash: z.string(),
    lyricStatus: z.literal('missing')
  }).strict(),
  preparedLyricEvidenceBaseSchema.extend({
    lyricHash: z.null(),
    lyricStatus: z.literal('unknown')
  }).strict()
]);

export const shortlistPromptPacketBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artist: z.string().min(1),
  sources: z.array(candidateSourceSchema).min(1),
  qualitySignals: musicCandidateQualitySignalsSchema.optional()
}).strict();

export const shortlistBasePromptPacketSchema = shortlistPromptPacketBaseSchema.extend({
  kind: z.literal('base')
}).strict();

export const shortlistProfilePromptPacketSchema = shortlistPromptPacketBaseSchema.extend({
  kind: z.literal('profile'),
  assessment: trackAssessmentSchema
}).strict();

export const shortlistEvidencePromptPacketSchema = shortlistPromptPacketBaseSchema.extend({
  kind: z.literal('evidence'),
  lyricEvidence: preparedLyricEvidenceSchema,
  wikiTags: z.array(z.string().max(80)).max(8)
}).strict();

export const shortlistPromptPacketSchema = z.discriminatedUnion('kind', [
  shortlistBasePromptPacketSchema,
  shortlistProfilePromptPacketSchema,
  shortlistEvidencePromptPacketSchema
]);

export const finalShortlistEnrichmentDiagnosticsSchema = z.object({
  shortlistCount: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  lyricAttempted: z.number().int().nonnegative(),
  lyricSuccess: z.number().int().nonnegative(),
  lyricMissing: z.number().int().nonnegative(),
  lyricFail: z.number().int().nonnegative(),
  lyricTimeout: z.number().int().nonnegative(),
  lyricCancelled: z.number().int().nonnegative(),
  wikiAttempted: z.number().int().nonnegative(),
  wikiSuccess: z.number().int().nonnegative(),
  wikiFail: z.number().int().nonnegative(),
  wikiTimeout: z.number().int().nonnegative(),
  wikiCancelled: z.number().int().nonnegative(),
  cacheWriteFailed: z.number().int().nonnegative(),
  sampledChars: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  deadlineReached: z.boolean()
}).strict();

export type SemanticLevel = z.infer<typeof semanticLevelSchema>;
export type LyricsSelectionMode = z.infer<typeof lyricsSelectionModeSchema>;
export type TrackSemanticProfile = z.infer<typeof trackSemanticProfileSchema>;
export type TrackAssessmentEvidence = z.infer<typeof trackAssessmentEvidenceSchema>;
export type TrackAssessmentConfidence = z.infer<typeof trackAssessmentConfidenceSchema>;
export type TrackAssessment = z.infer<typeof trackAssessmentSchema>;
export type ShortlistPromptPacket = z.infer<typeof shortlistPromptPacketSchema>;
export type ShortlistBasePromptPacket = z.infer<typeof shortlistBasePromptPacketSchema>;
export type ShortlistProfilePromptPacket = z.infer<typeof shortlistProfilePromptPacketSchema>;
export type ShortlistEvidencePromptPacket = z.infer<typeof shortlistEvidencePromptPacketSchema>;
export type FinalShortlistEnrichmentDiagnostics = z.infer<typeof finalShortlistEnrichmentDiagnosticsSchema>;
