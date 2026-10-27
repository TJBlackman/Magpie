import type { Page } from '@playwright/test';
import { download, expect, expectAudioMatch, expectAvPair, expectFramesMatch, finished, newestEntry, openCandidate, playAndWait, start, test, view } from '../fixtures';

/** Open a candidate's sheet, check its top rendition's label, and download that rendition. */
async function downloadChecked(popup: Page, urlPart: string, label: string | RegExp) {
  const previous = await newestEntry(popup);
  const sheet = await openCandidate(popup, urlPart);
  await expect(sheet.getByTestId('variant').first()).toContainText(label, { timeout: 15_000 });
  await sheet.getByTestId('start').click();
  await expect(sheet).toHaveCount(0);
  return finished(popup, previous);
}

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

test('hls altaudio fmp4: video and audio merged', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-altaudio.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await downloadChecked(popup, 'hls-altaudio/master.m3u8', '+ audio_0');
  expect(filename).toBe('HLS separate audio [720p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'hls-altaudio.mp4');
  expectFramesMatch(file, '720');
  expectAudioMatch(file);
  expectAvPair(file);
});

test('hls altaudio ts: video and audio merged', async ({ magpie }) => {
  // Both renditions are MPEG-TS: each goes through mux.js on its own, and the two tracks join like fMP4 ones.
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-altaudio-ts.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await downloadChecked(popup, 'hls-altaudio-ts/master.m3u8', '+ audio_0');
  expect(filename).toBe('HLS separate audio TS [720p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'hls-altaudio-ts.mp4');
  expectFramesMatch(file, '720');
  expectAudioMatch(file);
  expectAvPair(file);
});

test('dash: picks 360p, merges audio', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash.html');
  const popup = await magpie.popup();
  // Representations are sorted by bandwidth descending: 720p, 360p.
  const { jobId, filename } = await download(popup, 'dash/manifest.mpd', 1);
  expect(filename).toContain('[360p]');
  const file = await magpie.exportJob(popup, jobId, 'dash-360.mp4');
  expectFramesMatch(file, '360');
  // The MPD lists 5 of the 6 audio chunks ffmpeg wrote, so the last packet is missing.
  expectAudioMatch(file, { allowMissing: 1 });
  expectAvPair(file);
});

test('dash: 720p, with its length in history', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await downloadChecked(popup, 'dash/manifest.mpd', /1280x720 .* \+ audio$/);
  expect(filename).toBe('DASH [720p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'dash-720.mp4');
  expectFramesMatch(file, '720');
  // The MPD lists 5 of the 6 audio chunks ffmpeg wrote, so the last packet is missing.
  expectAudioMatch(file, { allowMissing: 1 });
  expectAvPair(file);
  await view(popup, 'History');
  await expect(popup.getByTestId('archive-entry').first()).toContainText('0:20');
  await view(popup, 'This page');
  await expect(popup.locator('[data-testid="candidate"][data-url*="dash/manifest.mpd"]')).toHaveCount(0);
});

test('dash timeline: SegmentTimeline with $Time$ names', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash-timeline.html');
  const popup = await magpie.popup();
  const { jobId, filename } = await download(popup, 'dash-timeline/manifest.mpd');
  expect(filename).toBe('DASH SegmentTimeline [720p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'dash-timeline.mp4');
  expectFramesMatch(file, '720');
  expectAudioMatch(file);
  expectAvPair(file);
});

test('dash segmentbase: single files with Range requests, rows folded', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/dash-single.html');
  // The player's requests for rep-0.mp4 and friends never get rows of their own. This cannot fail on
  // this fixture, though: dash.js fetches the files in Range requests under 2 MB, which detect() never
  // lists, so the rows would be missing with or without folding. The fold rules themselves are covered
  // by src/background/sniffer.test.ts.
  const forTab = await magpie.popupFor(page);
  const rows = forTab.getByTestId('candidate');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-url', /dash-single\/manifest\.mpd$/);
  const popup = await magpie.popup();
  const { jobId, filename } = await download(popup, 'dash-single/manifest.mpd');
  expect(filename).toBe('DASH SegmentBase [720p].mp4');
  const file = await magpie.exportJob(popup, jobId, 'dash-single.mp4');
  expectFramesMatch(file, '720');
  expectAudioMatch(file);
  expectAvPair(file);
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
