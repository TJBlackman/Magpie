import type { Page } from '@playwright/test';
import { download, expect, openSettings, playAndWait, start, test, view, type Magpie } from '../fixtures';

async function setArchiveSize(magpie: Magpie, n: number) {
  const popup = await magpie.popup();
  await openSettings(popup);
  const input = popup.getByTestId('archive-size');
  await expect(input).toHaveValue('25');
  // Typing alone saves nothing; Enter commits, so a half typed number never trims history.
  await input.fill(String(n));
  await input.press('Enter');
  await expect(popup.getByTestId('saved')).toHaveClass(/opacity-100/);
  await popup.close();
}

function candidate(page: Page, urlPart: string) {
  return page.locator(`[data-testid="candidate"][data-url*="${urlPart}"]`);
}

test('a finished download moves to history and its media is hidden', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.popup();
  const { filename } = await download(popup, '/media/hls-ts/index.m3u8');
  expect(filename).toBe('Harbor at Dusk.mp4');

  await view(popup, 'History');
  const entry = popup.getByTestId('archive-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.getByTestId('archive-title')).toHaveText('Harbor at Dusk');
  await expect(entry).toContainText('0:20');
  const link = entry.getByRole('link');
  await expect(link).toHaveAttribute('href', 'http://127.0.0.1:8787/hls-ts.html');
  await expect(link).toHaveText('127.0.0.1/hls-ts.html');
  await expect(popup.getByTestId('job')).toHaveCount(0);

  // Already downloaded: hidden from the media list, one click shows it again.
  await view(popup, 'This page');
  const row = candidate(popup, '/media/hls-ts/index.m3u8');
  await expect(row).toHaveCount(0);
  await popup.getByRole('button', { name: '1 downloaded' }).click();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('archived-badge')).toBeVisible();
  await popup.getByRole('button', { name: 'Hide downloaded' }).click();
  await expect(row).toHaveCount(0);

  // The popup for that tab says so instead of "Nothing detected yet".
  const forTab = await magpie.popupFor(page);
  await expect(forTab.getByText('Everything here is already downloaded')).toBeVisible({ timeout: 15_000 });
  await expect(forTab.getByTestId('archive-entry')).toHaveCount(1);

  // The page link opens in a new tab.
  await view(popup, 'History');
  const opened = magpie.context.waitForEvent('page');
  await link.click();
  await expect(await opened).toHaveURL('http://127.0.0.1:8787/hls-ts.html');

  // Removing the entry makes the media available again.
  await entry.getByTitle(/^Remove from history/).click();
  await expect(entry).toHaveCount(0);
  await view(popup, 'This page');
  await expect(row.first()).toBeVisible();
  await expect(row.first().getByTestId('archived-badge')).toHaveCount(0);
});

test('history size keeps the newest entries, and 0 turns history off', async ({ magpie }) => {
  await setArchiveSize(magpie, 1);
  const progressive = await magpie.context.newPage();
  await playAndWait(progressive, '/progressive.html');
  const hls = await magpie.context.newPage();
  await playAndWait(hls, '/hls-ts.html');
  const popup = await magpie.popup();

  await download(popup, '/media/progressive/clip.mp4');
  const entries = popup.getByTestId('archive-entry');
  // A plain MP4's length comes from its movie header, and a plain file hides like a stream.
  await expect(entries.first()).toContainText('0:20');
  await expect(candidate(popup, '/media/progressive/clip.mp4')).toHaveCount(0);
  await download(popup, '/media/hls-ts/index.m3u8');
  await expect(entries).toHaveCount(1);
  await expect(entries.first().getByTestId('archive-title')).toHaveText('Harbor at Dusk');
  // The entry that fell out no longer hides its media.
  await expect(candidate(popup, '/media/progressive/clip.mp4').first()).toBeVisible();

  const settings = await magpie.popup();
  await openSettings(settings);
  await settings.getByTitle('Keep one entry less').click();
  await expect(settings.getByTestId('archive-size')).toHaveValue('0');
  await expect(entries).toHaveCount(0);

  // History off: a finished download leaves the list with no record, and hides nothing.
  // The segments are cached by now, so the job can be gone before a count check runs; record that it was listed.
  const row = candidate(popup, '/media/hls-ts/index.m3u8').first();
  await expect(row).toBeVisible();
  await popup.evaluate(() => {
    const w = window as unknown as { __jobsSeen: number };
    w.__jobsSeen = 0;
    new MutationObserver(() => (w.__jobsSeen = Math.max(w.__jobsSeen, document.querySelectorAll('[data-testid="job"]').length))).observe(document.body, { subtree: true, childList: true });
  });
  await start(popup, '/media/hls-ts/index.m3u8');
  await view(popup, 'Downloads');
  const jobs = popup.getByTestId('job');
  await expect(jobs).toHaveCount(0, { timeout: 60_000 });
  expect(await popup.evaluate(() => (window as unknown as { __jobsSeen: number }).__jobsSeen)).toBe(1);
  await expect(popup.getByText('Nothing downloading')).toBeVisible();
  await expect(entries).toHaveCount(0);
  await view(popup, 'This page');
  await expect(row).toBeVisible();
});
