import { download, expect, expectFramesMatch, openCandidate, playAndWait, start, test, view } from '../fixtures';

test('progressive mp4: detected as FILE and saved byte for byte', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/progressive.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await download(popup, '/media/progressive/clip.mp4');
  expect(filename).toMatch(/\.mp4$/);
  const file = await magpie.exportJob(popup, jobId, 'progressive.mp4');
  expectFramesMatch(file, '720');
});

test('a started download grays its card on This page and opens on the Downloads tab', async ({ magpie }) => {
  // The crawl page serves its file at about 200 KB/s, so the job is still running while the card is checked.
  const page = await magpie.context.newPage();
  await playAndWait(page, '/crawl.html');
  const popup = await magpie.popup();
  const row = popup.locator('[data-testid="candidate"][data-url*="/crawl/progressive/clip.mp4"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('data-state', 'fresh');
  await start(popup, '/crawl/progressive/clip.mp4');
  await expect(row).toHaveAttribute('data-state', 'queued');
  await expect(row).toHaveClass(/grayscale/);
  await expect(row.getByTestId('queued-badge')).toBeVisible();
  // Opening a gray card shows its job on Downloads instead of a second quality sheet.
  await row.getByRole('button').first().click();
  await expect(popup.getByTestId('sheet')).toHaveCount(0);
  await expect(popup.getByRole('tab', { name: /Downloads/ })).toHaveAttribute('aria-selected', 'true');
  const job = popup.locator('[data-testid="job"]');
  await expect(job).toHaveCount(1);
  await expect(job.first()).toHaveClass(/flash/);
  await job.first().getByRole('button', { name: 'Cancel' }).click();
  await expect(job).toHaveCount(0);
  // Cancelled, so the card is back to normal.
  await view(popup, 'This page');
  await expect(row).toHaveAttribute('data-state', 'fresh');
});

test('hls ts: segments joined and remuxed to mp4', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await download(popup, '/media/hls-ts/index.m3u8');
  // og:title wins over <title>, and the "| Magpie Test Site" suffix is dropped.
  expect(filename).toBe('Harbor at Dusk.mp4');
  const file = await magpie.exportJob(popup, jobId, 'hls-ts.mp4');
  expectFramesMatch(file, '720');
});

test('hls fmp4 master: quality picker, picks 480p', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-fmp4.html');
  const popup = await magpie.popup();
  // Variants are sorted by bandwidth descending: 720p, 480p, 360p.
  const { jobId, filename } = await download(popup, '/media/hls-fmp4/master.m3u8', 1);
  expect(filename).toBe('Night Train, multi rendition [480p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'hls-fmp4-480.mp4');
  expectFramesMatch(file, '480');
});

test('hls aes-128: segments decrypted', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-aes.html');
  const popup = await magpie.popup();
  const { jobId } = await download(popup, '/media/hls-aes/index.m3u8');
  const file = await magpie.exportJob(popup, jobId, 'hls-aes.mp4');
  expectFramesMatch(file, '720');
});

test('hls byterange: single file with Range requests', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-byterange.html');
  const popup = await magpie.popup();
  const { jobId } = await download(popup, '/media/hls-byterange/index.m3u8');
  const file = await magpie.exportJob(popup, jobId, 'hls-byterange.mp4');
  expectFramesMatch(file, '720');
});

test('gated: segment fetches carry the session cookie and site Referer', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/gated.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await download(popup, '/gated/media/index.m3u8');
  expect(filename).toBe('Gated HLS.mp4');
  const file = await magpie.exportJob(popup, jobId, 'gated.mp4');
  expectFramesMatch(file, '720');
});

test('dash: detected but reported as not yet supported', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash.html');
  const popup = await magpie.popup();
  const sheet = await openCandidate(popup, 'manifest.mpd');
  await expect(sheet.getByTestId('inspect-error')).toContainText('DASH', { timeout: 15_000 });
  await expect(sheet.getByTestId('start')).toHaveCount(0);
});

test('popup for one tab lists that tab only', async ({ magpie }) => {
  const other = await magpie.context.newPage();
  await playAndWait(other, '/progressive.html');
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const popup = await magpie.popupFor(page);
  await expect(popup.locator('[data-testid="candidate"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(popup.getByText('Media on this page')).toBeVisible();
  await expect(popup.getByTestId('candidate-title')).toHaveText(['Harbor at Dusk']);
  // Opened as a page of its own, every tab is listed and grouped by page.
  const all = await magpie.popup();
  await expect(all.getByText('Media in open tabs')).toBeVisible();
  await expect(all.getByTestId('candidate')).toHaveCount(2, { timeout: 15_000 });
  await expect(all.getByText('127.0.0.1/progressive.html')).toBeVisible();
});
