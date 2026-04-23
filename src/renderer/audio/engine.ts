export type DeckId = 'A' | 'B';

type DeckStatus = 'idle' | 'ready' | 'playing' | 'stopped';

type AudioNodeLike = {
  connect: (...args: any[]) => any;
  disconnect?: (...args: any[]) => any;
};

type GainNodeLike = AudioNodeLike & {
  gain: {
    value: number;
  };
};

type BufferSourceNodeLike = AudioNodeLike & {
  buffer: AudioBuffer | null;
  onended: ((...args: any[]) => any) | null;
  start: (when?: number) => unknown;
  stop: (when?: number) => unknown;
};

export type AudioContextLike = {
  currentTime: number;
  state: AudioContextState | 'closed';
  destination: unknown;
  createGain: () => GainNodeLike;
  createBufferSource: () => BufferSourceNodeLike;
  resume: () => Promise<void>;
  suspend: () => Promise<void>;
  close: () => Promise<void>;
};

type DeckRuntimeState = {
  id: DeckId;
  gainNode: GainNodeLike;
  source: BufferSourceNodeLike | null;
  status: DeckStatus;
  startedAt: number | null;
};

export type DeckSnapshot = {
  hasSource: boolean;
  status: DeckStatus;
  startedAt: number | null;
  gain: number;
};

export type DualDeckEngineSnapshot = {
  activeDeck: DeckId;
  contextState: AudioContextLike['state'];
  decks: Record<DeckId, DeckSnapshot>;
};

export type DualDeckAudioEngineOptions = {
  createContext?: () => AudioContextLike;
  masterGain?: number;
  initialDeckGain?: number;
};

const DEFAULT_MASTER_GAIN = 1;
const DEFAULT_DECK_GAIN = 1;

export class DualDeckAudioEngine {
  private readonly context: AudioContextLike;
  private readonly masterGainNode: GainNodeLike;
  private readonly decks: Record<DeckId, DeckRuntimeState>;
  private activeDeck: DeckId = 'A';
  private destroyed = false;

  constructor(options: DualDeckAudioEngineOptions = {}) {
    const createContext = options.createContext ?? createDefaultAudioContext;
    this.context = createContext();

    this.masterGainNode = this.context.createGain();
    this.masterGainNode.gain.value = options.masterGain ?? DEFAULT_MASTER_GAIN;
    this.masterGainNode.connect(this.context.destination);

    this.decks = {
      A: this.createDeckState('A', options.initialDeckGain ?? DEFAULT_DECK_GAIN),
      B: this.createDeckState('B', options.initialDeckGain ?? DEFAULT_DECK_GAIN)
    };
  }

  getActiveDeck(): DeckId {
    return this.activeDeck;
  }

  getInactiveDeck(): DeckId {
    return oppositeDeck(this.activeDeck);
  }

  switchActiveDeck(deck: DeckId): void {
    this.ensureNotDestroyed();
    this.activeDeck = deck;
  }

  setMasterGain(gain: number): void {
    this.ensureNotDestroyed();
    this.masterGainNode.gain.value = gain;
  }

  setDeckGain(deck: DeckId, gain: number): void {
    this.ensureNotDestroyed();
    this.decks[deck].gainNode.gain.value = gain;
  }

  load(deck: DeckId, buffer: AudioBuffer): void {
    this.ensureNotDestroyed();
    const targetDeck = this.decks[deck];
    this.replaceDeckSource(targetDeck, buffer);
    targetDeck.status = 'ready';
    targetDeck.startedAt = null;
  }

  async play(
    deck: DeckId,
    buffer: AudioBuffer,
    options: { when?: number; switchActive?: boolean } = {}
  ): Promise<void> {
    this.ensureNotDestroyed();
    await this.resume();

    const targetDeck = this.decks[deck];
    this.replaceDeckSource(targetDeck, buffer);

    const startAt = options.when ?? this.context.currentTime;
    targetDeck.source?.start(startAt);
    targetDeck.status = 'playing';
    targetDeck.startedAt = startAt;

    if (options.switchActive !== false) {
      this.activeDeck = deck;
    }
  }

  stop(deck?: DeckId): void {
    this.ensureNotDestroyed();
    if (deck) {
      this.stopDeck(this.decks[deck]);
      return;
    }
    this.stopDeck(this.decks.A);
    this.stopDeck(this.decks.B);
  }

  async resume(): Promise<void> {
    this.ensureNotDestroyed();
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async suspend(): Promise<void> {
    this.ensureNotDestroyed();
    if (this.context.state === 'running') {
      await this.context.suspend();
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.stop();
    await this.context.close();
    this.destroyed = true;
  }

  snapshot(): DualDeckEngineSnapshot {
    return {
      activeDeck: this.activeDeck,
      contextState: this.context.state,
      decks: {
        A: this.deckSnapshot('A'),
        B: this.deckSnapshot('B')
      }
    };
  }

  private createDeckState(id: DeckId, gain: number): DeckRuntimeState {
    const gainNode = this.context.createGain();
    gainNode.gain.value = gain;
    gainNode.connect(this.masterGainNode);

    return {
      id,
      gainNode,
      source: null,
      status: 'idle',
      startedAt: null
    };
  }

  private replaceDeckSource(deck: DeckRuntimeState, buffer: AudioBuffer): void {
    this.stopDeckSource(deck);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(deck.gainNode);
    source.onended = () => {
      if (deck.source === source) {
        deck.status = 'stopped';
        deck.startedAt = null;
        deck.source = null;
      }
    };
    deck.source = source;
  }

  private stopDeck(deck: DeckRuntimeState): void {
    this.stopDeckSource(deck);
    deck.status = 'stopped';
    deck.startedAt = null;
  }

  private stopDeckSource(deck: DeckRuntimeState): void {
    const source = deck.source;
    if (!source) {
      return;
    }

    try {
      source.stop(0);
    } catch {
      // ignore InvalidStateError when source already stopped
    }

    source.onended = null;
    source.disconnect?.();

    if (deck.source === source) {
      deck.source = null;
    }
  }

  private deckSnapshot(deck: DeckId): DeckSnapshot {
    const runtime = this.decks[deck];
    return {
      hasSource: Boolean(runtime.source),
      status: runtime.status,
      startedAt: runtime.startedAt,
      gain: runtime.gainNode.gain.value
    };
  }

  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('DualDeckAudioEngine has been destroyed');
    }
  }
}

function oppositeDeck(deck: DeckId): DeckId {
  return deck === 'A' ? 'B' : 'A';
}

function createDefaultAudioContext(): AudioContextLike {
  if (typeof window === 'undefined') {
    throw new Error('Web Audio API is not available in this runtime');
  }

  const AudioContextCtor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error('Web Audio API is not supported by this browser');
  }

  return new AudioContextCtor();
}
