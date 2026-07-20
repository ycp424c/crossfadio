import { expect, test } from '@playwright/test';
import type { QueueTrackDto } from '../../src/shared/schema';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';
import {
  emitPersistentSse,
  setAudioPosition,
  setupDjV2Page
} from './dj-v2-fixture';

const initialTrack: QueueTrackDto = {
  id: 'journey-current',
  name: 'Current Groove',
  artists: ['Fixture Artist'],
  durationMs: 100_000
};
const appendedTrack: QueueTrackDto = {
  id: 'journey-selected',
  name: 'Plastic Love',
  artists: ['竹内まりや'],
  durationMs: 100_000
};

const baseJourney: SelectionJourneySnapshot = {
  schemaVersion: 1,
  runId: 'playwright-journey-run',
  journeyVersion: 1,
  revision: 0,
  status: 'running',
  summary: '正在理解这一刻适合怎样的下一首。',
  startedAt: '2026-07-17T12:00:00.000Z',
  updatedAt: '2026-07-17T12:00:01.000Z',
  stages: [
    { stage: 'understanding', status: 'completed', title: '理解当下', detail: '结合当前队列和请求。', reasonCodes: [] },
    { stage: 'recall', status: 'active', title: '寻找候选', detail: '从多个方向召回歌曲。', reasonCodes: [] }
  ],
  candidates: [{ id: appendedTrack.id, name: appendedTrack.name, artist: appendedTrack.artists[0], state: 'considering' }],
  selections: [],
  narration: { status: 'pending' }
};
const completedJourney: SelectionJourneySnapshot = {
  ...baseJourney,
  revision: 1,
  status: 'completed',
  summary: '在熟悉的律动里保留一点新鲜感。',
  updatedAt: '2026-07-17T12:00:02.000Z',
  completedAt: '2026-07-17T12:00:02.000Z',
  stages: baseJourney.stages.map((stage) => ({ ...stage, status: 'completed' as const })),
  candidates: [{ ...baseJourney.candidates[0], state: 'selected' }],
  selections: [{
    trackId: appendedTrack.id,
    trackName: appendedTrack.name,
    artist: appendedTrack.artists[0],
    reason: '延续律动，同时换一个声音颜色。'
  }],
  narration: { status: 'pending' }
};
const polishedJourney: SelectionJourneySnapshot = {
  ...completedJourney,
  revision: 2,
  updatedAt: '2026-07-17T12:00:03.000Z',
  narration: { status: 'polished', text: '今晚从熟悉的律动出发，也给耳朵留了一点变化。' }
};

test('shows auto-fill Journey, applies async narration and restores it after refresh', async ({ page }) => {
  const controller = await setupDjV2Page({
    page,
    queue: [initialTrack],
    pickNextEvents: [
      { type: 'selection.journey', data: { type: 'selection.journey', snapshot: baseJourney } },
      {
        type: 'queue-updated',
        data: { queue: [initialTrack, appendedTrack], currentIndex: 0, revision: 1 }
      },
      { type: 'selection.journey', data: { type: 'selection.journey', snapshot: completedJourney } },
      { type: 'dj.pick-next.done', data: { added: true, addedCount: 1, trackName: appendedTrack.name } }
    ]
  });

  await page.getByLabel('播放', { exact: true }).click();
  await expect(page.getByLabel('暂停', { exact: true })).toBeVisible();
  await setAudioPosition(page, 5, { dispatchTimeUpdate: true });

  await expect.poll(() => controller.pickNextRequests.length).toBe(1);
  await expect(page.getByRole('region', { name: '选歌过程' })).toBeVisible();
  await expect(page.getByText('Plastic Love', { exact: false }).last()).toBeVisible();
  await expect(page.getByText('DJ 手记正在润色，完成后会安静地更新在这里。').last()).toBeVisible();
  await expect(page.getByText('已加入「Plastic Love」').last()).toBeVisible();

  await emitPersistentSse(page, 'selection.journey', {
    type: 'selection.journey',
    snapshot: polishedJourney
  });
  await expect(page.getByText(polishedJourney.narration.status === 'polished'
    ? polishedJourney.narration.text
    : '').last()).toBeVisible();

  controller.history = [polishedJourney];
  await page.reload();
  await expect(page.getByRole('region', { name: '选歌过程' })).toBeVisible();
  await expect(page.getByText('今晚从熟悉的律动出发，也给耳朵留了一点变化。').last()).toBeVisible();
});
