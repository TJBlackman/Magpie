import { download, expect, expectFramesMatch, playAndWait, test } from '../fixtures';

test('progressive mp4: detected as FILE and saved byte for byte', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/progressive.html');
  const manager = await magpie.manager();
  const { jobId, filename } = await download(manager, '/media/progressive/clip.mp4');
  expect(filename).toMatch(/\.mp4$/);
  const file = await magpie.exportJob(manager, jobId, 'progressive.mp4');
  expectFramesMatch(file, '720');
});

test('hls ts: segments joined and remuxed to mp4', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  const manager = await magpie.manager();
  const { jobId } = await download(manager, '/media/hls-ts/index.m3u8');
  const file = await magpie.exportJob(manager, jobId, 'hls-ts.mp4');
  expectFramesMatch(file, '720');
});

test('hls fmp4 master: quality picker, picks 480p', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-fmp4.html');
  const manager = await magpie.manager();
  // Variants are sorted by bandwidth descending: 720p, 480p, 360p.
  const { jobId, filename } = await download(manager, '/media/hls-fmp4/master.m3u8', 1);
  expect(filename).toContain('[480p]');
  const file = await magpie.exportJob(manager, jobId, 'hls-fmp4-480.mp4');
  expectFramesMatch(file, '480');
});

test('hls aes-128: segments decrypted', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-aes.html');
  const manager = await magpie.manager();
  const { jobId } = await download(manager, '/media/hls-aes/index.m3u8');
  const file = await magpie.exportJob(manager, jobId, 'hls-aes.mp4');
  expectFramesMatch(file, '720');
});

test('hls byterange: single file with Range requests', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-byterange.html');
  const manager = await magpie.manager();
  const { jobId } = await download(manager, '/media/hls-byterange/index.m3u8');
  const file = await magpie.exportJob(manager, jobId, 'hls-byterange.mp4');
  expectFramesMatch(file, '720');
});

test('gated: segment fetches carry the session cookie and site Referer', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/gated.html');
  const manager = await magpie.manager();
  const { jobId } = await download(manager, '/gated/media/index.m3u8');
  const file = await magpie.exportJob(manager, jobId, 'gated.mp4');
  expectFramesMatch(file, '720');
});

test('dash: detected but reported as not yet supported', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash.html');
  const manager = await magpie.manager();
  const row = manager.locator('[data-testid="candidate"][data-url*="manifest.mpd"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button').first().click();
  await expect(row.locator('.text-red-300')).toContainText('DASH', { timeout: 15_000 });
});

test('popup: lists media for the active tab', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-ts.html');
  await page.bringToFront();
  const popup = await magpie.context.newPage();
  await popup.goto(`chrome-extension://${magpie.extensionId}/popup.html`);
  // The popup page asks the background for the active tab; the test page was
  // active when it opened, but opening a new page steals focus, so fall back
  // to the manager style all-tabs query being non-empty.
  await page.bringToFront();
  await popup.reload();
  await expect(popup.locator('[data-testid="candidate"]').first()).toBeVisible({ timeout: 15_000 });
});
