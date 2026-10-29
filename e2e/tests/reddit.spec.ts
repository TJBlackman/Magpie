import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, expectAudioMatch, expectAvPair, expectFramesMatch, finished, newestEntry, test, view, type Magpie } from '../fixtures';
import { testsiteDir } from '../paths';

const FIXTURES = join(testsiteDir, 'public', 'media', 'reddit');
const md5 = (buf: Buffer) => createHash('md5').update(buf).digest('hex');
const fixtureMd5 = (name: string) => md5(readFileSync(join(FIXTURES, name)));

/**
 * The post.json the background wrote for the post with `id`, decoded from the
 * data: URL it handed the downloads API. Playwright saves extension downloads
 * under names of its own, so the URL is the reliable way to find it.
 */
async function sidecarFor(popup: Page, id: string): Promise<{ filename: string; body: Record<string, unknown> }> {
  let found: { filename: string; body: Record<string, unknown> } | undefined;
  await expect
    .poll(async () => {
      const items = await popup.evaluate(() => chrome.downloads.search({}).then((list) => list.map((d) => ({ url: d.url, filename: d.filename, state: d.state }))));
      for (const d of items) {
        if (!d.url.startsWith('data:application/json') || d.state !== 'complete') continue;
        const body = JSON.parse(decodeURIComponent(d.url.slice(d.url.indexOf(',') + 1))) as Record<string, unknown>;
        if (body.id === id) found = { filename: d.filename, body };
      }
      return found !== undefined;
    })
    .toBe(true);
  return found!;
}

/** The post row whose permalink holds `part`. Post rows carry the permalink as their URL. */
function post(popup: Page, part: string) {
  return popup.locator(`[data-testid="candidate"][data-url*="${part}"]`);
}

/** Open the feed and the popup for its tab, where every post is a row. */
async function openFeed(magpie: Magpie) {
  const page = await magpie.context.newPage();
  await page.goto('/reddit.html');
  const popup = await magpie.popupFor(page);
  await expect(post(popup, '/comments/gal1/')).toBeVisible({ timeout: 15_000 });
  return { page, popup };
}

/**
 * Open a post's sheet, check how many files it lists, and press Download.
 * Returns the job ids of the group, in file order. A small file is saved
 * within milliseconds, so the ids come from the job events the popup gets,
 * which carry every job from the moment it is queued.
 */
async function startPost(popup: Page, part: string, files: number): Promise<string[]> {
  await view(popup, 'This page');
  const row = post(popup, part);
  await row.getByRole('button').first().click();
  const sheet = popup.getByTestId('sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('post-files').locator('li')).toHaveCount(files, { timeout: 15_000 });
  await expect(sheet.getByTestId('start')).toHaveText(files === 1 ? 'Download 1 file' : `Download ${files} files`);
  await popup.evaluate(() => {
    const seen = new Map<string, number>();
    (window as unknown as { __jobs: Map<string, number> }).__jobs = seen;
    chrome.runtime.onMessage.addListener((m: { magpie?: string; event?: { type: string; jobs?: { id: string; group?: { index: number } }[] } }) => {
      if (m?.magpie === 'ui' && m.event?.type === 'jobs') for (const j of m.event.jobs ?? []) if (j.group) seen.set(j.id, j.group.index);
    });
  });
  await sheet.getByTestId('start').click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => popup.evaluate(() => (window as unknown as { __jobs: Map<string, number> }).__jobs.size)).toBe(files);
  const ids = await popup.evaluate(() => [...(window as unknown as { __jobs: Map<string, number> }).__jobs].sort((a, b) => a[1] - b[1]).map(([id]) => id));
  expect(ids, 'one job per file').toHaveLength(files);
  return ids;
}

test('a feed lists one row per post with what it holds, and never the ad', async ({ magpie }) => {
  const { popup } = await openFeed(magpie);
  const rows = popup.getByTestId('candidate');
  // gallery, image, gif, video, hls video, link, text. The ad is not a shreddit-post.
  await expect(rows).toHaveCount(7);
  await expect(popup.locator('[data-testid="candidate"][data-url*="/comments/ad1/"]')).toHaveCount(0);
  await expect(post(popup, '/comments/gal1/')).toContainText('r/magpietest · Gallery, 4 images');
  await expect(post(popup, '/comments/gal1/').getByTestId('candidate-title')).toHaveText('Four noisy squares');
  await expect(post(popup, '/comments/img1/')).toContainText('Image, JPG');
  await expect(post(popup, '/comments/gif1/')).toContainText('GIF');
  await expect(post(popup, '/comments/vid1/')).toContainText('Video 720p');
  await expect(post(popup, '/comments/hls1/')).toContainText('Video');
  await expect(post(popup, '/comments/lnk1/')).toContainText('Link');
  // Rows in page order, top of the page first.
  await expect(rows.first()).toHaveAttribute('data-url', /gal1/);
  await expect(rows.last()).toHaveAttribute('data-url', /txt1/);
  // The post's preview is its tile; nothing is fetched to make one.
  await expect(post(popup, '/comments/gal1/').getByTestId('thumb')).toHaveAttribute('src', /\/media\/reddit\/single\.jpg/);

  // A link post has nothing to save, and the sheet says so without a button.
  await post(popup, '/comments/lnk1/').getByRole('button').first().click();
  const sheet = popup.getByTestId('sheet');
  await expect(sheet).toContainText('Not hosted on Reddit');
  await expect(sheet.getByTestId('start')).toHaveCount(0);
});

