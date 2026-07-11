export const SEGUE_VOICE_GAIN = 2;
export const COMPRESSOR_THRESHOLD = -12;
export const COMPRESSOR_KNEE = 12;
export const COMPRESSOR_RATIO = 4;
export const COMPRESSOR_ATTACK = 0.003;
export const COMPRESSOR_RELEASE = 0.25;

type AudioParamLike = { value: number };
type AudioNodeLike = {
  connect(target: unknown): unknown;
  disconnect?(): unknown;
};
type GainNodeLike = AudioNodeLike & { gain: AudioParamLike };
type CompressorNodeLike = AudioNodeLike & {
  threshold: AudioParamLike;
  knee: AudioParamLike;
  ratio: AudioParamLike;
  attack: AudioParamLike;
  release: AudioParamLike;
};

export type SegueAudioContextLike = {
  state: AudioContextState | 'closed';
  destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createDynamicsCompressor(): CompressorNodeLike;
  createMediaElementSource(audio: HTMLMediaElement): AudioNodeLike;
};

export type SegueVoiceGainController = {
  prepare(audio: HTMLMediaElement): Promise<'enhanced' | 'native' | 'unavailable'>;
  release(audio: HTMLMediaElement): void;
  dispose(): Promise<void>;
};

export type SegueVoiceGainControllerOptions = {
  createContext: () => SegueAudioContextLike;
};

type ElementRoute = {
  source: AudioNodeLike;
  gain?: GainNodeLike;
  compressor?: CompressorNodeLike;
  active: boolean;
  mode: 'enhanced' | 'native' | 'unavailable';
};

export function createSegueVoiceGainController(options: SegueVoiceGainControllerOptions): SegueVoiceGainController {
  let context: SegueAudioContextLike | undefined;
  let disposed = false;
  const routes = new WeakMap<HTMLMediaElement, ElementRoute>();
  const activeRoutes = new Set<ElementRoute>();

  const safeDisconnect = (node?: AudioNodeLike): boolean => {
    if (!node) return true;
    if (!node.disconnect) return false;
    try {
      node.disconnect();
      return true;
    } catch {
      return false;
    }
  };

  const releaseRoute = (route: ElementRoute): boolean => {
    if (!route.active) return true;
    const sourceDisconnected = safeDisconnect(route.source);
    const gainDisconnected = safeDisconnect(route.gain);
    const compressorDisconnected = safeDisconnect(route.compressor);
    const clean = sourceDisconnected && gainDisconnected && compressorDisconnected;
    if (clean) {
      route.active = false;
      activeRoutes.delete(route);
    } else {
      route.mode = 'unavailable';
    }
    return clean;
  };

  return {
    async prepare(audio) {
      if (disposed) return 'native';

      let ctx: SegueAudioContextLike;
      try {
        ctx = context ??= options.createContext();
        await ctx.resume();
      } catch {
        return 'native';
      }
      if (disposed || context !== ctx) return 'native';

      const existing = routes.get(audio);
      if (existing?.active) return existing.mode;

      let gain: GainNodeLike | undefined;
      let compressor: CompressorNodeLike | undefined;
      try {
        gain = ctx.createGain();
        gain.gain.value = SEGUE_VOICE_GAIN;
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = COMPRESSOR_THRESHOLD;
        compressor.knee.value = COMPRESSOR_KNEE;
        compressor.ratio.value = COMPRESSOR_RATIO;
        compressor.attack.value = COMPRESSOR_ATTACK;
        compressor.release.value = COMPRESSOR_RELEASE;
      } catch {
        safeDisconnect(gain);
        safeDisconnect(compressor);
        return 'native';
      }

      let route = existing;
      if (!route) {
        try {
          route = { source: ctx.createMediaElementSource(audio), active: false, mode: 'unavailable' };
          routes.set(audio, route);
        } catch {
          safeDisconnect(gain);
          safeDisconnect(compressor);
          return 'native';
        }
      }

      route.gain = gain;
      route.compressor = compressor;
      route.active = true;
      route.mode = 'enhanced';
      activeRoutes.add(route);
      try {
        route.source.connect(gain);
        gain.connect(compressor);
        compressor.connect(ctx.destination);
        return 'enhanced';
      } catch {
        safeDisconnect(route.source);
        safeDisconnect(gain);
        safeDisconnect(compressor);
        try {
          route.source.connect(ctx.destination);
          route.mode = 'native';
        } catch {
          route.mode = 'unavailable';
        }
        return route.mode;
      }
    },

    release(audio) {
      const route = routes.get(audio);
      if (route) releaseRoute(route);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const route of [...activeRoutes]) releaseRoute(route);
      const ctx = context;
      context = undefined;
      if (ctx) {
        try { await ctx.close(); } catch { /* closing is best effort */ }
      }
    }
  };
}

type AudioContextConstructor = new () => SegueAudioContextLike;
type AudioContextHost = {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
};

export function createBrowserSegueVoiceGainController(
  host: AudioContextHost = globalThis as unknown as AudioContextHost
): SegueVoiceGainController {
  return createSegueVoiceGainController({
    createContext: () => {
      const Constructor = host.AudioContext ?? host.webkitAudioContext;
      if (!Constructor) throw new Error('Web Audio is unsupported');
      return new Constructor();
    }
  });
}
