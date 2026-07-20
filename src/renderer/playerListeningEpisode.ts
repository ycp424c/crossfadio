export type PlayerListeningTrack = {
  id: string;
  name: string;
  artists: string[];
};

export type PlayerSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type PlayerFinalizationStorage = PlayerSessionStorage & {
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
};

const PLAYER_INSTANCE_ID_KEY = 'crossfadio_player_instance_id_v2';
const FINALIZE_MAX_ATTEMPTS = 2;
const FINALIZATION_OUTBOX_PREFIX = 'crossfadio_listening_finalize_outbox_v2:';
const FINALIZATION_OUTBOX_LIMIT = 20;

export function listeningUserIdFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof decoded.sub === 'string' && decoded.sub.trim() ? decoded.sub.trim() : null;
  } catch {
    return null;
  }
}

export function getOrCreatePlayerInstanceId(
  storage: PlayerSessionStorage,
  randomId: () => string = () => crypto.randomUUID()
): string {
  const stored = storage.getItem(PLAYER_INSTANCE_ID_KEY)?.trim();
  if (stored) return stored;
  const created = randomId();
  storage.setItem(PLAYER_INSTANCE_ID_KEY, created);
  return created;
}

export type PlayerListeningEpisodeTransport = {
  create(
    clientEpisodeId: string,
    input: {
      playerInstanceId: string;
      deckId: string;
      track: PlayerListeningTrack;
      durationMs: number | null;
      checkpointSeq: 0;
    },
    options?: PlayerListeningRequestOptions
  ): Promise<void>;
  checkpoint(
    clientEpisodeId: string,
    input: PlayerListeningCheckpoint,
    options?: PlayerListeningRequestOptions
  ): Promise<void>;
  checkpointKeepalive?(
    clientEpisodeId: string,
    input: {
      create: PlayerListeningCreate;
      checkpoint: PlayerListeningCheckpoint;
    },
    options?: PlayerListeningRequestOptions
  ): Promise<void>;
  finalize(
    clientEpisodeId: string,
    input: PlayerListeningCheckpoint & { outcome: PlayerListeningOutcome },
    options?: PlayerListeningRequestOptions
  ): Promise<void>;
};

export type PlayerListeningOutcome = 'completed' | 'skipped' | 'failed' | 'interrupted';

export type PlayerListeningRequestOptions = {
  keepalive?: boolean;
};

export type PlayerListeningPosition = {
  positionMs: number;
  durationMs: number | null;
};

export type PlayerListeningCheckpoint = PlayerListeningPosition & {
  checkpointSeq: number;
  listenedMs: number;
};

export type PlayerListeningEpisode = {
  prepare(input: { track: PlayerListeningTrack; deckId: string }): void;
  playing(input: PlayerListeningPosition): void;
  progress(input: PlayerListeningPosition): void;
  checkpoint(input: PlayerListeningPosition, options?: PlayerListeningRequestOptions): void;
  pause(input: PlayerListeningPosition): void;
  finalize(outcome: PlayerListeningOutcome, input: PlayerListeningPosition): void;
  retryPendingFinalizations(): void;
  settle(): Promise<void>;
};

type PlayerListeningCreate = {
  playerInstanceId: string;
  deckId: string;
  track: PlayerListeningTrack;
  durationMs: number | null;
  checkpointSeq: 0;
};

type DurableFinalization = {
  clientEpisodeId: string;
  create: PlayerListeningCreate;
  finalize: PlayerListeningCheckpoint & { outcome: PlayerListeningOutcome };
};

