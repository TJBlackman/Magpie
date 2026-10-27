import type { Page } from '@playwright/test';
import { expect, finished, openSettings, playAndWait, start, test, view } from '../fixtures';

/** Record what the popup's job rows go through, so short lived states are not missed. */
async function watchJobs(popup: Page) {
  await popup.evaluate(() => {
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

async function observed(popup: Page) {
  return popup.evaluate(() => (window as unknown as { __obs: { maxActive: number; queued: string[]; pcts: number[] } }).__obs);
}

const SLOW = '/slow/progressive/clip.mp4';

test('media list leads with the page title, not the URL', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.popup();
  const row = popup.locator('[data-testid="candidate"][data-url*="/media/hls-ts/index.m3u8"]').first();
  await expect(row.getByTestId('candidate-title')).toHaveText('Harbor at Dusk', { timeout: 15_000 });
  await expect(row).toContainText('index.m3u8');
});

test('progress bar fills while a plain file downloads', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/slow.html');
  const popup = await magpie.popup();
  await watchJobs(popup);
  await start(popup, SLOW);
  await view(popup, 'Downloads');
  const job = popup.locator('[data-testid="job"]').first();
  await expect(job.getByTestId('job-status')).toContainText(/ of .*%/, { timeout: 15_000 });
  const { filename } = await finished(popup);
  expect(filename).toBe('Slow River.mp4');
  const { pcts } = await observed(popup);
  const between = [...new Set(pcts.filter((p) => p > 0 && p < 100))];
  expect(between.length, `intermediate percentages seen: ${between.join(', ')}`).toBeGreaterThanOrEqual(3);
  expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
});

test('settings limit concurrent downloads and extra clicks queue up', async ({ magpie }) => {
  const settings = await magpie.popup();
  await openSettings(settings);
  const input = settings.getByTestId('max-concurrent');
  await expect(input).toHaveValue('2');
  await settings.getByTitle('One fewer').click();
  await expect(input).toHaveValue('1');
  await expect(settings.getByTestId('saved')).toHaveClass(/opacity-100/);
  await settings.close();

  // One card per tab: a card with a job already on Downloads will not start a second one.
  for (let i = 0; i < 3; i++) await playAndWait(await magpie.context.newPage(), '/slow.html');
  const popup = await magpie.popup();
  await watchJobs(popup);
  await start(popup, SLOW);
  await start(popup, SLOW);
  await start(popup, SLOW);

  await view(popup, 'Downloads');
  const jobs = popup.locator('[data-testid="job"]');
  await expect(jobs).toHaveCount(3);
  await expect(popup.locator('[data-testid="job"][data-state="queued"]')).toHaveCount(2, { timeout: 5_000 });
  // Each finished download moves from the list to History.
  await expect(popup.getByTestId('archive-entry')).toHaveCount(3, { timeout: 60_000 });
  await expect(jobs).toHaveCount(0);
  await expect(popup.getByText('Nothing downloading')).toBeVisible();

  const { maxActive, queued } = await observed(popup);
  expect(maxActive).toBe(1);
  expect(queued).toContain('Waiting, #2 in queue');
  expect(queued).toContain('Waiting, #1 in queue');
});

test('clear empties the popup list right away', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.popupFor(page);
  await expect(popup.getByTestId('candidate').first()).toBeVisible({ timeout: 15_000 });
  await popup.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(popup.getByTestId('candidate')).toHaveCount(0, { timeout: 2_000 });
  await expect(popup.getByText('Nothing detected yet')).toBeVisible();
});

test('quality sheet closes on Escape and on the veil', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-fmp4.html');
  const popup = await magpie.popup();
  const row = popup.locator('[data-testid="candidate"][data-url*="master.m3u8"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button').first().click();
  const sheet = popup.getByTestId('sheet');
  await expect(sheet.getByTestId('variant')).toHaveCount(3, { timeout: 15_000 });
  // The top rendition is picked by default and the main button names it.
  await expect(sheet.getByTestId('variant').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByTestId('start')).toHaveText('Download 720p');
  await sheet.getByTestId('variant').nth(2).click();
  await expect(sheet.getByTestId('start')).toHaveText('Download 360p');
  await popup.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await row.getByRole('button').first().click();
  await expect(sheet).toBeVisible();
  await popup.getByTestId('veil').click({ position: { x: 200, y: 20 } });
  await expect(sheet).toHaveCount(0);
});

test('cancel drops a download at once and keeps the others running', async ({ magpie }) => {
  // The crawl page serves its file at about 200 KB/s, so that download runs for about half a minute.
  const crawl = await magpie.context.newPage();
  await playAndWait(crawl, '/crawl.html');
  const slow = await magpie.context.newPage();
  await playAndWait(slow, '/slow.html');
  const popup = await magpie.popup();
  await start(popup, '/crawl/progressive/clip.mp4');
  const jobs = popup.getByTestId('job');
  const running = popup.locator('[data-testid="job"][data-filename="Crawling River.mp4"]');
  await expect(running).toHaveAttribute('data-state', 'downloading', { timeout: 15_000 });
  await start(popup, SLOW);
  await view(popup, 'Downloads');
  await expect(jobs).toHaveCount(2);
  await popup.locator('[data-testid="job"][data-filename="Slow River.mp4"]').getByRole('button', { name: 'Cancel' }).click();
  await expect(jobs).toHaveCount(1, { timeout: 2_000 });
  await expect(running).toHaveAttribute('data-state', 'downloading');
  // Nothing finished or cancelled is listed, in this popup or another.
  await expect(popup.getByText('Failed')).toHaveCount(0);
  const other = await magpie.popup();
  await view(other, 'Downloads');
  await expect(other.getByTestId('job')).toHaveCount(1);

  await running.getByRole('button', { name: 'Cancel' }).click();
  await expect(jobs).toHaveCount(0, { timeout: 2_000 });
  await expect(popup.getByText('Nothing downloading')).toBeVisible();
  await expect(other.getByTestId('job')).toHaveCount(0, { timeout: 2_000 });
});
