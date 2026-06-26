import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('crossfadio-local-brain'),
  uptimeSec: z.number().nonnegative(),
  dbReady: z.boolean(),
  timestamp: z.string()
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const wsAuthSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1)
});

export type WsAuthMessage = z.infer<typeof wsAuthSchema>;

export const NCM_QR_CODE = {
  EXPIRED: 800,
  WAITING: 801,
  SCANNED: 802,
  AUTHORIZED: 803
} as const;

export type NcmQrCode = (typeof NCM_QR_CODE)[keyof typeof NCM_QR_CODE];

export const NCM_QR_HINT = {
  [NCM_QR_CODE.EXPIRED]: 'expired',
  [NCM_QR_CODE.WAITING]: 'waiting',
  [NCM_QR_CODE.SCANNED]: 'scanned',
  [NCM_QR_CODE.AUTHORIZED]: 'authorized'
} as const satisfies Record<NcmQrCode, string>;

export type NcmQrHint = (typeof NCM_QR_HINT)[NcmQrCode] | 'forbidden';

export const ncmQrStatusSchema = z.object({
  code: z.union([
    z.literal(NCM_QR_CODE.EXPIRED),
    z.literal(NCM_QR_CODE.WAITING),
    z.literal(NCM_QR_CODE.SCANNED),
    z.literal(NCM_QR_CODE.AUTHORIZED)
  ]),
  hint: z.enum(['expired', 'waiting', 'scanned', 'authorized', 'forbidden']),
  message: z.string(),
  hasCookie: z.boolean(),
  token: z.string().optional()
});

export type NcmQrStatus = z.infer<typeof ncmQrStatusSchema>;

export const NCM_ERROR_CODE = {
  UNAVAILABLE: 'NCM_E_UNAVAILABLE',
  TIMEOUT: 'NCM_E_TIMEOUT',
  BAD_RESPONSE: 'NCM_E_BAD_RESPONSE',
  UNAUTHORIZED: 'NCM_E_UNAUTHORIZED',
  COOKIE_EXPIRED: 'NCM_E_COOKIE_EXPIRED',
  RATE_LIMITED: 'NCM_E_RATE_LIMITED',
  UNKNOWN: 'NCM_E_UNKNOWN'
} as const;

export type NcmErrorCode = (typeof NCM_ERROR_CODE)[keyof typeof NCM_ERROR_CODE];

export const ncmErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    NCM_ERROR_CODE.UNAVAILABLE,
    NCM_ERROR_CODE.TIMEOUT,
    NCM_ERROR_CODE.BAD_RESPONSE,
    NCM_ERROR_CODE.UNAUTHORIZED,
    NCM_ERROR_CODE.COOKIE_EXPIRED,
    NCM_ERROR_CODE.RATE_LIMITED,
    NCM_ERROR_CODE.UNKNOWN
  ]),
  message: z.string()
});

export type NcmErrorResponse = z.infer<typeof ncmErrorResponseSchema>;

export const ncmSongSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  artists: z.array(z.string()).default([])
});

export type NcmSong = z.infer<typeof ncmSongSchema>;

export const ncmTrackQualitySignalsSchema = z.object({
  popularity: z.number().min(0).max(100).optional(),
  fee: z.number().int().optional(),
  copyright: z.number().int().optional(),
  noCopyrightRcmd: z.boolean().optional(),
  privilegeSt: z.number().int().optional(),
  privilegeToast: z.boolean().optional(),
  albumName: z.string().optional(),
  originCoverType: z.number().int().optional(),
  publishTime: z.number().int().optional(),
  mv: z.boolean().optional()
});

export type NcmTrackQualitySignals = z.infer<typeof ncmTrackQualitySignalsSchema>;

export const ncmSearchResponseSchema = z
  .object({
    result: z
      .object({
        songs: z
          .array(
            z.object({
              id: z.number().int().positive(),
              name: z.string(),
              ar: z
                .array(z.object({ name: z.string().optional() }).passthrough())
                .optional()
            })
          )
          .optional()
      })
      .optional()
  })
  .passthrough();

