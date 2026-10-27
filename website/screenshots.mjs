// Captures the popup for the website from the preview harness (`pnpm preview`
// with the fake background), so the pictures on the download page are the real
// UI at the moment of release. Run after a UI change, before `pnpm release`:
//
//   pnpm site:shots
//
// Uses port 5180 so a `pnpm preview` left open does not get in the way.
// Writes website/site/shots/*.png at 2x (800 by 1160 pixels for a 400 by 580 popup).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ext = join(root, 'extension');
const out = join(here, 'site', 'shots');
mkdirSync(out, { recursive: true });

// vite comes from the extension, playwright from the e2e folder: neither is a dependency of the website.
const { createServer } = await import(pathToFileURL(createRequire(join(ext, 'package.json')).resolve('vite')).href);
const { chromium } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');

const server = await createServer({ configFile: join(ext, 'preview', 'vite.config.ts'), server: { open: false, port: 5180, strictPort: true } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
  const popup = page.locator('#root > div > div').nth(1);
  const open = async (query) => {
    await page.goto(`http://localhost:5180/${query}`);
    await popup.waitFor();
    // Every thumbnail in, like a popup that has been open a moment. DASH rows never get one.
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="candidate"]');
      return rows.length > 0 && [...rows].every((r) => r.querySelector('[data-testid="thumb"]') || r.textContent.includes('DASH'));
    });
    await page.waitForTimeout(300);
  };
  const shot = (name) => popup.screenshot({ path: join(out, `${name}.png`) });

  await open('');
  await shot('page');
  await popup.locator('[data-testid="candidate"]').first().click();
  await page.getByTestId('variant').first().waitFor();
  await page.waitForTimeout(300);
  await shot('sheet');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Downloads/ }).click();
  await page.waitForTimeout(300);
  await shot('downloads');
  await page.getByRole('tab', { name: /History/ }).click();
  await page.waitForTimeout(300);
  await shot('history');

  await open('?mode=all');
  await shot('all-tabs');
  console.log(`wrote 5 screenshots to ${out}`);
} finally {
  await browser.close();
  await server.close();
}
