// Firefox smoke test: installs the MV2 build via geckodriver, plays the live,
// HLS TS, gated, fMP4 master and separate audio (fMP4 and MPEG-TS) pages,
// drives the popup (opened as a page) to download, and checks the resulting
// file decodes to the reference frames; the separate audio cases also check the
// audio packets and that Firefox itself plays the merged file. Playwright's
// Firefox build cannot load extensions, hence Selenium here.
//
//   node e2e/firefox-smoke.mjs            (expects the test server on :8787)
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension', 'dist', 'firefox-mv2');
// PRIVATE=1 runs Firefox with "Always use private browsing mode", where OPFS is refused.
const PRIVATE = !!process.env.PRIVATE || process.argv.includes('--private');
const downloads = join(root, 'e2e', 'downloads', PRIVATE ? 'firefox-private' : 'firefox');
const refDir = join(root, 'testsite', 'public', 'media', 'ref');
const UUID = '7d1c4b2e-5a6f-4e3d-9c8b-magpie000001'.replace('magpie000001', '1a2b3c4d5e6f');
const ADDON_ID = 'magpie@trevorblackman.dev';
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

let server = null;
async function ensureServer() {
  try {
    if ((await fetch('http://127.0.0.1:8787/')).ok) return;
  } catch {
    /* start one */
  }
  const exe = join(root, 'testsite', 'server', process.platform === 'win32' ? 'magpie-testsite.exe' : 'magpie-testsite');
  server = spawn(exe, ['-root', join(root, 'testsite')], { stdio: 'ignore', env: { ...process.env, MAGPIE_QUIET: '1' } });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8787/')).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('test server did not start');
}

function wslPath(p) {
  return process.platform === 'win32' ? p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/') : p;
}
function frameHashes(file) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:v', '-f', 'framemd5', '-'];
  const out = process.platform === 'win32' ? execFileSync('wsl', ['-u', 'trevor', '--', 'ffmpeg', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }) : execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/,\s*/).slice(-2).join(','));
}
function refHashes(name) {
  return readFileSync(join(refDir, `${name}.framemd5`), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/,\s*/).slice(-2).join(','));
}
/**
 * Encoded audio packet hashes, the sixth framemd5 field, like expectAudioMatch
 * in fixtures.ts. Not the last field: the first AAC packet of an MP4 with an
 * edit list carries skip samples side data, which framemd5 appends.
 */