export function createPlayerListeningEpisode(options: {
  userId: string;
  playerInstanceId: string;
  createClientEpisodeId: () => string;
  now: () => number;
  transport: PlayerListeningEpisodeTransport;
  finalizationStorage?: PlayerFinalizationStorage;
}): PlayerListeningEpisode {
  const checkpointIntervalMs = 15_000;
  let prepared: {
    clientEpisodeId: string;
    track: PlayerListeningTrack;
    deckId: string;
    started: boolean;
    created: boolean;
    finalized: boolean;
    finalizedOutcome: PlayerListeningOutcome | null;
    checkpointSeq: number;
    listenedMs: number;
    playingSinceMs: number | null;
    pending: Promise<void>;
    createInFlight: Promise<void> | null;
  } | null = null;
  const operationTasks = new Set<Promise<void>>();
  const finalizationTasks = new Set<Promise<void>>();
  const outboxUserPrefix = `${FINALIZATION_OUTBOX_PREFIX}${encodeURIComponent(options.userId.trim())}:`;
  const outboxKey = `${outboxUserPrefix}${options.playerInstanceId}`;

  const enqueue = (
    episode: NonNullable<typeof prepared>,
    operation: () => Promise<void>
  ): void => {
    const task = episode.pending.then(operation, operation).catch(() => undefined);
    episode.pending = task;
    operationTasks.add(task);
    void task.finally(() => operationTasks.delete(task));
  };

  const ensureCreated = async (
    episode: NonNullable<typeof prepared>,
    durationMs: number | null
  ): Promise<void> => {
    if (episode.created) return;
    if (!episode.createInFlight) {
      const task = options.transport.create(episode.clientEpisodeId, {
        playerInstanceId: options.playerInstanceId,
        deckId: episode.deckId,
        track: episode.track,
        durationMs,
        checkpointSeq: 0
      }).then(() => {
        episode.created = true;
      }).finally(() => {
        if (episode.createInFlight === task) episode.createInFlight = null;
      });
      episode.createInFlight = task;
    }
    await episode.createInFlight;
  };

  const createPayload = (
    episode: NonNullable<typeof prepared>,
    durationMs: number | null
  ): PlayerListeningCreate => ({
    playerInstanceId: options.playerInstanceId,
    deckId: episode.deckId,
    track: episode.track,
    durationMs,
    checkpointSeq: 0
  });

  const persistFinalization = (entry: DurableFinalization): void => {
    const storage = options.finalizationStorage;
    if (!storage) return;
    try {
      const entries = readFinalizationOutbox(storage, outboxKey)
        .filter((item) => item.clientEpisodeId !== entry.clientEpisodeId);
      storage.setItem(outboxKey, JSON.stringify([...entries, entry].slice(-FINALIZATION_OUTBOX_LIMIT)));
    } catch {
      // Network delivery still proceeds when browser storage is unavailable.
    }
  };

  const removeFinalization = (clientEpisodeId: string, storageKey = outboxKey): void => {
    const storage = options.finalizationStorage;
    if (!storage) return;
    try {
      const entries = readFinalizationOutbox(storage, storageKey)
        .filter((item) => item.clientEpisodeId !== clientEpisodeId);
      if (entries.length === 0) storage.removeItem(storageKey);
      else storage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // A later retry can safely deliver the same idempotent terminal state.
    }
  };

  const deliverFinalization = async (
    entry: DurableFinalization,
    ensureCurrentCreated?: () => Promise<void>,
    storageKey = outboxKey
  ): Promise<void> => {
    for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
      try {
        if (ensureCurrentCreated) await ensureCurrentCreated();
        else await options.transport.create(entry.clientEpisodeId, entry.create);
        await options.transport.finalize(entry.clientEpisodeId, entry.finalize, { keepalive: true });
        removeFinalization(entry.clientEpisodeId, storageKey);
        return;
      } catch (error) {
        if (attempt === FINALIZE_MAX_ATTEMPTS) throw error;
      }
    }
  };

  const launchFinalization = (
    entry: DurableFinalization,
    ensureCurrentCreated?: () => Promise<void>,
    storageKey = outboxKey
  ): void => {
    const task = deliverFinalization(entry, ensureCurrentCreated, storageKey)
      .catch(() => undefined)
      .finally(() => {
        finalizationTasks.delete(task);
      });
    finalizationTasks.add(task);
  };

  const retryPendingFinalizations = (): void => {
    const storage = options.finalizationStorage;
    if (!storage) return;
    const pendingByEpisodeId = new Map<string, { entry: DurableFinalization; storageKey: string }>();
    for (const storageKey of listFinalizationOutboxKeys(storage, outboxUserPrefix, outboxKey)) {
      for (const entry of readFinalizationOutbox(storage, storageKey)) {
        if (!pendingByEpisodeId.has(entry.clientEpisodeId)) {
          pendingByEpisodeId.set(entry.clientEpisodeId, { entry, storageKey });
        }
      }
    }
    for (const { entry, storageKey } of pendingByEpisodeId.values()) {
      launchFinalization(entry, undefined, storageKey);
    }
  };

  retryPendingFinalizations();

  const stopPlaying = (episode: NonNullable<typeof prepared>): void => {
    if (episode.playingSinceMs === null) return;
    episode.listenedMs += Math.max(0, options.now() - episode.playingSinceMs);
    episode.playingSinceMs = null;
  };

  const nextCheckpoint = (
    episode: NonNullable<typeof prepared>,
    input: PlayerListeningPosition
  ): PlayerListeningCheckpoint => {
    episode.checkpointSeq += 1;
    return {
      checkpointSeq: episode.checkpointSeq,
      listenedMs: protocolMilliseconds(episode.listenedMs),
      positionMs: protocolMilliseconds(input.positionMs),
      durationMs: input.durationMs === null ? null : protocolMilliseconds(input.durationMs)
    };
  };

  return {
    prepare(input) {
      prepared = {
        clientEpisodeId: options.createClientEpisodeId(),
        track: input.track,
        deckId: input.deckId,
        started: false,
        created: false,
        finalized: false,
        finalizedOutcome: null,
        checkpointSeq: 0,
        listenedMs: 0,
        playingSinceMs: null,
        pending: Promise.resolve(),
        createInFlight: null
      };
    },
    playing(input) {
      let episode = prepared;
      if (episode?.finalized && episode.finalizedOutcome === 'failed') {
        episode = {
          clientEpisodeId: options.createClientEpisodeId(),
          track: episode.track,
          deckId: episode.deckId,
          started: false,
          created: false,
          finalized: false,
          finalizedOutcome: null,
          checkpointSeq: 0,
          listenedMs: 0,
          playingSinceMs: null,
          pending: Promise.resolve(),
          createInFlight: null
        };
        prepared = episode;
      }
      if (!episode || episode.finalized || episode.playingSinceMs !== null) return;
      episode.started = true;
      episode.playingSinceMs = options.now();
      enqueue(episode, () => ensureCreated(episode, input.durationMs));
    },
    progress(input) {
      const episode = prepared;
      if (
        !episode?.started ||
        episode.finalized ||
        episode.playingSinceMs === null ||
        options.now() - episode.playingSinceMs < checkpointIntervalMs
      ) {
        return;
      }
      stopPlaying(episode);
      const checkpoint = nextCheckpoint(episode, input);
      episode.playingSinceMs = options.now();
      enqueue(episode, async () => {
        await ensureCreated(episode, input.durationMs);
        await options.transport.checkpoint(episode.clientEpisodeId, checkpoint);
      });
    },
    checkpoint(input, requestOptions) {
      const episode = prepared;
      if (!episode?.started || episode.finalized) return;
      const wasPlaying = episode.playingSinceMs !== null;
      stopPlaying(episode);
      const checkpoint = nextCheckpoint(episode, input);
      if (wasPlaying) episode.playingSinceMs = options.now();
      if (requestOptions?.keepalive && options.transport.checkpointKeepalive) {
        const task = options.transport.checkpointKeepalive(episode.clientEpisodeId, {
          create: createPayload(episode, input.durationMs),
          checkpoint
        }, requestOptions).then(() => {
          episode.created = true;
        }).catch(() => undefined).finally(() => {
          finalizationTasks.delete(task);
        });
        finalizationTasks.add(task);
        return;
      }
      if (requestOptions?.keepalive) {
        const task = options.transport.create(
          episode.clientEpisodeId,
          createPayload(episode, input.durationMs),
          { keepalive: true }
        ).then(async () => {
          episode.created = true;
          await options.transport.checkpoint(episode.clientEpisodeId, checkpoint, requestOptions);
        }).catch(() => undefined).finally(() => {
          finalizationTasks.delete(task);
        });
        finalizationTasks.add(task);
        return;
      }
      enqueue(episode, async () => {
        await ensureCreated(episode, input.durationMs);
        await options.transport.checkpoint(episode.clientEpisodeId, checkpoint, requestOptions);
      });
    },
    pause(input) {
      const episode = prepared;
      if (!episode?.started || episode.finalized) return;
      stopPlaying(episode);
      const checkpoint = nextCheckpoint(episode, input);
      enqueue(episode, async () => {
        await ensureCreated(episode, input.durationMs);
        await options.transport.checkpoint(episode.clientEpisodeId, checkpoint);
      });
    },
    finalize(outcome, input) {
      const episode = prepared;
      if (!episode?.started || episode.finalized) return;
      stopPlaying(episode);
      episode.finalized = true;
      episode.finalizedOutcome = outcome;
      const checkpoint = nextCheckpoint(episode, input);
      const entry: DurableFinalization = {
        clientEpisodeId: episode.clientEpisodeId,
        create: createPayload(episode, input.durationMs),
        finalize: {
          ...checkpoint,
          outcome
        }
      };
      persistFinalization(entry);
      launchFinalization(entry, () => ensureCreated(episode, input.durationMs));
    },
    retryPendingFinalizations,
    async settle() {
      while (operationTasks.size > 0 || finalizationTasks.size > 0) {
        await Promise.all([...operationTasks, ...finalizationTasks]);
      }
    }
  };
}

function protocolMilliseconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function listFinalizationOutboxKeys(
  storage: PlayerFinalizationStorage,
  userPrefix: string,
  currentKey: string
): string[] {
  const keys = new Set([currentKey]);
  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return [...keys];
  }
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(userPrefix)) keys.add(key);
  }
  return [...keys];
}

function readFinalizationOutbox(
  storage: PlayerFinalizationStorage,
  key: string
): DurableFinalization[] {
  try {
    const value = storage.getItem(key);
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDurableFinalization).slice(-FINALIZATION_OUTBOX_LIMIT);
  } catch {
    return [];
  }
}

function isDurableFinalization(value: unknown): value is DurableFinalization {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DurableFinalization>;
  return typeof entry.clientEpisodeId === 'string'
    && entry.clientEpisodeId.length > 0
    && Boolean(entry.create && typeof entry.create === 'object')
    && Boolean(entry.finalize && typeof entry.finalize === 'object')
    && typeof entry.finalize?.checkpointSeq === 'number'
    && typeof entry.finalize?.listenedMs === 'number'
    && typeof entry.finalize?.positionMs === 'number'
    && ['completed', 'skipped', 'failed', 'interrupted'].includes(String(entry.finalize?.outcome));
}
