import { describe, expect, it, vi } from 'vitest';
import {
  COMPRESSOR_ATTACK,
  COMPRESSOR_KNEE,
  COMPRESSOR_RATIO,
  COMPRESSOR_RELEASE,
  COMPRESSOR_THRESHOLD,
  SEGUE_VOICE_GAIN,
  createBrowserSegueVoiceGainController,
  createSegueVoiceGainController,
  type SegueAudioContextLike
} from '../../src/renderer/audio/segueVoiceGain';

type Failure = 'resume' | 'gain' | 'compressor' | 'parameter' | 'source' | 'source-connect' | 'source-connect-persistent' | 'gain-connect' | 'compressor-connect' | 'disconnect' | 'close';

class FakeNode {
  readonly connections: unknown[] = [];
  disconnectCount = 0;
  connectCount = 0;
  constructor(private readonly name: string, private readonly events: string[], private readonly failure?: Failure) {}
  connect(target: unknown) {
    this.events.push(`${this.name}.connect`);
    this.connectCount++;
    if (this.failure === `${this.name}-connect-persistent`) throw new Error('connect failed');
    if (this.failure === `${this.name}-connect` && this.connectCount === 1) {
      throw new Error('connect failed');
    }
    this.connections.push(target);
    return target;
  }
  disconnect() {
    this.disconnectCount++;
    this.events.push(`${this.name}.disconnect`);
    if (this.failure === 'disconnect') throw new Error('disconnect failed');
    this.connections.length = 0;
  }
}

class FakeContext implements SegueAudioContextLike {
  state: AudioContextState | 'closed' = 'suspended';
  destination = { name: 'destination' };
  readonly events: string[] = [];
  readonly sources: FakeNode[] = [];
  readonly gains: Array<FakeNode & { gain: { value: number } }> = [];
  readonly compressors: Array<FakeNode & Record<'threshold' | 'knee' | 'ratio' | 'attack' | 'release', { value: number }>> = [];
  constructor(readonly failure?: Failure) {}
  async resume(): Promise<void> {
    this.events.push('resume');
    if (this.failure === 'resume') throw new Error('resume failed');
    this.state = 'running';
  }
  createGain() {
    this.events.push('createGain');
    if (this.failure === 'gain') throw new Error('gain failed');
    const node = Object.assign(new FakeNode('gain', this.events, this.failure), { gain: { value: 1 } });
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor() {
    this.events.push('createCompressor');
    if (this.failure === 'compressor') throw new Error('compressor failed');
    const node = Object.assign(new FakeNode('compressor', this.events, this.failure), {
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }
    });
    if (this.failure === 'parameter') {
      Object.defineProperty(node.threshold, 'value', { set() { throw new Error('parameter failed'); } });
    }
    this.compressors.push(node);
    return node;
  }
  createMediaElementSource(_audio: HTMLMediaElement) {
    this.events.push('createSource');
    if (this.failure === 'source') throw new Error('source failed');
    const node = new FakeNode('source', this.events, this.failure);
    this.sources.push(node);
    return node;
  }
  async close() {
    this.events.push('close');
    if (this.failure === 'close') throw new Error('close failed');
    this.state = 'closed';
  }
}

const audio = () => ({}) as HTMLAudioElement;

