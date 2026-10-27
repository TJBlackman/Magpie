import { expect, playAndWait, start, test, view } from '../fixtures';

// Progress events fire several times a second while a download runs. They carry
// no thumbnails: the popup keeps the frame that came with a list answer, and asks
// once, by id, for a row it has never seen. The crawl page downloads at about
// 200 KB/s, so the job is still running while all of this is checked.
test('progress events carry no thumbnails, and the download row still shows one', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/crawl.html');
  const popup = await magpie.popup();
  const card = popup.locator('[data-testid="candidate"][data-url*="/crawl/progressive/clip.mp4"]').first();
  const img = card.getByTestId('thumb');
  await expect(img).toBeVisible({ timeout: 20_000 });
  const src = (await img.getAttribute('src')) ?? '';

  // Watch for a progress event from inside the popup page, before the download starts.
  const seen = popup.evaluate(
    () =>
      new Promise<{ count: number; withThumb: number }>((resolve) => {
        chrome.runtime.onMessage.addListener((m: { magpie?: string; event?: { type: string; jobs?: Record<string, unknown>[] } }) => {
          const jobs = m?.magpie === 'ui' && m.event?.type === 'jobs' ? m.event.jobs : undefined;
          if (jobs?.some((j) => j.state === 'downloading' && (j.bytes as number) > 0)) resolve({ count: jobs.length, withThumb: jobs.filter((j) => 'thumb' in j).length });
        });
      }),
  );
  await start(popup, '/crawl/progressive/clip.mp4');
  expect(await seen).toEqual({ count: 1, withThumb: 0 });

  // This popup only ever heard of the job through events, so its frame came from a thumbs request.
  await view(popup, 'Downloads');
  const job = popup.locator('[data-testid="job"]').first();
  await expect(job.getByTestId('thumb')).toHaveAttribute('src', src, { timeout: 10_000 });
  // A popup opened later gets the frame with its first list answer.
  const other = await magpie.popup();
  await view(other, 'Downloads');
  await expect(other.locator('[data-testid="job"]').first().getByTestId('thumb')).toHaveAttribute('src', src, { timeout: 10_000 });

  await job.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup.locator('[data-testid="job"]')).toHaveCount(0);
});