export const ncmArtistSearchResponseSchema = z
  .object({
    result: z
      .object({
        artists: z
          .array(z.object({
            id: z.number().int().positive(),
            name: z.string()
          }).passthrough())
          .optional()
      })
      .optional()
  })
  .passthrough();

export type NcmArtistSearchResult = {
  id: number;
  name: string;
};

export const ncmAlbumSearchResponseSchema = z
  .object({
    result: z
      .object({
        albums: z
          .array(z.object({
            id: z.number().int().positive(),
            name: z.string(),
            artist: z.object({ name: z.string().optional() }).passthrough().optional()
          }).passthrough())
          .optional()
      })
      .optional()
  })
  .passthrough();

export const ncmArtistAlbumsResponseSchema = z
  .object({
    hotAlbums: z
      .array(z.object({
        id: z.number().int().positive(),
        name: z.string(),
        artist: z.object({ name: z.string().optional() }).passthrough().optional()
      }).passthrough())
      .default([])
  })
  .passthrough();

export type NcmAlbumSearchResult = {
  id: number;
  name: string;
  artist: string | null;
};

export const ncmPlaylistSearchResponseSchema = z
  .object({
    result: z
      .object({
        playlists: z
          .array(z.object({
            id: z.number().int().positive(),
            name: z.string(),
            trackCount: z.number().int().nonnegative().optional(),
            coverImgUrl: z.string().nullable().optional()
          }).passthrough())
          .optional()
      })
      .optional()
  })
  .passthrough();

export type NcmPlaylistSearchResult = {
  id: number;
  name: string;
  trackCount: number;
  coverImgUrl: string | null;
};

export const ncmSongUrlSchema = z.object({
  id: z.number().int().positive(),
  url: z.string().url().nullable(),
  br: z.number().int().nonnegative().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  type: z.string().nullable().optional(),
  expireAt: z.number().int().nullable().optional()
});

export type NcmSongUrl = z.infer<typeof ncmSongUrlSchema>;

export const ncmSongUrlResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            url: z.string().nullable(),
            br: z.number().nullable().optional(),
            size: z.number().nullable().optional(),
            type: z.string().nullable().optional(),
            expi: z.number().nullable().optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

export const ncmLyricSchema = z.object({
  id: z.string(),
  lyric: z.string(),
  translation: z.string().nullable()
});

export type NcmLyric = z.infer<typeof ncmLyricSchema>;

export const ncmLyricResponseSchema = z
  .object({
    lrc: z.object({ lyric: z.string().optional() }).passthrough().optional(),
    tlyric: z.object({ lyric: z.string().optional() }).passthrough().optional()
  })
  .passthrough();

export const ncmPlaylistTrackSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  artists: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative(),
  coverImgUrl: z.string().nullable().optional(),
  qualitySignals: ncmTrackQualitySignalsSchema.optional()
});

export type NcmPlaylistTrack = z.infer<typeof ncmPlaylistTrackSchema>;

export const ncmPlaylistDetailSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  coverImgUrl: z.string().nullable(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(ncmPlaylistTrackSchema)
});

export type NcmPlaylistDetail = z.infer<typeof ncmPlaylistDetailSchema>;