describe('segue voice gain controller', () => {
  it('resumes first, configures nodes, then binds and connects the enhanced route in order', async () => {
    const context = new FakeContext();
    const controller = createSegueVoiceGainController({ createContext: () => context });

    await expect(controller.prepare(audio())).resolves.toBe('enhanced');
    expect(context.events).toEqual(['resume', 'createGain', 'createCompressor', 'createSource', 'source.connect', 'gain.connect', 'compressor.connect']);
    expect(context.gains[0].gain.value).toBe(SEGUE_VOICE_GAIN);
    expect(context.compressors[0]).toMatchObject({
      threshold: { value: COMPRESSOR_THRESHOLD }, knee: { value: COMPRESSOR_KNEE }, ratio: { value: COMPRESSOR_RATIO },
      attack: { value: COMPRESSOR_ATTACK }, release: { value: COMPRESSOR_RELEASE }
    });
  });

  it('lazily creates one context and reuses each media source across release and reprepare', async () => {
    const context = new FakeContext();
    const createContext = vi.fn(() => context);
    const controller = createSegueVoiceGainController({ createContext });
    const element = audio();
    expect(createContext).not.toHaveBeenCalled();
    await controller.prepare(element);
    await controller.prepare(element);
    controller.release(element);
    controller.release(element);
    await controller.prepare(element);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(1);
    expect(context.gains).toHaveLength(2);
    expect(context.sources[0].connectCount).toBe(2);
  });

  it('tracks multiple elements independently and dispose disconnects all, closes, and becomes inert', async () => {
    const context = new FakeContext('close');
    const controller = createSegueVoiceGainController({ createContext: () => context });
    const first = audio(); const second = audio();
    await controller.prepare(first); await controller.prepare(second);
    controller.release({} as HTMLAudioElement);
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(context.sources).toHaveLength(2);
    expect(context.sources.every((node) => node.disconnectCount === 1)).toBe(true);
    await expect(controller.prepare(first)).resolves.toBe('native');
    expect(context.sources).toHaveLength(2);
  });

  it.each<Failure>(['resume', 'gain', 'compressor', 'parameter', 'source'])('falls back without throwing when %s fails before source routing', async (failure) => {
    const context = new FakeContext(failure);
    const controller = createSegueVoiceGainController({ createContext: () => context });
    await expect(controller.prepare(audio())).resolves.toBe('native');
    expect(context.sources).toHaveLength(0);
  });

  it('isolates disconnect failures during release and dispose', async () => {
    const context = new FakeContext('disconnect');
    const controller = createSegueVoiceGainController({ createContext: () => context });
    const element = audio();
    await controller.prepare(element);
    const sourceConnectCount = context.events.filter((event) => event === 'source.connect').length;
    expect(() => controller.release(element)).not.toThrow();
    await expect(controller.prepare(element)).resolves.toBe('unavailable');
    expect(context.events.filter((event) => event === 'source.connect')).toHaveLength(sourceConnectCount);
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(context.sources[0].disconnectCount).toBe(2);
  });

  it('returns unavailable when both enhanced and emergency source connections fail', async () => {
    const context = new FakeContext('source-connect-persistent');
    const controller = createSegueVoiceGainController({ createContext: () => context });
    const element = audio();
    await expect(controller.prepare(element)).resolves.toBe('unavailable');
    await expect(controller.prepare(element)).resolves.toBe('unavailable');
    expect(context.events.filter((event) => event === 'source.connect')).toHaveLength(2);
    await expect(controller.dispose()).resolves.toBeUndefined();
  });

  it('does not build a route when dispose wins a deferred resume race', async () => {
    let finishResume!: () => void;
    const context = new FakeContext();
    context.resume = () => new Promise<void>((resolve) => { finishResume = resolve; });
    const controller = createSegueVoiceGainController({ createContext: () => context });
    const preparing = controller.prepare(audio());
    await Promise.resolve();
    const disposing = controller.dispose();
    finishResume();
    await expect(preparing).resolves.toBe('native');
    await expect(disposing).resolves.toBeUndefined();
    expect(context.gains).toHaveLength(0);
    expect(context.compressors).toHaveLength(0);
    expect(context.sources).toHaveLength(0);
  });

  it.each([
    ['compressor', 1, 0],
    ['parameter', 1, 1],
    ['source', 1, 1]
  ] as const)('disconnects partial nodes when %s fails', async (failure, gainCount, compressorCount) => {
    const context = new FakeContext(failure);
    await createSegueVoiceGainController({ createContext: () => context }).prepare(audio());
    expect(context.gains).toHaveLength(gainCount);
    expect(context.compressors).toHaveLength(compressorCount);
    expect(context.gains.every((node) => node.disconnectCount === 1)).toBe(true);
    expect(context.compressors.every((node) => node.disconnectCount === 1)).toBe(true);
  });

  it.each<Failure>(['source-connect', 'gain-connect', 'compressor-connect'])('uses one emergency unity route after post-source %s failure', async (failure) => {
    const context = new FakeContext(failure);
    const controller = createSegueVoiceGainController({ createContext: () => context });
    const element = audio();
    await expect(controller.prepare(element)).resolves.toBe('native');
    await expect(controller.prepare(element)).resolves.toBe('native');
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].connections.filter((target) => target === context.destination)).toHaveLength(1);
  });

  it('absorbs unsupported and constructor failures, including the browser standard/prefixed feature detection', async () => {
    await expect(createSegueVoiceGainController({ createContext: () => { throw new Error('ctor'); } }).prepare(audio())).resolves.toBe('native');
    await expect(createBrowserSegueVoiceGainController({}).prepare(audio())).resolves.toBe('native');
    const context = new FakeContext();
    const Prefixed = vi.fn(() => context);
    const controller = createBrowserSegueVoiceGainController({ webkitAudioContext: Prefixed });
    await expect(controller.prepare(audio())).resolves.toBe('enhanced');
    expect(Prefixed).toHaveBeenCalledOnce();
  });

  it('uses the standard AudioContext constructor when available', async () => {
    const context = new FakeContext();
    const Standard = vi.fn(() => context);
    const Prefixed = vi.fn(() => new FakeContext());
    const controller = createBrowserSegueVoiceGainController({ AudioContext: Standard, webkitAudioContext: Prefixed });
    await expect(controller.prepare(audio())).resolves.toBe('enhanced');
    expect(Standard).toHaveBeenCalledOnce();
    expect(Prefixed).not.toHaveBeenCalled();
  });

  it('does not leak errors from browser capability getters', async () => {
    const host = Object.defineProperties({}, {
      AudioContext: { get() { throw new Error('blocked standard getter'); } },
      webkitAudioContext: { get() { throw new Error('blocked prefixed getter'); } }
    });
    let controller: ReturnType<typeof createBrowserSegueVoiceGainController> | undefined;
    expect(() => { controller = createBrowserSegueVoiceGainController(host); }).not.toThrow();
    await expect(controller!.prepare(audio())).resolves.toBe('native');
  });
});
