import { z } from 'zod';

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

export const trackAssessmentSchema = z.object({
  id: z.string().min(1),
  profile: trackSemanticProfileSchema,
  confidence: z.object({
    genres: z.number().min(0).max(1),
    moods: z.number().min(0).max(1),
    energy: z.number().min(0).max(1),
    aggression: z.number().min(0).max(1),
    vocalIntensity: z.number().min(0).max(1),
    lyricThemes: z.number().min(0).max(1),
    language: z.number().min(0).max(1)
  }).strict(),
  evidence: z.array(trackAssessmentEvidenceSchema).max(12)
}).strict();

export type SemanticLevel = z.infer<typeof semanticLevelSchema>;
export type TrackSemanticProfile = z.infer<typeof trackSemanticProfileSchema>;
export type TrackAssessmentEvidence = z.infer<typeof trackAssessmentEvidenceSchema>;
export type TrackAssessment = z.infer<typeof trackAssessmentSchema>;