function audioPackets(file) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:a', '-c', 'copy', '-f', 'framemd5', '-'];
  const out = process.platform === 'win32' ? execFileSync('wsl', ['-u', 'trevor', '--', 'ffmpeg', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }) : execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split(',')[5].trim());
}
function refPackets() {
  return readFileSync(join(refDir, 'audio.packets'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

async function main() {
  if (!existsSync(join(ext, 'manifest.json'))) throw new Error('build firefox first: pnpm --dir extension build:firefox');
  await ensureServer();

  const opts = new firefox.Options();
  if (!process.env.HEADED) opts.addArguments('-headless');
  // Pin the internal UUID so we can navigate to moz-extension://<uuid>/popup.html.
  opts.setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  opts.setPreference('media.autoplay.default', 0);
  opts.setPreference('media.autoplay.blocking_policy', 0);
  opts.setPreference('browser.download.folderList', 2);
  opts.setPreference('browser.download.dir', downloads);
  opts.setPreference('browser.download.useDownloadDir', true);
  opts.setPreference('browser.download.manager.showWhenStarting', false);
  opts.setPreference('xpinstall.signatures.required', false);
  if (PRIVATE) opts.setPreference('browser.privatebrowsing.autostart', true);

  // geckodriver flag that lets Marionette switch to the chrome context
  // (needed to open moz-extension:// tabs).
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  const failures = [];

  /** Same as ticking "Run in Private Windows" on the add-on page. Reloads the add-on. */
  async function allowPrivateBrowsing() {
    await driver.setContext(firefox.Context.CHROME);
    const r = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        await ExtensionPermissions.add('${ADDON_ID}', { permissions: ['internal:privateBrowsingAllowed'], origins: [] });
        await (await AddonManager.getAddonByID('${ADDON_ID}')).reload();
        done('ok');
      })().catch((e) => done(String(e)));
    `);
    if (r !== 'ok') throw new Error('could not allow private browsing: ' + r);
    await driver.setContext(firefox.Context.CONTENT);
    await new Promise((r) => setTimeout(r, 1500));
  }

  /** Marionette refuses to navigate content to moz-extension:// directly; open the tab from the browser chrome instead. */
  async function openPopup() {
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript(
      `const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       gBrowser.selectedTab = tab;`,
      `moz-extension://${UUID}/popup.html`,
    );
    await driver.setContext(firefox.Context.CONTENT);
    for (const handle of (await driver.getAllWindowHandles()).reverse()) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()).startsWith(`moz-extension://${UUID}/popup.html`)) return;
    }
    throw new Error('popup tab not found');
  }

  /** The quality sheet is open: pick the top rendition and start it. */
  async function startFromSheet() {
    const variant = await driver.wait(until.elementLocated(By.css('[data-testid="sheet"] [data-testid="variant"]')), 15_000);
    await variant.click();
    await (await driver.findElement(By.css('[data-testid="sheet"] [data-testid="start"]'))).click();
    await driver.wait(async () => (await driver.findElements(By.css('[data-testid="sheet"]'))).length === 0, 10_000, 'sheet never closed');
  }

  /** History entries in storage.local and storage.session, as seen from an extension page. */
  async function archiveStorage() {
    return JSON.parse(
      await driver.executeAsyncScript(
        `const done = arguments[0];
         Promise.all([browser.storage.local.get('archive'), browser.storage.session.get('archive')])
           .then(([l, s]) => done(JSON.stringify({ local: (l.archive ?? []).length, session: (s.archive ?? []).length })))
           .catch((e) => done(JSON.stringify({ error: String(e) })));`,
      ),
    );
  }

  /**
   * Play a saved file in a tab of its own at 4x and report how it went: the
   * first Firefox check that a merged two track file decodes in Firefox itself,
   * not only in ffmpeg. Returns to the popup tab afterwards.
   */
  async function playSaved(file) {
    const popup = await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    try {
      await driver.get(pathToFileURL(file).href);
      await driver.manage().setTimeouts({ script: 40_000 });
      return JSON.parse(
        await driver.executeAsyncScript(`
          const done = arguments[0];
          const v = document.querySelector('video');
          if (!v) return done(JSON.stringify({ error: 'no video element' }));
          const report = (extra) =>
            done(JSON.stringify({ ended: v.ended, error: v.error && (v.error.message || v.error.code), hasAudio: v.mozHasAudio, duration: v.duration, frames: v.getVideoPlaybackQuality().totalVideoFrames, at: v.currentTime, ...extra }));
          v.muted = true;
          v.addEventListener('ended', () => report({}));
          v.addEventListener('error', () => report({}));
          setTimeout(() => report({ timeout: true }), 30000);
          v.playbackRate = 4;
          v.play().catch((e) => report({ playError: String(e) }));
        `),
      );
    } catch (e) {
      return { error: String(e) };
    } finally {
      await driver.close();
      await driver.switchTo().window(popup);
    }
  }

  try {
    await driver.installAddon(ext, true);
    if (PRIVATE) await allowPrivateBrowsing();

    /** Job ids of archive rows already seen, so each case waits for its own. */
    const seen = new Set();
    for (const [page, urlPart, expectName, merged] of [
      // Live first, while it is the only master playlist in the popup's all tabs list.
      ['/live.html', '/master.m3u8', /^Harbor Webcam \[720p\] \d{4}-\d\d-\d\d \d\d\.\d\d\.mp4$/],
      ['/hls-ts.html', '/media/hls-ts/index.m3u8', 'Harbor at Dusk.mp4'],
      ['/gated.html', '/gated/media/index.m3u8', 'Gated HLS.mp4'],
      ['/hls-fmp4.html', '/media/hls-fmp4/master.m3u8', 'Night Train, multi rendition [720p].mp4'],
      // Video and a separate audio rendition merged into one file: packets checked too, and Firefox plays it.
      ['/hls-altaudio.html', '/media/hls-altaudio/master.m3u8', 'HLS separate audio [720p].mp4', true],
      // The same with both renditions in MPEG-TS, each through mux.js on its own before the merge.
      ['/hls-altaudio-ts.html', '/media/hls-altaudio-ts/master.m3u8', 'HLS separate audio TS [720p].mp4', true],
    ]) {
      console.log(`== ${page}`);
      await driver.switchTo().newWindow('tab');
      await driver.get(`http://127.0.0.1:8787${page}`);
      await driver.wait(async () => driver.executeScript('return window.__magpieReady === true'), 30_000, 'video never started');

      await openPopup();
      const row = await driver.wait(until.elementLocated(By.css(`[data-testid="candidate"][data-url*="${urlPart}"]`)), 15_000);
      // A frame of the stream, decoded in the background page, shows on the card.
      const thumb = await driver.wait(until.elementLocated(By.css(`[data-testid="candidate"][data-url*="${urlPart}"] [data-testid="thumb"]`)), 8_000).catch(() => null);
      const thumbSrc = thumb ? await thumb.getAttribute('src') : '';
      console.log('  thumbnail', thumbSrc ? `${thumbSrc.length} chars` : 'MISSING');
      if (!thumbSrc.startsWith('data:image/jpeg')) failures.push(`${page}: no thumbnail`);
      await (await row.findElement(By.css('button'))).click();
      await startFromSheet();
      // A finished job leaves the Downloads list and becomes the newest history row. Hidden tabs stay in the DOM.
      const result = await driver.wait(
        async () => {
          const failed = await driver.findElements(By.css('[data-testid="job"][data-state="error"]'));
          if (failed.length) return { failed: failed[0] };
          const [entry] = await driver.findElements(By.css('[data-testid="archive"] > [data-testid="archive-entry"]:first-child'));
          return entry && !seen.has(await entry.getAttribute('data-job-id')) ? { entry } : null;
        },
        90_000,
        'job never finished',
      );
      if (result.failed) {
        const text = await result.failed.getAttribute('textContent');
        console.log('  job error', text.replace(/\n/g, ' | '));
        failures.push(`${page}: ${text}`);
        continue;
      }
      seen.add(await result.entry.getAttribute('data-job-id'));
      console.log('  archived', (await result.entry.getAttribute('textContent')).replace(/\n/g, ' | '));
      const filename = await result.entry.getAttribute('data-file');
      console.log('  filename', filename);
      if (expectName instanceof RegExp ? !expectName.test(filename) : filename !== expectName) failures.push(`${page}: filename ${filename}, expected ${expectName}`);
      // Read back what Firefox actually saved, once its own download record says complete.
      const saved = await driver.wait(async () => {
        const json = await driver.executeAsyncScript(
          `const [name, done] = arguments;
           browser.downloads.search({ state: 'complete' })
             .then((r) => done(JSON.stringify(r.filter((d) => d.filename.includes(name.slice(0, -4))).map((d) => d.filename))))
             .catch(() => done('[]'));`,
          filename,
        );
        const [path] = JSON.parse(json);
        return path && existsSync(path) && statSync(path).size > 0 ? path : null;
      }, 30_000, `${filename} never completed`).catch(() => null);
      if (!saved) {
        failures.push(`${page}: ${filename} not saved (found: ${readdirSync(downloads).join(', ')})`);
        continue;
      }
      if (!saved.endsWith(filename)) failures.push(`${page}: saved as ${saved}, expected ${filename}`);
      const file = saved;
      const got = frameHashes(file);
      const want = refHashes('720');
      const same = got.length === want.length && got.every((h, i) => h === want[i]);
      console.log(`  frames ${got.length}/${want.length} ${same ? 'MATCH' : 'MISMATCH'}`);
      if (!same) failures.push(`${page}: frame hashes differ`);
      if (merged) {
        const packets = audioPackets(file);
        const wantPackets = refPackets();
        const sameAudio = packets.length === wantPackets.length && packets.every((h, i) => h === wantPackets[i]);
        console.log(`  audio packets ${packets.length}/${wantPackets.length} ${sameAudio ? 'MATCH' : 'MISMATCH'}`);
        if (!sameAudio) failures.push(`${page}: audio packet hashes differ`);
        const play = await playSaved(file);
        console.log('  firefox playback', JSON.stringify(play));
        if (!play.ended || play.error || !play.hasAudio) failures.push(`${page}: Firefox did not play the merged file through: ${JSON.stringify(play)}`);
      }
    }

    // Downloads from private windows stay out of storage.local unless the user keeps them.
    const stored = await archiveStorage();
    console.log('== archive storage', JSON.stringify(stored));
    const want = PRIVATE ? { local: 0, session: seen.size } : { local: seen.size, session: 0 };
    if (stored.local !== want.local || stored.session !== want.session) failures.push(`archive storage ${JSON.stringify(stored)}, expected ${JSON.stringify(want)}`);

    if (!PRIVATE) {
      // A download from a private window next to normal ones is forgotten when that window closes.
      console.log('== private window entry goes with the window');
      await allowPrivateBrowsing();
      await driver.setContext(firefox.Context.CHROME);
      await driver.executeScript('OpenBrowserWindow({ private: true });');
      // Load the page once the new window has its tab strip.
      await driver.wait(
        async () =>
          driver.executeScript(
            `const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
             const w = [...Services.wm.getEnumerator('navigator:browser')].find((w) => PrivateBrowsingUtils.isWindowPrivate(w) && w.document.readyState === 'complete' && w.gBrowser);
             if (!w) return false;
             w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
             return true;`,
            'http://127.0.0.1:8787/hls-aes.html',
          ),
        10_000,
        'private window never opened',
      );
      await driver.setContext(firefox.Context.CONTENT);
      await openPopup();
      const row = await driver.wait(until.elementLocated(By.css('[data-testid="candidate"][data-url*="/media/hls-aes/index.m3u8"]')), 20_000);
      await (await row.findElement(By.css('button'))).click();
      await startFromSheet();
      const entry = await driver.wait(
        async () => {
          const [first] = await driver.findElements(By.css('[data-testid="archive"] > [data-testid="archive-entry"]:first-child'));
          return first && !seen.has(await first.getAttribute('data-job-id')) ? first : null;
        },
        60_000,
        'private download never finished',
      );
      const privId = await entry.getAttribute('data-job-id');
      const during = await archiveStorage();
      console.log('  while open', JSON.stringify(during));
      if (during.local !== seen.size || during.session !== 1) failures.push(`private window open: storage ${JSON.stringify(during)}, expected local ${seen.size}, session 1`);

      await driver.setContext(firefox.Context.CHROME);
      await driver.executeScript(
        `const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
         for (const w of Services.wm.getEnumerator('navigator:browser')) if (PrivateBrowsingUtils.isWindowPrivate(w)) w.close();`,
      );
      await driver.setContext(firefox.Context.CONTENT);
      const gone = await driver
        .wait(async () => (await driver.findElements(By.css(`[data-testid="archive-entry"][data-job-id="${privId}"]`))).length === 0, 10_000)
        .then(() => true, () => false);
      const after = await archiveStorage();
      console.log('  after close', JSON.stringify(after), gone ? 'row gone' : 'ROW STILL LISTED');
      if (!gone || after.local !== seen.size || after.session !== 0) failures.push(`private window closed: row gone ${gone}, storage ${JSON.stringify(after)}`);
    }
  } finally {
    await driver.quit();
    if (server) server.kill();
  }
  if (failures.length) {
    console.error('FAILURES:\n' + failures.join('\n'));
    process.exit(1);
  }
  console.log('firefox smoke: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
