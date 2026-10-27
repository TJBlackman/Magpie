import { download, expect, openSettings, playAndWait, test, view } from '../fixtures';

// A frame of the stream itself: one segment of the lowest rendition or DASH
// video representation (fMP4 passed through, TS remuxed) or the first megabyte
// of a plain file, decoded in the offscreen document and kept as a small JPEG.
for (const [page, part] of [
  ['/hls-fmp4.html', '/media/hls-fmp4/master.m3u8'],
  ['/dash.html', '/media/dash/manifest.mpd'],
  ['/hls-ts.html', '/media/hls-ts/index.m3u8'],
  ['/hls-aes.html', '/media/hls-aes/index.m3u8'],
  ['/progressive.html', '/media/progressive/clip.mp4'],
] as const) {
  test(`thumbnail: a frame of ${page} shows on its card`, async ({ magpie }) => {
    const p = await magpie.context.newPage();
    await playAndWait(p, page);
    const popup = await magpie.popup();
    const row = popup.locator(`[data-testid="candidate"][data-url*="${part}"]`).first();
    const img = row.getByTestId('thumb');
    await expect(img).toBeVisible({ timeout: 20_000 });
    const src = (await img.getAttribute('src')) ?? '';
    expect(src).toMatch(/^data:image\/jpeg;base64,/);
    // A few kilobytes: a flat frame would be far smaller, and a bad encode far larger.
    expect(src.length).toBeGreaterThan(1_500);
    expect(src.length).toBeLessThan(24_000);
  });
}

test('thumbnail follows the download into history, and the setting turns it off', async ({ magpie }) => {
  const page = await magpie.context.newPage();
  await playAndWait(page, '/hls-fmp4.html');
  const popup = await magpie.popup();
  const row = popup.locator('[data-testid="candidate"][data-url*="master.m3u8"]').first();
  await expect(row.getByTestId('thumb')).toBeVisible({ timeout: 20_000 });
  const src = (await row.getByTestId('thumb').getAttribute('src')) ?? '';
  await download(popup, '/media/hls-fmp4/master.m3u8');
  await view(popup, 'History');
  await expect(popup.getByTestId('archive-entry').first().getByTestId('thumb')).toHaveAttribute('src', src);

  await openSettings(popup);
  await popup.getByTestId('thumbnails').click();
  await expect(popup.getByTestId('saved')).toHaveClass(/opacity-100/);
  await popup.getByRole('button', { name: 'Back' }).click();
  await expect(popup.getByTestId('thumb')).toHaveCount(0);
});
