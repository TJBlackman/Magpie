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

/** Container start time and duration in seconds, via ffprobe. */
export function probeTimes(file: string): { start: number; duration: number } {
  const args = ['-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'default=nw=1', wslPath(file)];
  const out =
    process.platform === 'win32'
      ? execFileSync('wsl', ['-u', 'trevor', '--', 'ffprobe', ...args], { encoding: 'utf8' })
      : execFileSync('ffprobe', args, { encoding: 'utf8' });
  const get = (k: string) => Number(new RegExp(`${k}=([0-9.]+)`).exec(out)?.[1]);
  return { start: get('start_time'), duration: get('duration') };
}

function wslPath(winPath: string): string {
  if (process.platform !== 'win32') return winPath;
  return winPath.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

function frameHashes(file: string, rendition: '720' | '480' | '360') {
  const got = ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:v', '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map(hashOnly);
  const want = readFileSync(join(refDir, `${rendition}.framemd5`), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map(hashOnly);
  return { got, want };
}

/** Decoded video frame hashes of `file` must equal the reference rendition. */
export function expectFramesMatch(file: string, rendition: '720' | '480' | '360') {
  const { got, want } = frameHashes(file, rendition);
  expect(got.length, 'frame count').toBe(want.length);
  expect(got, 'decoded frame hashes').toEqual(want);
}

/** `file` must hold the first frames of the reference, at least `min` and fewer than all. Returns the count. */
export function expectFramesPrefix(file: string, rendition: '720' | '480' | '360', min: number): number {
  const { got, want } = frameHashes(file, rendition);
  expect(got.length, 'frame count').toBeGreaterThanOrEqual(min);
  expect(got.length, 'frame count').toBeLessThan(want.length);
  expect(got, 'decoded frame hashes').toEqual(want.slice(0, got.length));
  return got.length;
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
  const previous = await newestEntry(manager);
  await buttons.nth(variantIndex).click();
  return finished(manager, previous);
}

/** The newest archive row's job id, '' when the archive is empty. */
export async function newestEntry(manager: Page): Promise<string> {
  const first = manager.getByTestId('archive-entry').first();
  return (await first.count()) ? ((await first.getAttribute('data-job-id')) ?? '') : '';
}

/**
 * Wait for the next download to finish. A finished job leaves the Downloads
 * list for the archive, so this waits for a newest archive row other than
 * `previous` (rows are newest first), or a failed job.
 */
export async function finished(manager: Page, previous = '') {
  const newest = manager.locator(`[data-testid="archive"] > [data-testid="archive-entry"]:first-child:not([data-job-id="${previous}"])`);
  const failed = manager.locator('[data-testid="job"][data-state="error"]');
  await expect(newest.or(failed.first())).toBeVisible({ timeout: 90_000 });
  if (await failed.count()) throw new Error(`job failed: ${await failed.first().textContent()}`);
  return {
    jobId: (await newest.getAttribute('data-job-id'))!,
    filename: (await newest.getAttribute('data-file'))!,
  };
}
