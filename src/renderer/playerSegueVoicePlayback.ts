type SeguePrepareController = {
  prepare(audio: HTMLMediaElement): Promise<'enhanced' | 'native' | 'unavailable'>;
};

export function shouldRestoreTrackVolumeAfterSegueCleanup(activeSegueCount: number): boolean {
  return activeSegueCount === 0;
}

export async function prepareSegueAudioRoute(input: {
  audio: HTMLAudioElement;
  controller: SeguePrepareController | null;
  nativeOnly: boolean;
}): Promise<'enhanced' | 'native' | 'unavailable'> {
  if (input.nativeOnly || !input.controller) {
    return 'native';
  }
  return input.controller.prepare(input.audio);
}

export async function settleSegueAudioPlay(input: {
  play: () => Promise<void>;
  isCurrent: () => boolean;
  isActive: () => boolean;
  cleanupStale: () => void;
  onCurrentSuccess: () => void;
  onCurrentReject: () => void;
}): Promise<void> {
  try {
    await input.play();
    if (input.isCurrent()) {
      input.onCurrentSuccess();
    } else if (!input.isActive()) {
      input.cleanupStale();
    }
  } catch {
    if (input.isCurrent()) {
      input.onCurrentReject();
    } else {
      input.cleanupStale();
    }
  }
}
