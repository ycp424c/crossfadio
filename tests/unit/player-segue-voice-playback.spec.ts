import { describe, expect, it, vi } from 'vitest';
import {
  prepareSegueAudioRoute,
  settleSegueAudioPlay
} from '../../src/renderer/playerSegueVoicePlayback';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: () => void;
} {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error('play rejected'));
  });
  return { promise, resolve, reject };
}

describe('player segue voice playback settlement', () => {
  it('reports success only while the same pending audio is still current', async () => {
    const play = deferred();
    const onCurrentSuccess = vi.fn();
    const cleanupStale = vi.fn();
    const settling = settleSegueAudioPlay({
      play: () => play.promise,
      isCurrent: () => true,
      isActive: () => true,
      cleanupStale,
      onCurrentSuccess,
      onCurrentReject: vi.fn()
    });
    play.resolve();
    await settling;
    expect(onCurrentSuccess).toHaveBeenCalledOnce();
    expect(cleanupStale).not.toHaveBeenCalled();
  });

  it('preserves a detached active clip when replacement wins before play resolves', async () => {
    const play = deferred();
    const onCurrentSuccess = vi.fn();
    const cleanupStale = vi.fn();
    const settling = settleSegueAudioPlay({
      play: () => play.promise,
      isCurrent: () => false,
      isActive: () => true,
      cleanupStale,
      onCurrentSuccess,
      onCurrentReject: vi.fn()
    });
    play.resolve();
    await settling;
    expect(onCurrentSuccess).not.toHaveBeenCalled();
    expect(cleanupStale).not.toHaveBeenCalled();
  });

  it('cleans stale success after force disposal or unmount removed the active clip', async () => {
    const play = deferred();
    const cleanupStale = vi.fn();
    const settling = settleSegueAudioPlay({
      play: () => play.promise,
      isCurrent: () => false,
      isActive: () => false,
      cleanupStale,
      onCurrentSuccess: vi.fn(),
      onCurrentReject: vi.fn()
    });
    play.resolve();
    await settling;
    expect(cleanupStale).toHaveBeenCalledOnce();
  });

  it('keeps current rejection retryable but cleans a stale rejection', async () => {
    const currentPlay = deferred();
    const onCurrentReject = vi.fn();
    const current = settleSegueAudioPlay({
      play: () => currentPlay.promise,
      isCurrent: () => true,
      isActive: () => true,
      cleanupStale: vi.fn(),
      onCurrentSuccess: vi.fn(),
      onCurrentReject
    });
    currentPlay.reject();
    await current;
    expect(onCurrentReject).toHaveBeenCalledOnce();

    const stalePlay = deferred();
    const cleanupStale = vi.fn();
    const stale = settleSegueAudioPlay({
      play: () => stalePlay.promise,
      isCurrent: () => false,
      isActive: () => true,
      cleanupStale,
      onCurrentSuccess: vi.fn(),
      onCurrentReject: vi.fn()
    });
    stalePlay.reject();
    await stale;
    expect(cleanupStale).toHaveBeenCalledOnce();
  });

  it('uses native playback without preparing when the controller is unavailable or the replacement is native-only', async () => {
    const prepare = vi.fn(async () => 'enhanced' as const);
    const audio = {} as HTMLAudioElement;
    await expect(prepareSegueAudioRoute({ audio, controller: null, nativeOnly: false })).resolves.toBe('native');
    await expect(prepareSegueAudioRoute({ audio, controller: { prepare }, nativeOnly: true })).resolves.toBe('native');
    expect(prepare).not.toHaveBeenCalled();
    await expect(prepareSegueAudioRoute({ audio, controller: { prepare }, nativeOnly: false })).resolves.toBe('enhanced');
    expect(prepare).toHaveBeenCalledOnce();
  });
});
