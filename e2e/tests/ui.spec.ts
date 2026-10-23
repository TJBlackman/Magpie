import type { Page } from '@playwright/test';
import { download, expect, playAndWait, test } from '../fixtures';

/** Record what the manager's job rows go through, so short lived states are not missed. */
async function watchJobs(manager: Page) {
  await manager.evaluate(() => {
    const w = window as unknown as { __obs: { maxActive: number; queued: string[]; pcts: number[] } };
    w.__obs = { maxActive: 0, queued: [], pcts: [] };
    const check = () => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="job"]')];
      const active = rows.filter((r) => ['inspecting', 'downloading', 'muxing', 'saving'].includes(r.dataset.state ?? ''));
      w.__obs.maxActive = Math.max(w.__obs.maxActive, active.length);
      for (const r of rows) {
        if (r.dataset.state === 'queued') w.__obs.queued.push(r.querySelector('[data-testid="job-status"]')?.textContent ?? '');
        if (r.dataset.state === 'downloading' && r.dataset.pct) w.__obs.pcts.push(Number(r.dataset.pct));
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

async function observed(manager: Page) {
  return manager.evaluate(() => (window as unknown as { __obs: { maxActive: number; queued: string[]; pcts: number[] } }).__obs);
}

async function openSlowCandidate(manager: Page) {
  const row = manager.locator('[data-testid="candidate"][data-url*="/slow/progressive/clip.mp4"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button').first().click();
  const dl = row.getByRole('button', { name: /^Download/ }).first();
  await expect(dl).toBeVisible({ timeout: 15_000 });
  return dl;
}

test('media list leads with the page title, not the URL', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const manager = await magpie.manager();
  const row = manager.locator('[data-testid="candidate"][data-url*="/media/hls-ts/index.m3u8"]').first();
  await expect(row.getByTestId('candidate-title')).toHaveText('Harbor at Dusk', { timeout: 15_000 });
  await expect(row).toContainText('index.m3u8');
});

test('progress bar fills while a plain file downloads', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/slow.html');
  const manager = await magpie.manager();
  await watchJobs(manager);
  await (await openSlowCandidate(manager)).click();
  const job = manager.locator('[data-testid="job"]').first();
  await expect(job.getByTestId('job-status')).toContainText(/ of .*%/, { timeout: 15_000 });
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(job).toHaveAttribute('data-filename', 'Slow River.mp4');
  const { pcts } = await observed(manager);
  const between = [...new Set(pcts.filter((p) => p > 0 && p < 100))];
  expect(between.length, `intermediate percentages seen: ${between.join(', ')}`).toBeGreaterThanOrEqual(3);
  expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
});

test('settings limit concurrent downloads and extra clicks queue up', async ({ magpie }) => {
  const options = await magpie.context.newPage();
  await options.goto(`chrome-extension://${magpie.extensionId}/options.html`);
  const input = options.getByTestId('max-concurrent');
  await expect(input).toHaveValue('2');
  await options.getByTitle('One fewer').click();
  await expect(input).toHaveValue('1');
  await expect(options.getByTestId('saved')).toHaveClass(/opacity-100/);

  const page = await magpie.context.newPage();
  await playAndWait(page, '/slow.html');
  const manager = await magpie.manager();
  await watchJobs(manager);
  const dl = await openSlowCandidate(manager);
  await dl.click();
  await dl.click();
  await dl.click();

  const jobs = manager.locator('[data-testid="job"]');
  await expect(jobs).toHaveCount(3);
  await expect(manager.locator('[data-testid="job"][data-state="queued"]')).toHaveCount(2, { timeout: 5_000 });
  for (let i = 0; i < 3; i++) await expect(jobs.nth(i)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });

  const { maxActive, queued } = await observed(manager);
  expect(maxActive).toBe(1);
  expect(queued).toContain('Waiting, #2 in queue');
  expect(queued).toContain('Waiting, #1 in queue');
});

test('clear empties the popup list right away', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.context.newPage();
  await popup.goto(`chrome-extension://${magpie.extensionId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await expect(popup.getByTestId('candidate').first()).toBeVisible({ timeout: 15_000 });
  await popup.getByRole('button', { name: 'clear' }).click();
  await expect(popup.getByTestId('candidate')).toHaveCount(0, { timeout: 2_000 });
  await expect(popup.getByText('Nothing yet.')).toBeVisible();
});

test('clear finished drops done downloads and keeps running ones', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/progressive.html');
  const slow = await magpie.context.newPage();
  await playAndWait(slow, '/slow.html');
  const manager = await magpie.manager();
  await download(manager, '/media/progressive/clip.mp4');
  await (await openSlowCandidate(manager)).click();
  const jobs = manager.getByTestId('job');
  await expect(jobs.and(manager.locator('[data-state="downloading"]'))).toHaveCount(1, { timeout: 15_000 });

  const popup = await magpie.context.newPage();
  await popup.goto(`chrome-extension://${magpie.extensionId}/popup.html`);
  await expect(popup.getByTestId('job')).toHaveCount(2);
  await expect(popup.getByRole('button', { name: 'clear finished' })).toBeVisible();

  await manager.getByRole('button', { name: 'Clear finished' }).click();
  await expect(jobs).toHaveCount(1, { timeout: 2_000 });
  await expect(jobs.first()).not.toHaveAttribute('data-state', 'done');
  await expect(manager.getByRole('button', { name: 'Clear finished' })).toHaveCount(0);
  await expect(popup.getByTestId('job')).toHaveCount(1, { timeout: 2_000 });
  await expect(popup.getByRole('button', { name: 'clear finished' })).toHaveCount(0);
});
