import type { Page } from '@playwright/test';
import { download, expect, playAndWait, test, type Magpie } from '../fixtures';

async function setArchiveSize(magpie: Magpie, n: number) {
  const options = await magpie.context.newPage();
  await options.goto(`chrome-extension://${magpie.extensionId}/options.html`);
  const input = options.getByTestId('archive-size');
  await expect(input).toHaveValue('25');
  // Typing alone saves nothing; Enter commits, so a half typed number never trims the archive.
  await input.fill(String(n));
  await input.press('Enter');
  await expect(options.getByTestId('saved')).toHaveClass(/opacity-100/);
  await options.close();
}

function candidate(page: Page, urlPart: string) {
  return page.locator(`[data-testid="candidate"][data-url*="${urlPart}"]`);
}

test('a finished download moves to the archive and its media is hidden', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const manager = await magpie.manager();
  const { filename } = await download(manager, '/media/hls-ts/index.m3u8');
  expect(filename).toBe('Harbor at Dusk.mp4');

  const entry = manager.getByTestId('archive-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.getByTestId('archive-title')).toHaveText('Harbor at Dusk');
  await expect(entry).toContainText('0:20');
  const link = entry.getByRole('link');
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:8787/hls-ts.html');
  await expect(link).toHaveText('127.0.0.1/hls-ts.html');
  await expect(manager.getByTestId('job')).toHaveCount(0);

  // Already downloaded: hidden from the media list, one click shows it again.
  const row = candidate(manager, '/media/hls-ts/index.m3u8');
  await expect(row).toHaveCount(0);
  await manager.getByRole('button', { name: '1 downloaded' }).click();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('archived-badge')).toBeVisible();
  await manager.getByRole('button', { name: 'hide downloaded' }).click();
  await expect(row).toHaveCount(0);

  // The popup for that tab says so instead of "Nothing yet".
  const popup = await magpie.context.newPage();
  await popup.goto(`chrome-extension://${magpie.extensionId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await expect(popup.getByText('All media on this page is in your archive.')).toBeVisible({ timeout: 15_000 });
  await expect(popup.getByTestId('archive-entry')).toHaveCount(1);

  // The page link opens in a new tab.
  const opened = magpie.context.waitForEvent('page');
  await link.click();
  await expect(await opened).toHaveURL('http://127.0.0.1:8787/hls-ts.html');

  // Removing the entry makes the media available again.
  await entry.getByTitle(/^Remove from archive/).click();
  await expect(entry).toHaveCount(0);
  await expect(row.first()).toBeVisible();
  await expect(row.first().getByTestId('archived-badge')).toHaveCount(0);
});

test('archive size keeps the newest entries, and 0 turns the archive off', async ({ magpie }) => {
  await setArchiveSize(magpie, 1);
  const progressive = await magpie.context.newPage();
  await playAndWait(progressive, '/progressive.html');
  const hls = await magpie.context.newPage();
  await playAndWait(hls, '/hls-ts.html');
  const manager = await magpie.manager();

  await download(manager, '/media/progressive/clip.mp4');
  const entries = manager.getByTestId('archive-entry');
  // A plain MP4's length comes from its movie header, and a plain file hides like a stream.
  await expect(entries.first()).toContainText('0:20');
  await expect(candidate(manager, '/media/progressive/clip.mp4')).toHaveCount(0);
  await download(manager, '/media/hls-ts/index.m3u8');
  await expect(entries).toHaveCount(1);
  await expect(entries.first().getByTestId('archive-title')).toHaveText('Harbor at Dusk');
  // The entry that fell out no longer hides its media.
  await expect(candidate(manager, '/media/progressive/clip.mp4').first()).toBeVisible();

  const options = await magpie.context.newPage();
  await options.goto(`chrome-extension://${magpie.extensionId}/options.html`);
  await options.getByTitle('Keep one entry less').click();
  await expect(options.getByTestId('archive-size')).toHaveValue('0');
  await expect(entries).toHaveCount(0);

  // Archive off: a finished download stays in the list as done and hides nothing, as before 0.3.
  const row = candidate(manager, '/media/hls-ts/index.m3u8').first();
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: /^Download/ }).first().click();
  const job = manager.getByTestId('job').first();
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(job.getByRole('button', { name: 'Show' })).toBeVisible();
  await expect(entries).toHaveCount(0);
  await expect(row).toBeVisible();
});
