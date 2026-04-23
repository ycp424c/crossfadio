import { describe, expect, it } from 'vitest';
import type { AudioContextLike } from '../../src/renderer/audio/engine';
import { DualDeckAudioEngine } from '../../src/renderer/audio/engine';

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 42;
  state: AudioContextState | 'closed' = 'suspended';
  destination = new FakeAudioNode();
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createBufferSource(): FakeBufferSourceNode {
    return new FakeBufferSourceNode();
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

function createFakeBuffer(): AudioBuffer {
  return {} as AudioBuffer;
}

describe('DualDeckAudioEngine', () => {
  it('defaults to deck A and can switch active deck', async () => {
    const context = new FakeAudioContext();
    const engine = new DualDeckAudioEngine({ createContext: () => context });

    expect(engine.getActiveDeck()).toBe('A');
    expect(engine.getInactiveDeck()).toBe('B');

    await engine.play('B', createFakeBuffer());

    expect(engine.getActiveDeck()).toBe('B');
    const snapshot = engine.snapshot();
    expect(snapshot.decks.B.status).toBe('playing');
    expect(snapshot.decks.B.hasSource).toBe(true);
  });

  it('supports stop on a single deck and stop all decks', async () => {
    const context = new FakeAudioContext();
    const engine = new DualDeckAudioEngine({ createContext: () => context });

    await engine.play('A', createFakeBuffer());
    await engine.play('B', createFakeBuffer(), { switchActive: false });

    engine.stop('A');
    expect(engine.snapshot().decks.A.status).toBe('stopped');
    expect(engine.snapshot().decks.B.status).toBe('playing');

    engine.stop();
    expect(engine.snapshot().decks.A.status).toBe('stopped');
    expect(engine.snapshot().decks.B.status).toBe('stopped');
  });

  it('supports resume and suspend', async () => {
    const context = new FakeAudioContext();
    const engine = new DualDeckAudioEngine({ createContext: () => context });

    await engine.resume();
    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe('running');

    await engine.suspend();
    expect(context.suspendCalls).toBe(1);
    expect(context.state).toBe('suspended');
  });
});