test('gallery: every original saved byte for byte into one folder, one history entry for the post', async ({ magpie }) => {
  const { popup } = await openFeed(magpie);
  const previous = await newestEntry(popup);
  const ids = await startPost(popup, '/comments/gal1/', 4);

  // The four files are one row on Downloads, and while they download the post's card is gray; opening it shows that row.
  await view(popup, 'Downloads');
  const group = popup.getByTestId('job-group').first();
  await expect(group).toBeVisible();
  expect(((await group.getAttribute('data-jobs')) ?? '').split(' ').sort()).toEqual([...ids].sort());
  await view(popup, 'This page');
  const row = post(popup, '/comments/gal1/');
  await expect(row).toHaveAttribute('data-state', 'queued');
  await row.getByRole('button').first().click();
  await expect(popup.getByRole('tab', { name: /Downloads/ })).toHaveAttribute('aria-selected', 'true');
  await expect(popup.getByTestId('job-group').first()).toHaveClass(/flash/);
  await expect(popup.getByTestId('job-group').first()).toContainText('4 files');

  const { jobId, filename } = await finished(popup, previous);
  expect(filename).toBe('Reddit/magpietest/2026-10-28 fixture · Four noisy squares [gal1]');
  await view(popup, 'History');
  const entry = popup.locator(`[data-testid="archive-entry"][data-job-id="${jobId}"]`);
  await expect(entry).toContainText('4 files');
  await expect(entry.getByTestId('archive-title')).toHaveText('Four noisy squares');
  await expect(popup.getByTestId('job')).toHaveCount(0);
  await expect(popup.getByTestId('job-group')).toHaveCount(0);

  // The files, in slot order, are the originals.
  const want = ['g1.png', 'g2.png', 'g3.png', 'g4.png'].map(fixtureMd5);
  expect(new Set(want).size, 'fixtures differ').toBe(4);
  for (const [i, id] of ids.entries()) {
    const file = await magpie.exportJob(popup, id, `reddit-gallery-${i + 1}.png`);
    expect(md5(readFileSync(file)), `file ${i + 1}`).toBe(want[i]);
  }

  // post.json beside the files: subreddit, title, author, date, URL, and where each file came from.
  const { body } = await sidecarFor(popup, 'gal1');
  expect(body).toMatchObject({
    source: 'reddit',
    id: 'gal1',
    url: 'http://127.0.0.1:8787/r/magpietest/comments/gal1/four_noisy_squares/',
    subreddit: 'magpietest',
    author: 'fixture',
    title: 'Four noisy squares',
    created: '2026-10-28T10:00:00Z',
    type: 'gallery',
  });
  expect(body.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(body.files).toEqual([1, 2, 3, 4].map((n) => ({ name: `0${n}.png`, source: `http://127.0.0.1:8787/crawl/reddit/g${n}.png` })));

  // Saved: the post is hidden on This page and shows as downloaded when asked for.
  await view(popup, 'This page');
  await expect(row).toHaveCount(0);
  await popup.getByRole('button', { name: '1 downloaded' }).click();
  await expect(row.getByTestId('archived-badge')).toBeVisible();
});

test('gif: the original GIF, not the MP4 the player uses', async ({ magpie }) => {
  const { popup } = await openFeed(magpie);
  const previous = await newestEntry(popup);
  const [id] = await startPost(popup, '/comments/gif1/', 1);
  const { filename } = await finished(popup, previous);
  expect(filename).toBe('Reddit/magpietest/2026-10-28 fixture · A test pattern [gif1].gif');
  const file = await magpie.exportJob(popup, id!, 'reddit-gif.gif');
  expect(md5(readFileSync(file))).toBe(fixtureMd5('anim.gif'));
  // A single file gets its .json beside it, naming that one file.
  const { body } = await sidecarFor(popup, 'gif1');
  expect(body).toMatchObject({ type: 'gif', author: 'fixture', created: '2026-10-28T10:00:00Z' });
  expect(body.files).toEqual([{ name: '2026-10-28 fixture · A test pattern [gif1].gif', source: 'http://127.0.0.1:8787/media/reddit/anim.gif' }]);
});

test('video: the largest packaged MP4, audio included, in one fetch', async ({ magpie }) => {
  const { popup } = await openFeed(magpie);
  const previous = await newestEntry(popup);
  const [id] = await startPost(popup, '/comments/vid1/', 1);
  const { filename } = await finished(popup, previous);
  expect(filename).toBe('Reddit/magpietest/2026-10-28 fixture · Harbor with audio [vid1].mp4');
  const file = await magpie.exportJob(popup, id!, 'reddit-video.mp4');
  expect(md5(readFileSync(file))).toBe(fixtureMd5('m2-res_720p.mp4'));
  expectAvPair(file);
});

test('video without packaged MP4s: the HLS master at its best quality, audio merged', async ({ magpie }) => {
  const { popup } = await openFeed(magpie);
  const previous = await newestEntry(popup);
  const [id] = await startPost(popup, '/comments/hls1/', 1);
  const { filename } = await finished(popup, previous);
  expect(filename).toBe('Reddit/magpietest/2026-10-28 fixture · Night train, HLS only [hls1].mp4');
  const file = await magpie.exportJob(popup, id!, 'reddit-hls.mp4');
  expectFramesMatch(file, '720');
  expectAudioMatch(file);
});
