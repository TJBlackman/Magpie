import type { Worker } from '@playwright/test';
import { expect, openSettings, test } from '../fixtures';

/** storage.local as the background sees it. */
const stored = (worker: Worker, key: string) => worker.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const store = (worker: Worker, items: Record<string, unknown>) => worker.evaluate((i) => chrome.storage.local.set(i), items);

test('a newer version on the website shows a line until it is closed', async ({ magpie }) => {
  // The background reads the real site once on start; let that finish so it cannot overwrite what the test stores.
  await expect.poll(() => stored(magpie.worker, 'update'), { timeout: 30_000 }).toBeTruthy();
  let served = '99.0.0';
  let requests = 0;
  await magpie.context.route('https://magpie.trevorblackman.dev/version.json', (route) => {
    requests++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: served }) });
  });
  await store(magpie.worker, { update: { checkedAt: 0, ok: false, latest: null } });

  // Opening the popup asks for a check, which is due.
  const popup = await magpie.popup();
  const banner = popup.getByTestId('update');
  await expect(banner).toContainText('Magpie 99.0.0 is out', { timeout: 15_000 });
  expect(requests).toBe(1);
  expect(await stored(magpie.worker, 'update')).toMatchObject({ ok: true, latest: '99.0.0' });

  // A second popup within 12 hours reads the stored answer and asks nothing.
  const again = await magpie.popup();
  await expect(again.getByTestId('update')).toBeVisible();
  await again.close();
  expect(requests).toBe(1);

  await openSettings(popup);
  await expect(popup.getByTestId('update-link')).toHaveText('99.0.0 available');
  await popup.getByRole('button', { name: 'Back' }).click();

  await banner.getByRole('button', { name: 'Hide until the next version' }).click();
  await expect(banner).toHaveCount(0);
  expect(await stored(magpie.worker, 'updateDismissed')).toBe('99.0.0');
  await popup.reload();
  await expect(popup.getByRole('tab', { name: 'This page' })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // The next release brings it back.
  served = '99.1.0';
  await store(magpie.worker, { update: { checkedAt: 0, ok: true, latest: '99.0.0' } });
  await popup.reload();
  await expect(banner).toContainText('Magpie 99.1.0 is out', { timeout: 15_000 });
  expect(requests).toBe(2);

  // Off hides the line and makes no request, even when a check is overdue.
  await openSettings(popup);
  await popup.getByTestId('update-check').click();
  await expect(popup.getByTestId('update-link')).toHaveCount(0);
  await popup.getByRole('button', { name: 'Back' }).click();
  await expect(banner).toHaveCount(0);
  await store(magpie.worker, { update: { checkedAt: 0, ok: true, latest: '99.1.0' } });
  await popup.reload();
  await expect(popup.getByRole('tab', { name: 'This page' })).toBeVisible();
  await popup.waitForTimeout(1000);
  expect(requests).toBe(2);
  expect(await stored(magpie.worker, 'update')).toMatchObject({ checkedAt: 0 });
});

test('the installed version or an older one on the website shows nothing', async ({ magpie }) => {
  const installed = await magpie.worker.evaluate(() => chrome.runtime.getManifest().version);
  await expect.poll(() => stored(magpie.worker, 'update'), { timeout: 30_000 }).toBeTruthy();
  await store(magpie.worker, { update: { checkedAt: Date.now(), ok: true, latest: installed } });
  const popup = await magpie.popup();
  await expect(popup.getByRole('tab', { name: 'This page' })).toBeVisible();
  await popup.waitForTimeout(500);
  await expect(popup.getByTestId('update')).toHaveCount(0);
});
