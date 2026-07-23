import { z } from 'zod';
import {
  djMemorySnapshotMetadataSchema,
  SELECTION_ROTATION_HISTORY_PICK_LIMIT
} from '../../shared/dj-memory.js';
import { LISTENING_EPISODE_DAILY_LIMIT } from '../../shared/listening.js';
import { SELECTION_PRESSURE_WINDOW_DAYS } from '../music-agent/selection-pressure.js';

export const DJ_MEMORY_UPCOMING_TRACK_LIMIT = 50;
export const DJ_MEMORY_LISTENING_EPISODE_LIMIT = 200;
export const DJ_MEMORY_SELECTION_PRESSURE_LIMIT = LISTENING_EPISODE_DAILY_LIMIT
  * (SELECTION_PRESSURE_WINDOW_DAYS + 1);

export const djMemoryTrackSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(300).default(''),
  artists: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  durationMs: z.number().int().nonnegative().optional(),
  coverImgUrl: z.string().nullable().optional()
}).strict();

export const djMemorySessionItemSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum([
    'request_summary',
    'selection_reason',
    'segue_summary',
    'directive_history',
    'queue_action'
  ]),
  text: z.string().trim().min(1).max(1000),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const djMemorySnapshotSchema = z.object({
  metadata: djMemorySnapshotMetadataSchema,
  queue: z.object({
    currentTrack: djMemoryTrackSchema.nullable(),
    upcoming: z.array(djMemoryTrackSchema).max(DJ_MEMORY_UPCOMING_TRACK_LIMIT)
  }).strict(),
  listeningEpisodes: z.array(z.object({
    id: z.string().min(1),
    trackId: z.string().min(1),
    trackName: z.string().max(300),
    primaryArtist: z.string().max(300).nullable(),
    positionMs: z.number().int().nonnegative().optional(),
    listenedMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['completed', 'skipped', 'failed', 'interrupted']).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable().optional(),
    legacyExposureOverride: z.number().min(0).max(1).nullable().optional()
  }).strict()).max(DJ_MEMORY_LISTENING_EPISODE_LIMIT),
  selectionPressure: z.object({
    tracks: z.array(z.object({
      trackKey: z.string().min(1).max(700),
      primaryArtist: z.string().max(300),
      earlySkipObservationCount: z.number().int().nonnegative(),
      earlySkipEffectiveCount: z.number().nonnegative(),
      latestEarlySkipAt: z.string().datetime({ offset: true }).nullable(),
      exposureEffective: z.number().nonnegative()
    }).strict()).max(DJ_MEMORY_SELECTION_PRESSURE_LIMIT),
    artists: z.array(z.object({
      primaryArtist: z.string().max(300),
      earlySkipDistinctTrackCount: z.number().int().nonnegative(),
      earlySkipEffectiveCount: z.number().nonnegative(),
      exposureEffective: z.number().nonnegative()
    }).strict()).max(DJ_MEMORY_SELECTION_PRESSURE_LIMIT)
  }).strict().default({ tracks: [], artists: [] }),
  rotation: z.object({
    currentRound: z.number().int().nonnegative(),
    picks: z.array(z.object({
      runId: z.string().trim().min(1).max(200),
      roundNumber: z.number().int().nonnegative(),
      pickOrder: z.number().int().positive(),
      trackId: z.string().trim().min(1).max(200),
      trackName: z.string().trim().min(1).max(300),
      artistDisplay: z.string().max(1000),
      trackKey: z.string().trim().min(1).max(700),
      artistKeys: z.array(z.string().trim().min(1).max(300)).max(20),
      selectedAt: z.string().datetime({ offset: true })
    }).strict()).max(SELECTION_ROTATION_HISTORY_PICK_LIMIT)
  }).strict().default({ currentRound: 0, picks: [] }),
  preferences: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['expressed', 'inferred']),
    subjectType: z.string().min(1).max(40),
    subjectKey: z.string().min(1).max(300),
    polarity: z.enum(['positive', 'negative']),
    score: z.number().min(0).max(1),
    observedAt: z.string().datetime({ offset: true }),
    evidenceIds: z.array(z.string().min(1).max(200)).max(20).default([])
  }).strict()).max(100),
  tasteProfile: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    summary: z.string().min(1).max(20_000),
    generatedAt: z.string().datetime({ offset: true })
  }).strict().nullable(),
  activeDirective: z.object({
    text: z.string().trim().min(1).max(800),
    expiresAt: z.string().datetime({ offset: true })
  }).strict().nullable(),
  explicitExclusions: z.array(z.object({
    id: z.string().min(1),
    entityType: z.enum(['track', 'artist']),
    entityKey: z.string().min(1).max(300),
    provider: z.string().min(1).max(40).nullable().optional(),
    providerId: z.string().min(1).max(200).nullable().optional(),
    displayName: z.string().max(300).nullable()
  }).strict()).max(500),
  temporaryExclusions: z.array(z.object({
    id: z.string().min(1),
    name: z.string().max(300),
    artists: z.array(z.string().max(300)).max(20),
    expiresAt: z.string().datetime({ offset: true })
  }).strict()).max(100),
  personalContext: z.object({
    id: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
    summary: z.string().min(1).max(1200),
    currentState: z.object({
      activity: z.string().max(120).optional(),
      energy: z.enum(['low', 'medium', 'high']).optional(),
      attention: z.enum(['low_distraction', 'normal', 'high_stimulation']).optional(),
      mood: z.string().max(160).optional()
    }).strict().default({}),
    musicGuidance: z.object({
      energyCurve: z.enum(['downshift', 'steady', 'uplift', 'mixed']).optional(),
      preferredTextures: z.array(z.string().max(80)).max(12),
      avoidTextures: z.array(z.string().max(80)).max(12),
      vocalPreference: z.enum(['vocal', 'instrumental', 'mixed', 'unknown']).optional(),
      novelty: z.enum(['comfort', 'balanced', 'explore']).optional()
    }).strict(),
    musicHints: z.array(z.object({
      kind: z.enum(['artist', 'track', 'style', 'scene']),
      label: z.string().min(1).max(160),
      strength: z.enum(['weak', 'medium', 'strong']),
      reason: z.string().min(1).max(300)
    }).strict()).max(12).default([]),
    segueGuidance: z.object({
      tone: z.string().max(240).optional(),
      privacyRule: z.string().min(1).max(500)
    }).strict()
  }).strict().nullable(),
  selectionContext: z.object({
    discoveryMode: z.enum(['explore', 'comfort']),
    dailyTheme: z.object({
      theme: z.string().min(1).max(120),
      keywords: z.array(z.string().min(1).max(80)).max(12)
    }).strict().nullable()
  }).strict().default({ discoveryMode: 'explore', dailyTheme: null }),
  retrievalHistory: z.array(z.object({
    query: z.string().min(1).max(300),
    source: z.string().min(1).max(80),
    selectedCount: z.number().int().nonnegative(),
    attemptedAt: z.string().datetime({ offset: true })
  }).strict()).max(200),
  configuration: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1).max(80),
    key: z.string().min(1).max(200),
    value: z.unknown()
  }).strict()).max(100),
  sessionLog: z.array(djMemorySessionItemSchema).max(20),
  currentMoment: z.object({
    iso: z.string().datetime({ offset: true }),
    localTime: z.string().min(1).max(100),
    daypart: z.string().min(1).max(40)
  }).strict(),
  weather: z.object({
    location: z.string().max(300),
    tempC: z.number().finite(),
    desc: z.string().max(300)
  }).strict().nullable()
}).strict();

export type DjMemorySnapshot = z.infer<typeof djMemorySnapshotSchema>;
export type DjMemorySessionItem = z.infer<typeof djMemorySessionItemSchema>;
