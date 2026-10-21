import type { Page } from '@playwright/test';
import { expect, expectFramesMatch, expectFramesPrefix, playAndWait, probeTimes, test } from '../fixtures';

// /live.html replays the hls-ts clip as a live stream: two 4 s segments at the
// start, one more every 4 s, EXT-X-ENDLIST after the fifth (about 12 s in).

async function waitForReloads(page: Page, n: number) {
  await page.waitForFunction((min) => (window as unknown as { __levelLoads: number }).__levelLoads >= min, n, { timeout: 30_000 });
}

for (const churn of ['cachebust', 'msn']) {
  test(`live (${churn}): one row per stream while the player reloads with a new URL`, async ({ magpie }) => {
    const page = await magpie.context.newPage();
    await playAndWait(page, `/live.html?churn=${churn}`);
    await waitForReloads(page, 3);
    const manager = await magpie.manager();
    const rows = manager.locator('[data-testid="candidate"][data-url*="/live/"]');
    // The master is the row; its variant playlist, reloaded with a new URL each time, folds under it.
    await expect(rows.first().getByTestId('live-badge')).toBeVisible({ timeout: 15_000 });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-url', /master\.m3u8/);
  });
}

async function startRecording(manager: Page, prefix = '/live/') {
  const row = manager.locator(`[data-testid="candidate"][data-url*="${prefix}"][data-url*="master.m3u8"]`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button').first().click();
  await expect(row).toContainText('Live stream', { timeout: 15_000 });
  await row.getByRole('button', { name: /^Download/ }).first().click();
  const job = manager.locator('[data-testid="job"]').first();
  await expect(job.getByTestId('job-status')).toContainText(/Recording \d+:\d\d/, { timeout: 15_000 });
  return job;
}

test('live: records until the stream ends, every frame present', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html');
  const manager = await magpie.manager();
  const job = await startRecording(manager);
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(job).toHaveAttribute('data-filename', /^Harbor Webcam \[720p\] \d{4}-\d\d-\d\d \d\d\.\d\d\.mp4$/);
  const file = await magpie.exportJob(manager, (await job.getAttribute('data-job-id'))!, 'live.mp4');
  expectFramesMatch(file, '720');
});

test('live: Stop saves what was recorded so far', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html');
  const manager = await magpie.manager();
  const job = await startRecording(manager);
  await job.getByRole('button', { name: 'Stop' }).click();
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const file = await magpie.exportJob(manager, (await job.getAttribute('data-job-id'))!, 'live-stopped.mp4');
  // At least the two segments out at the start, 120 frames each, and not the whole clip.
  expectFramesPrefix(file, '720', 240);
});

test('live fmp4 stamped hours into the stream: the file starts at 0', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html?src=fmp4');
  const manager = await magpie.manager();
  const job = await startRecording(manager, '/live-fmp4/');
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const file = await magpie.exportJob(manager, (await job.getAttribute('data-job-id'))!, 'live-fmp4.mp4');
  // The source fragments are stamped 4 hours in; the saved file runs 0 to 20 s.
  const { start, duration } = probeTimes(file);
  expect(start).toBeLessThan(0.1);
  expect(duration).toBeGreaterThan(19.9);
  expect(duration).toBeLessThan(20.2);
  expectFramesMatch(file, '720');
});
