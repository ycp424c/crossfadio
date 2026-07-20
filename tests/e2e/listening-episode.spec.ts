import { expect, test } from '@playwright/test';
import type { QueueTrackDto } from '../../src/shared/schema';
import { setAudioPosition, setupDjV2Page } from './dj-v2-fixture';

const queue: QueueTrackDto[] = [
  { id: 'before-half', name: 'Before Half', artists: ['Boundary Artist'], durationMs: 100_000 },
  { id: 'at-half', name: 'At Half', artists: ['Boundary Artist'], durationMs: 100_000 },
  { id: 'after-half', name: 'After Half', artists: ['Boundary Artist'], durationMs: 100_000 },
  { id: 'queue-jump', name: 'Queue Jump', artists: ['Boundary Artist'], durationMs: 100_000 }
];

test('records native play, pause/resume and manual-skip boundary before queue mutation', async ({ page }) => {
  const controller = await setupDjV2Page({ page, queue });

  await expect(page.getByText('Before Half', { exact: true }).first()).toBeVisible();
  expect(controller.episodeRequests).toEqual([]);

  await page.getByLabel('播放', { exact: true }).click();
  await expect.poll(() => controller.episodeRequests.filter((item) => item.method === 'PUT').length).toBe(1);

  await setAudioPosition(page, 20);
  await page.getByLabel('暂停', { exact: true }).click();
  await expect.poll(() => controller.episodeRequests.filter((item) => (
    item.method === 'PATCH' && item.body.outcome === undefined
  )).length).toBeGreaterThanOrEqual(1);
  await page.getByLabel('播放', { exact: true }).click();

  await setAudioPosition(page, 49);
  await page.getByLabel('下一首', { exact: true }).click();
  await expect.poll(() => skippedRequests(controller.episodeRequests).length).toBe(1);
  await expect.poll(() => controller.episodeRequests.filter((item) => item.method === 'PUT').length).toBe(2);

  await setAudioPosition(page, 50);
  await page.getByLabel('下一首', { exact: true }).click();
  await expect.poll(() => skippedRequests(controller.episodeRequests).length).toBe(2);
  await expect.poll(() => controller.episodeRequests.filter((item) => item.method === 'PUT').length).toBe(3);

  await setAudioPosition(page, 20);
  await page.getByRole('button', { name: /Queue Jump/ }).click();
  await expect.poll(() => skippedRequests(controller.episodeRequests).length).toBe(3);

  const [beforeHalf, atHalf] = skippedRequests(controller.episodeRequests);
  expect(beforeHalf.body).toMatchObject({
    outcome: 'skipped',
    positionMs: 49_000,
    durationMs: 100_000
  });
  expect(atHalf.body).toMatchObject({
    outcome: 'skipped',
    positionMs: 50_000,
    durationMs: 100_000
  });
  expect(Number(beforeHalf.body.listenedMs)).toBeGreaterThanOrEqual(0);
  expect(Number(atHalf.body.listenedMs)).toBeGreaterThanOrEqual(0);
  expect(beforeHalf.clientEpisodeId).not.toBe(atHalf.clientEpisodeId);
  expect(skippedRequests(controller.episodeRequests)[2]!.body).toMatchObject({
    outcome: 'skipped',
    positionMs: 20_000,
    durationMs: 100_000
  });
});

test('records a completed episode from Chromium native audio events', async ({ page }) => {
  const controller = await setupDjV2Page({
    page,
    queue: [{
      id: 'real-audio',
      name: 'Real Audio Fixture',
      artists: ['Fixture Artist'],
      durationMs: 2_000
    }],
    realMedia: true
  });

  await page.locator('audio').evaluate((audio) => {
    const browserWindow = window as typeof window & { __nativeAudioEvents?: string[] };
    browserWindow.__nativeAudioEvents = [];
    for (const type of ['playing', 'timeupdate', 'ended']) {
      audio.addEventListener(type, () => browserWindow.__nativeAudioEvents!.push(type), { once: true });
    }
  });

  await page.getByLabel('播放', { exact: true }).click();

  await expect.poll(() => controller.episodeRequests.some((item) => (
    item.method === 'PATCH' && item.body.outcome === 'completed'
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __nativeAudioEvents?: string[] }).__nativeAudioEvents ?? []
  ))).toEqual(expect.arrayContaining(['playing', 'timeupdate', 'ended']));
});

