import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('player layout', () => {
  it('allows the active view to scroll instead of clipping tall player content', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');

    expect(source).toContain('flex-1 overflow-y-auto');
    expect(source).not.toContain('flex-1 overflow-hidden');
  });

  it('limits queue list height and scrolls the playlist internally', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/components/player/QueuePanel.tsx'), 'utf-8');

    expect(source).toContain('max-h-');
    expect(source).toContain('overflow-y-auto');
  });

  it('persists the locally selected DJ start track instead of treating it as remote queue state', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const loadLikedQueueStart = source.indexOf('async function loadLikedQueue');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying');
    const loadLikedQueueBody = source.slice(loadLikedQueueStart, loadNowPlayingStart);

    expect(loadLikedQueueBody).toContain('setQueue([startTrack])');
    expect(loadLikedQueueBody).not.toContain('applyingRemoteQueueRef.current = true');
  });

  it('surfaces waiting segue states instead of falling back to idle text', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain("setSegueStatusText('已开播，等待下一首加入队列')");
    expect(source).toContain("setSegueStatusText('下一首与当前相同，跳过')");
  });

  it('clears stale track media immediately when the current track changes', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('function resetTrackMedia(): void');
    expect(source).toContain('setNowPlaying(null)');
    expect(source).toContain("audio.removeAttribute('src')");
    expect(source).toContain('resetTrackMedia();');
  });

  it('ignores stale now-playing responses from a previous current track', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const loadNowPlayingStart = source.indexOf('async function loadNowPlaying');
    const refreshNextTrackStart = source.indexOf('async function refreshNextTrack');
    const loadNowPlayingBody = source.slice(loadNowPlayingStart, refreshNextTrackStart);

    expect(loadNowPlayingBody).toContain('if (currentTrackIdRef.current !== trackId)');
    expect(loadNowPlayingBody).toContain('setNowPlaying(payload)');
    expect(loadNowPlayingBody.indexOf('if (currentTrackIdRef.current !== trackId)')).toBeLessThan(
      loadNowPlayingBody.indexOf('setNowPlaying(payload)')
    );
  });

  it('shows segue request failures directly in the player status area', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).not.toContain("setSegueStatus('degraded')");
    expect(source).toContain('setSegueStatusText(`请求失败：${message}`)');
  });

  it('releases the active segue request after tts-ready so DJ refill can resume', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');
    const ttsReadyStart = source.indexOf("type === 'segue.tts-ready'");
    const degradedStart = source.indexOf("type === 'segue.degraded'");
    const ttsReadyBlock = source.slice(ttsReadyStart, degradedStart);

    expect(ttsReadyBlock).toContain('segueClientRequestIdRef.current = null');
    expect(ttsReadyBlock).toContain('segueSatisfiedForTrackIdRef.current = currentTrackIdRef.current');
  });

  it('triggers segue as soon as playback is running and a next track is known', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/views/Player/PlayerView.tsx'), 'utf-8');

    expect(source).toContain('const maybeTriggerSegue = useCallback(() => {');
    expect(source).toContain('if (!audio || audio.paused || !currentTrackId || !nextTrackId) {');
    expect(source).toContain('useEffect(() => {');
    expect(source).toContain('maybeTriggerSegue();');
    expect(source).not.toContain('decision.shouldTriggerSegue &&');
  });

  it('PlaybackTimeline does not render DeckCard or dual-deck section', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/PlaybackTimeline.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('DeckCard');
    expect(source).not.toContain('双 Deck 混音台');
    expect(source).toContain('A→B');
  });

  it('NowPlayingHero does not show DJ Deck A badge or NCM ID', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/player/NowPlayingHero.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('DJ Deck A');
    expect(source).not.toContain('NCM ID');
    expect(source).not.toContain('trackId');
  });

  it('PlayerView uses two-column layout and removes the left sidebar', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('col-span-2');
    expect(source).not.toContain('col-span-7');
    expect(source).not.toContain('col-span-3');
    expect(source).toContain('col-span-12');
    expect(source).toContain('col-span-6');
  });

  it('PlayerView removes the prefetch status panel', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('预取状态');
    expect(source).not.toContain('prefetchLeadSec');
  });

  it('PlayerView has NCM chip dropdown controlled by showNcmDropdown state', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
      'utf-8'
    );

    expect(source).toContain('showNcmDropdown');
    expect(source).toContain('setShowNcmDropdown');
  });
});
