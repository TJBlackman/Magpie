import type { Locator, Page } from '@playwright/test';
import { expect, expectAudioCut, expectAudioMatch, expectAvPair, expectFramesCut, expectFramesMatch, expectFramesPrefix, finished, openCandidate, playAndWait, probeTimes, test, view } from '../fixtures';

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
    const popup = await magpie.popup();
    const rows = popup.locator('[data-testid="candidate"][data-url*="/live/"]');
    // The master is the row; its variant playlist, reloaded with a new URL each time, folds under it.
    await expect(rows.first().getByTestId('live-badge')).toBeVisible({ timeout: 15_000 });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-url', /master\.m3u8/);
  });
}

async function startRecording(popup: Page, prefix = '/live/', manifest = 'master.m3u8') {
  const sheet = await openCandidate(popup, [prefix, manifest]);
  await expect(sheet).toContainText('Live stream', { timeout: 15_000 });
  const start = sheet.getByTestId('start');
  await expect(start).toHaveText('Start recording');
  await start.click();
  await view(popup, 'Downloads');
  const job = popup.locator('[data-testid="job"]').first();
  await expect(job.getByTestId('job-status')).toContainText(/Recording \d+:\d\d/, { timeout: 15_000 });
  return job;
}

test('live: records until the stream ends, every frame present', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html');
  const popup = await magpie.popup();
  await startRecording(popup);
  const { jobId, filename } = await finished(popup);
  expect(filename).toMatch(/^Harbor Webcam \[720p\] \d{4}-\d\d-\d\d \d\d\.\d\d\.mp4$/);
  // A recorded live stream stays available: the next recording holds new footage.
  await view(popup, 'This page');
  await expect(popup.locator('[data-testid="candidate"][data-url*="/live/"]').first()).toBeVisible();
  const file = await magpie.exportJob(popup, jobId, 'live.mp4');
  expectFramesMatch(file, '720');
});

test('live: Stop saves what was recorded so far', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html');
  const popup = await magpie.popup();
  const job = await startRecording(popup);
  await job.getByRole('button', { name: 'Stop' }).click();
  const { jobId } = await finished(popup);
  const file = await magpie.exportJob(popup, jobId, 'live-stopped.mp4');
  // At least the two segments out at the start, 120 frames each, and not the whole clip.
  expectFramesPrefix(file, '720', 240);
});

test('live fmp4 stamped hours into the stream: the file starts at 0', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html?src=fmp4');
  const popup = await magpie.popup();
  await startRecording(popup, '/live-fmp4/');
  const { jobId } = await finished(popup);
  const file = await magpie.exportJob(popup, jobId, 'live-fmp4.mp4');
  // The source fragments are stamped 4 hours in; the saved file runs 0 to 20 s.
  const { start, duration } = probeTimes(file);
  expect(start).toBeLessThan(0.1);
  expect(duration).toBeGreaterThan(19.9);
  expect(duration).toBeLessThan(20.2);
  expectFramesMatch(file, '720');
});

// /live.html?src=ads replays the clip the way Twitch stitches ads into a viewer's playlist (see liveSim in the
// test server): an fMP4 preroll behind EXT-X-MAP, the first two live segments, a TS midroll in place of the
// third, then the last two. Each ad sits behind EXT-X-DISCONTINUITY tags on a clock of its own and is titled
// after its source; the live segments are titled "live", under EXT-X-TWITCH tags.
test('live with stitched ads: records the stream without them, the audio in step across the breaks', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live.html?src=ads');
  const popup = await magpie.popup();
  const job = await startRecording(popup, '/live-ads/');
  await expect(job.getByTestId('job-note')).toContainText(/Skipped \d+ s of Twitch ads/, { timeout: 30_000 });
  const { jobId } = await finished(popup);
  const file = await magpie.exportJob(popup, jobId, 'live-ads.mp4');
  // Four of the five live segments, 120 frames each: the midroll took the third's place. No ad frames.
  expectFramesCut(file, '720', 480);
  // Their audio too, about 16 s at 46.875 packets a second, and nothing of the ads'.
  expectAudioCut(file, 740, 760);
  expectAvPair(file);
  const { start, duration } = probeTimes(file);
  expect(start).toBeLessThan(0.1);
  expect(duration).toBeGreaterThan(15.9);
  expect(duration).toBeLessThan(16.3);
});

// /live-dash.html replays the dash clip as a dynamic MPD on a session clock
// that starts with the player's first request: 4 s segment n is published 4n s
// in, the MPD keeps 20 s of time shift and has the player reload it every 2 s,
// and 24 s in it turns static with all five segments. The audio's sixth chunk
// is never listed. Playback starts about 4 s in, with segment 1.