test('uses real audio pause/resume events and keeps the strict midpoint skip boundary', async ({ page }) => {
  const controller = await setupDjV2Page({
    page,
    queue: queue.slice(0, 3).map((track) => ({ ...track, durationMs: 2_000 })),
    realMedia: true
  });
  await page.locator('audio').evaluate((audio) => {
    audio.playbackRate = 0.25;
    const browserWindow = window as typeof window & { __nativeBoundaryEvents?: string[] };
    browserWindow.__nativeBoundaryEvents = [];
    for (const type of ['playing', 'pause', 'seeking', 'seeked']) {
      audio.addEventListener(type, () => browserWindow.__nativeBoundaryEvents!.push(type));
    }
  });

  await page.getByLabel('播放', { exact: true }).click();
  await expect.poll(() => controller.episodeRequests.filter((item) => item.method === 'PUT').length).toBe(1);
  const firstDuration = await page.locator('audio').evaluate((audio) => audio.duration);
  expect(firstDuration).toBeGreaterThan(0);
  await setAudioPosition(page, firstDuration * 0.2, { dispatchTimeUpdate: true });
  await page.getByLabel('暂停', { exact: true }).click();
  await page.getByLabel('播放', { exact: true }).click();
  await setAudioPosition(page, firstDuration * 0.49, { dispatchTimeUpdate: true });
  await page.getByLabel('下一首', { exact: true }).click();
  await expect.poll(() => skippedRequests(controller.episodeRequests).length).toBe(1);

  await expect.poll(() => controller.episodeRequests.filter((item) => item.method === 'PUT').length).toBe(2);
  await expect.poll(() => page.locator('audio').evaluate((audio) => (
    Number.isFinite(audio.duration) ? audio.duration : 0
  ))).toBeGreaterThan(0);
  const secondDuration = await page.locator('audio').evaluate((audio) => audio.duration);
  await page.locator('audio').evaluate((audio) => { audio.playbackRate = 0.25; });
  await page.getByLabel('暂停', { exact: true }).click();
  const midpointState = await page.locator('audio').evaluate(async (audio) => {
    audio.currentTime = audio.duration / 2;
    if (audio.seeking) {
      await new Promise<void>((resolve) => {
        audio.addEventListener('seeked', () => resolve(), { once: true });
      });
    }
    audio.dispatchEvent(new Event('timeupdate'));
    return {
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      seekable: Array.from({ length: audio.seekable.length }, (_, index) => ({
        start: audio.seekable.start(index),
        end: audio.seekable.end(index)
      }))
    };
  });
  expect(midpointState.currentTime, JSON.stringify(midpointState)).toBeCloseTo(secondDuration / 2, 3);
  await page.getByLabel('下一首', { exact: true }).click();
  await expect.poll(() => skippedRequests(controller.episodeRequests).length).toBe(2);

  const [beforeHalf, atHalf] = skippedRequests(controller.episodeRequests);
  expect(Number(beforeHalf.body.positionMs)).toBeLessThan(Number(beforeHalf.body.durationMs) / 2);
  expect(atHalf.body.positionMs).toBe(Number(atHalf.body.durationMs) / 2);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __nativeBoundaryEvents?: string[] }).__nativeBoundaryEvents ?? []
  ))).toEqual(expect.arrayContaining(['playing', 'pause', 'seeking', 'seeked']));
});

function skippedRequests(
  requests: Array<{ method: string; body: Record<string, unknown>; clientEpisodeId: string }>
) {
  return requests.filter((item) => item.method === 'PATCH' && item.body.outcome === 'skipped');
}
