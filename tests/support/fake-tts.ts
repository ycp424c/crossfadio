import type { TtsResult } from '../../src/server/tts/client';

type SynthesizeCall = { text: string };

/**
 * FakeTtsClient — test double for TtsClient.
 *
 * Usage:
 *   const fake = new FakeTtsClient('/tmp/fake.mp3');
 *   fake.synthesize('Hello DJ');  // returns { filePath: '/tmp/fake.mp3', cached: false }
 */
export class FakeTtsClient {
  readonly synthesizeCalls: SynthesizeCall[] = [];
  private _shouldThrow = false;
  private _throwMessage = 'TTS error';

  constructor(private readonly fixedFilePath = '/tmp/fake-tts.mp3') {}

  /** Make the next synthesize() call throw. */
  failNextCall(message = 'TTS error'): this {
    this._shouldThrow = true;
    this._throwMessage = message;
    return this;
  }

  async synthesize(text: string): Promise<TtsResult> {
    this.synthesizeCalls.push({ text });
    if (this._shouldThrow) {
      this._shouldThrow = false;
      throw new Error(this._throwMessage);
    }
    return { filePath: this.fixedFilePath, cached: false };
  }
}