export const ncmPlaylistDetailResponseSchema = z
  .object({
    playlist: z
      .object({
        id: z.number().int().positive(),
        name: z.string(),
        coverImgUrl: z.string().nullable().optional(),
        trackCount: z.number().int().nonnegative().optional(),
        tracks: z
          .array(
            z
              .object({
                id: z.number().int().positive(),
                name: z.string(),
                dt: z.number().int().nonnegative().optional(),
                ar: z
                  .array(z.object({ name: z.string().optional() }).passthrough())
                  .optional(),
                al: z
                  .object({
                    name: z.string().optional(),
                    picUrl: z.string().nullable().optional()
                  })
                  .passthrough()
                  .optional(),
                pop: z.number().optional(),
                fee: z.number().int().optional(),
                copyright: z.number().int().optional(),
                noCopyrightRcmd: z.unknown().nullable().optional(),
                privilege: z
                  .object({
                    st: z.number().int().optional(),
                    toast: z.boolean().optional()
                  })
                  .passthrough()
                  .optional(),
                originCoverType: z.number().int().optional(),
                publishTime: z.number().int().optional(),
                mv: z.number().int().optional()
              })
              .passthrough()
          )
          .default([])
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const ncmLikedIdsResponseSchema = z
  .object({
    ids: z.array(z.number().int().positive()).default([])
  })
  .passthrough();

export const ncmSongDetailResponseSchema = z
  .object({
    songs: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string(),
            dt: z.number().int().nonnegative().optional(),
            ar: z
              .array(z.object({ name: z.string().optional() }).passthrough())
              .optional(),
            al: z
              .object({
                name: z.string().optional(),
                picUrl: z.string().nullable().optional()
              })
              .passthrough()
              .optional(),
            pop: z.number().optional(),
            fee: z.number().int().optional(),
            copyright: z.number().int().optional(),
            noCopyrightRcmd: z.unknown().nullable().optional(),
            privilege: z
              .object({
                st: z.number().int().optional(),
                toast: z.boolean().optional()
              })
              .passthrough()
              .optional(),
            originCoverType: z.number().int().optional(),
            publishTime: z.number().int().optional(),
            mv: z.number().int().optional()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export const ncmArtistTopSongsResponseSchema = z
  .object({
    songs: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string(),
            dt: z.number().int().nonnegative().optional(),
            ar: z
              .array(z.object({ name: z.string().optional() }).passthrough())
              .optional(),
            al: z
              .object({
                name: z.string().optional(),
                picUrl: z.string().nullable().optional()
              })
              .passthrough()
              .optional(),
            pop: z.number().optional(),
            fee: z.number().int().optional(),
            copyright: z.number().int().optional(),
            noCopyrightRcmd: z.unknown().nullable().optional(),
            privilege: z
              .object({
                st: z.number().int().optional(),
                toast: z.boolean().optional()
              })
              .passthrough()
              .optional(),
            originCoverType: z.number().int().optional(),
            publishTime: z.number().int().optional(),
            mv: z.number().int().optional()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export const ncmAlbumDetailResponseSchema = z
  .object({
    album: z
      .object({
        id: z.number().int().positive(),
        name: z.string(),
        artist: z.object({ name: z.string().optional() }).passthrough().optional()
      })
      .passthrough()
      .optional(),
    songs: ncmArtistTopSongsResponseSchema.shape.songs
  })
  .passthrough();

export type NcmAlbumDetail = {
  id: number;
  name: string;
  artist: string | null;
  tracks: NcmPlaylistTrack[];
};

export const queueTrackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  artists: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative(),
  coverImgUrl: z.string().nullable().optional()
});

export type QueueTrackDto = z.infer<typeof queueTrackSchema>;

export const likedQueueResponseSchema = z.object({
  ok: z.literal(true),
  source: z.literal('ncm-liked'),
  tracks: z.array(queueTrackSchema),
  currentIndex: z.number().int().nonnegative()
});

export type LikedQueueResponse = z.infer<typeof likedQueueResponseSchema>;

export const playbackTimingSchema = z.object({
  prefetchLeadSec: z.number().positive(),
  crossfadeSec: z.number().positive(),
  segueLeadSec: z.number().positive()
});

export type PlaybackTiming = z.infer<typeof playbackTimingSchema>;

export const nowPlayingResponseSchema = z.object({
  ok: z.literal(true),
  ncmId: z.string().min(1),
  url: z.string().url(),
  coverImgUrl: z.string().nullable().optional(),
  durationMs: z.number().int().positive().nullable(),
  lyric: z.string().nullable(),
  translation: z.string().nullable(),
  timing: playbackTimingSchema
});

export type NowPlayingResponse = z.infer<typeof nowPlayingResponseSchema>;

export const nextTrackResponseSchema = z.object({
  ok: z.literal(true),
  track: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    artists: z.array(z.string()).optional(),
    coverImgUrl: z.string().nullable().optional()
  }),
  url: z.string().url(),
  durationMs: z.number().int().positive().nullable(),
  timing: playbackTimingSchema
});

export type NextTrackResponse = z.infer<typeof nextTrackResponseSchema>;
