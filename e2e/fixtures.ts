import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadsDir, extensionDir, refDir } from './paths';

export interface Magpie {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  /** Open the extension's manager page. */
  manager(): Promise<Page>;
  /** Pull a finished job's file out of OPFS and write it to e2e/downloads. */
  exportJob(page: Page, jobId: string, name: string): Promise<string>;
}

export const test = base.extend<{ magpie: Magpie }>({
  magpie: async ({}, use, testInfo) => {
    const userDataDir = join(downloadsDir, '..', 'user-data', `${testInfo.workerIndex}-${Date.now()}`);
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.HEADED ? false : true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--autoplay-policy=no-user-gesture-required'],
      acceptDownloads: true,
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    const magpie: Magpie = {
      context,
      extensionId,
      worker,
      async manager() {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/manager.html`);
        return page;
      },
      async exportJob(page, jobId, name) {
        const b64 = await page.evaluate(async (id) => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('jobs');
          const fh = await dir.getFileHandle(`${id}.bin`);
          const file = await fh.getFile();
          const buf = new Uint8Array(await file.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
          return btoa(s);
        }, jobId);
        const out = join(downloadsDir, name);
        writeFileSync(out, Buffer.from(b64, 'base64'));
        return out;
      },
    };
    await use(magpie);
    await context.close();
  },
});

export const expect = test.expect;

/** Run ffmpeg inside WSL (Windows host has no ffmpeg on PATH). */
function ffmpeg(args: string[]): string {
  if (process.platform === 'win32') {
    return execFileSync('wsl', ['-u', 'trevor', '--', 'ffmpeg', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  return execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function wslPath(winPath: string): string {
  if (process.platform !== 'win32') return winPath;
  return winPath.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

/** Decoded video frame hashes of `file` must equal the reference rendition. */
export function expectFramesMatch(file: string, rendition: '720' | '480' | '360') {
  const got = ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:v', '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map(hashOnly);
  const want = readFileSync(join(refDir, `${rendition}.framemd5`), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map(hashOnly);
  expect(got.length, 'frame count').toBe(want.length);
  expect(got, 'decoded frame hashes').toEqual(want);
}

function hashOnly(line: string): string {
  // framemd5 lines: stream, dts, pts, duration, size, hash. Timestamps may
  // shift after a remux, so compare size + hash only.
  const parts = line.split(/,\s*/);
  return parts.slice(-2).join(',');
}

export async function playAndWait(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __magpieReady?: boolean }).__magpieReady === true, null, { timeout: 30_000 });
}

/** Click a candidate row by URL substring, then the Nth variant's Download button. */
export async function download(manager: Page, urlPart: string, variantIndex = 0) {
  const row = manager.locator(`[data-testid="candidate"][data-url*="${urlPart}"]`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button').first().click();
  const buttons = row.getByRole('button', { name: /^Download/ });
  await expect(buttons.first()).toBeVisible({ timeout: 15_000 });
  await buttons.nth(variantIndex).click();
  const job = manager.locator('[data-testid="job"]').first();
  await expect(job).toHaveAttribute('data-state', /done|error/, { timeout: 90_000 });
  const state = await job.getAttribute('data-state');
  const errorEl = job.locator('.text-red-300');
  const error = (await errorEl.count()) ? await errorEl.first().textContent() : '';
  expect(state, `job failed: ${error}`).toBe('done');
  return {
    jobId: (await job.getAttribute('data-job-id'))!,
    filename: (await job.getAttribute('data-filename'))!,
  };
}