/** Wait for the live DASH row's LIVE badge, then start recording its top variant, video with the audio merged. */
async function startDashRecording(popup: Page, prefix = '/live-dash/') {
  await view(popup, 'This page');
  const row = popup.locator(`[data-testid="candidate"][data-url*="${prefix}"]`).first();
  await expect(row.getByTestId('live-badge')).toBeVisible({ timeout: 15_000 });
  return startRecording(popup, prefix, 'manifest.mpd');
}

/** Seconds a recording job's row says it holds, from its "Recording m:ss" status: the video segments written so far. */
async function recordedSeconds(job: Locator): Promise<number> {
  const m = /Recording (\d+):(\d\d)/.exec((await job.getByTestId('job-status').textContent()) ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

test('live dash: records until the stream ends', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live-dash.html');
  const popup = await magpie.popup();
  await startDashRecording(popup);
  // No Stop: the recording ends on its own once the MPD turns static, 24 s into the session.
  const { jobId, filename } = await finished(popup);
  expect(filename).toMatch(/^Lighthouse Webcam \[720p\] \d{4}-\d\d-\d\d \d\d\.\d\d\.mp4$/);
  const file = await magpie.exportJob(popup, jobId, 'live-dash.mp4');
  // Every frame: the recording starts up to 30 s back and the MPD keeps 20 s, so segment 1 is
  // always in the first window, and the static MPD at the end lists the rest.
  expectFramesMatch(file, '720');
  // The MPD lists 5 of the 6 audio chunks, so the last packet is missing, as in the static DASH test.
  expectAudioMatch(file, { allowMissing: 1 });
  expectAvPair(file);
});

test('live dash: stop saves what it has', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live-dash.html');
  const popup = await magpie.popup();
  const job = await startDashRecording(popup);
  // Stop once the row shows two 4 s video segments written, however late the recording started.
  await expect.poll(() => recordedSeconds(job), { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
  // Measured from before the player's first request, so this runs long, never short (see live-dash.html).
  const sessionMs = await page.evaluate(() => Date.now() - (window as unknown as { __sessionStart: number }).__sessionStart);
  await job.getByRole('button', { name: 'Stop' }).click();
  const { jobId } = await finished(popup);
  const file = await magpie.exportJob(popup, jobId, 'live-dash-stopped.mp4');
  // Segment 5 is out 20 s into the session, and Stop reloads the MPD once more within a second or two of the
  // click. A click by 17 s therefore leaves the file short of the whole clip. A recording that started so late
  // that its second segment came after that can only be checked as a prefix: best effort, noted on the result.
  const early = sessionMs < 17_000;
  if (!early) test.info().annotations.push({ type: 'best effort', description: `Stop came ${sessionMs} ms into the session; the whole clip may be in the file` });
  // At least the two segments the row showed, 120 frames each.
  expectFramesPrefix(file, '720', 240, { allowAll: !early });
  // The audio of the same segments: two 4 s chunks are 375 of the 939 packets (48 kHz, 1024 samples each).
  expectAudioMatch(file, { allowMissing: 939 - 375 });
  expectAvPair(file);
});

// /live-dash.html?mode=timeline replays the dash-timeline clip as a dynamic MPD whose $Time$ SegmentTimeline lists
// the newest four segments and keeps startNumber at 1, so every MPD numbers its segments from 1 again. The first
// segment is out at once, the fifth 16 s in, when the first leaves the window, and 20 s in the MPD turns static
// with the same four. A recorder that followed segment numbers would never fetch the fifth.
test('live dash timeline: follows a sliding $Time$ timeline to the end', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/live-dash.html?mode=timeline');
  const popup = await magpie.popup();
  await startDashRecording(popup, '/live-dash-timeline/');
  // No Stop: the recording ends on its own once the MPD turns static.
  const { jobId, filename } = await finished(popup);
  expect(filename).toMatch(/^Lighthouse Webcam \[720p\] \d{4}-\d\d-\d\d \d\d\.\d\d\.mp4$/);
  const file = await magpie.exportJob(popup, jobId, 'live-dash-timeline.mp4');
  // Every frame: the recording starts well before segment 1 leaves the window at 16 s.
  expectFramesMatch(file, '720');
  // This fixture's five audio chunks hold every packet, as the static dash-timeline download shows.
  expectAudioMatch(file);
  expectAvPair(file);
});
