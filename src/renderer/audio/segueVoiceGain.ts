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
  prepare(audio: HTMLMediaElement): Promise<'enhanced' | 'native'>;
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
  emergency: boolean;
};

export function createSegueVoiceGainController(options: SegueVoiceGainControllerOptions): SegueVoiceGainController {
  let context: SegueAudioContextLike | undefined;
  let disposed = false;
  const routes = new WeakMap<HTMLMediaElement, ElementRoute>();
  const activeRoutes = new Set<ElementRoute>();

  const safeDisconnect = (node?: AudioNodeLike) => {
    try { node?.disconnect?.(); } catch { /* best-effort cleanup */ }
  };

  const releaseRoute = (route: ElementRoute) => {
    if (!route.active) return;
    safeDisconnect(route.source);
    safeDisconnect(route.gain);
    safeDisconnect(route.compressor);
    route.active = false;
    activeRoutes.delete(route);
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

      const existing = routes.get(audio);
      if (existing?.active) return existing.emergency ? 'native' : 'enhanced';

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
          route = { source: ctx.createMediaElementSource(audio), active: false, emergency: false };
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
      route.emergency = false;
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
        route.emergency = true;
        try { route.source.connect(ctx.destination); } catch { /* never surface Web Audio failures */ }
        return 'native';
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
