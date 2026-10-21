// Firefox smoke test: installs the MV2 build via geckodriver, plays the HLS TS
// and gated pages, drives the manager page to download, and checks the
// resulting file decodes to the reference frames. Playwright's Firefox build
// cannot load extensions, hence Selenium here.
//
//   node e2e/firefox-smoke.mjs            (expects the test server on :8787)
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension', 'dist', 'firefox-mv2');
const downloads = join(root, 'e2e', 'downloads');
const refDir = join(root, 'testsite', 'public', 'media', 'ref');
const UUID = '7d1c4b2e-5a6f-4e3d-9c8b-magpie000001'.replace('magpie000001', '1a2b3c4d5e6f');
const ADDON_ID = 'magpie@trevorblackman.dev';
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

async function main() {
  if (!existsSync(join(ext, 'manifest.json'))) throw new Error('build firefox first: pnpm --dir extension build:firefox');
  await ensureServer();

  const opts = new firefox.Options();
  if (!process.env.HEADED) opts.addArguments('-headless');
  // Pin the internal UUID so we can navigate to moz-extension://<uuid>/manager.html.
  opts.setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  opts.setPreference('media.autoplay.default', 0);
  opts.setPreference('media.autoplay.blocking_policy', 0);
  opts.setPreference('browser.download.folderList', 2);
  opts.setPreference('browser.download.dir', downloads);
  opts.setPreference('browser.download.useDownloadDir', true);
  opts.setPreference('browser.download.manager.showWhenStarting', false);
  opts.setPreference('xpinstall.signatures.required', false);

  // geckodriver flag that lets Marionette switch to the chrome context
  // (needed to open moz-extension:// tabs).
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  const failures = [];
  try {
    await driver.installAddon(ext, true);

    for (const [page, urlPart, out] of [
      ['/hls-ts.html', '/media/hls-ts/index.m3u8', 'firefox-hls-ts.mp4'],
      ['/gated.html', '/gated/media/index.m3u8', 'firefox-gated.mp4'],
      ['/hls-fmp4.html', '/media/hls-fmp4/master.m3u8', 'firefox-hls-fmp4.mp4'],
    ]) {
      console.log(`== ${page}`);
      await driver.switchTo().newWindow('tab');
      await driver.get(`http://127.0.0.1:8787${page}`);
      await driver.wait(async () => driver.executeScript('return window.__magpieReady === true'), 30_000, 'video never started');

      // Marionette refuses to navigate content to moz-extension:// directly;
      // open the tab from the browser chrome instead.
      await driver.setContext(firefox.Context.CHROME);
      await driver.executeScript(
        `const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         gBrowser.selectedTab = tab;`,
        `moz-extension://${UUID}/manager.html`,
      );
      await driver.setContext(firefox.Context.CONTENT);
      const handles = await driver.getAllWindowHandles();
      await driver.switchTo().window(handles[handles.length - 1]);
      const row = await driver.wait(until.elementLocated(By.css(`[data-testid="candidate"][data-url*="${urlPart}"]`)), 15_000);
      await (await row.findElement(By.css('button'))).click();
      const dl = await driver.wait(until.elementLocated(By.xpath(`//*[@data-testid="candidate" and contains(@data-url,"${urlPart}")]//button[starts-with(normalize-space(.),"Download")]`)), 15_000);
      await dl.click();
      const job = await driver.wait(until.elementLocated(By.css('[data-testid="job"]')), 10_000);
      await driver.wait(async () => /done|error/.test((await job.getAttribute('data-state')) ?? ''), 90_000, 'job never finished');
      const state = await job.getAttribute('data-state');
      const text = await job.getText();
      console.log('  job', state, text.replace(/\n/g, ' | '));
      if (state !== 'done') {
        failures.push(`${page}: ${text}`);
        continue;
      }
      const jobId = await job.getAttribute('data-job-id');
      const b64 = await driver.executeAsyncScript(
        `const [id, done] = arguments;
         (async () => {
           const root = await navigator.storage.getDirectory();
           const dir = await root.getDirectoryHandle('jobs');
           const fh = await dir.getFileHandle(id + '.bin');
           const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
           let s = '';
           for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
           done(btoa(s));
         })().catch((e) => done('ERR:' + e));`,
        jobId,
      );
      if (String(b64).startsWith('ERR:')) {
        failures.push(`${page}: OPFS read ${b64}`);
        continue;
      }
      const file = join(downloads, out);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      const got = frameHashes(file);
      const want = refHashes('720');
      const same = got.length === want.length && got.every((h, i) => h === want[i]);
      console.log(`  frames ${got.length}/${want.length} ${same ? 'MATCH' : 'MISMATCH'}`);
      if (!same) failures.push(`${page}: frame hashes differ`);
      // Remove the job so the next iteration sees a fresh first job row.
      await (await job.findElement(By.xpath('.//button[normalize-space(.)="×"]'))).click();
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
