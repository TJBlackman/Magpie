# Magpie

A browser extension that collects streaming video from the page you are watching and saves it as one file. Chrome and Firefox from one codebase. Personal project, no store listing. Download the latest build and install steps at [magpie.trevorblackman.dev](https://magpie.trevorblackman.dev).

What works in v0.2:

| Delivery | Detect | Download | Verified by |
|---|---|---|---|
| Plain file (`<video src>` or big XHR) | yes | yes, streamed to disk | e2e |
| HLS, MPEG-TS segments | yes | yes, remuxed to MP4 in the browser | e2e (Chrome + Firefox) |
| HLS, fMP4 segments, master playlist | yes | yes, quality picker | e2e (Chrome + Firefox) |
| HLS, AES-128 | yes | yes, decrypted with WebCrypto | e2e |
| HLS, byte range single file | yes | yes, Range requests | e2e |
| Cookie and Referer gated CDNs | yes | yes | e2e (Chrome + Firefox) |
| DASH | yes | not yet (phase 2) | e2e checks the message |
| HLS with separate audio rendition | yes | video only (phase 2 merges) | fixture exists, no test |
| Live playlists | yes | listed segments only (phase 2 records) | no fixture yet |
| Hidden manifests, blob only players | no (phase 3 MSE capture) | no | fixture exists |
| DRM | no | never | none |

"Verified" means the e2e test pulls the finished file out of the extension and compares every decoded video frame hash against the ffmpeg reference rendition. 600 of 600 frames match on every passing case.

## Layout

```
extension/   WXT + React + Tailwind v4. Builds dist/chrome-mv3 and dist/firefox-mv2
  entrypoints/background.ts   sniffer (webRequest observe only) + message router
  entrypoints/offscreen/      Chrome only: hosts the engine (service workers cannot make blob URLs)
  entrypoints/popup/          media on this tab, quality picker, active jobs
  entrypoints/manager/        all tabs, all jobs
  entrypoints/options/        settings page (max concurrent downloads)
  src/core/                   HLS parser, detection rules, filenames (pure, unit tested)
  src/engine/                 fetch pool, AES, TS to MP4 remux, OPFS output, job state
  src/background/             sniffer and per browser Referer rules (DNR on Chrome, webRequest on Firefox)
testsite/    Go server + ffmpeg fixture script + player pages (hls.js, dash.js, native)
e2e/         Playwright (Chrome, loads the unpacked build) and a Selenium smoke test for Firefox
website/     magpie.trevorblackman.dev: static site/ plus wrangler config and deploy script
```

Roughly 90 percent of the code is shared. The browser specific parts are `src/background/headers.ts` and the two engine hosts (`entrypoints/background.ts` for Firefox, `entrypoints/offscreen/` for Chrome).

## Setup

Prereqs on this machine: Node 24 and pnpm on Windows, Go on Windows (for the test server), ffmpeg inside WSL (for fixtures and the frame hash check), Firefox installed for the smoke test.

```powershell
pnpm install                       # all three packages
pnpm build                         # both browser builds
pnpm fixtures                      # runs ffmpeg in WSL, writes testsite/public/media (gitignored)
pnpm server:build                  # testsite/server/magpie-testsite.exe
pnpm test:unit
pnpm test:e2e                      # Chrome, 8 tests, about 15 s
pnpm test:firefox                  # Firefox, 3 cases, about 10 s
```

To poke at the test site by hand: `pnpm server`, then open http://127.0.0.1:8787.

## Installing for daily use

Chrome: `chrome://extensions`, Developer mode, Load unpacked, pick `extension/dist/chrome-mv3`. It stays installed.

Firefox: a temporary load from `about:debugging` disappears on restart. The permanent install is the signed `.xpi` from the website, or `extension/dist/magpie-extension-<version>-firefox.xpi` after `pnpm release`. Drag it onto a Firefox window.

## Signing for Firefox

Mozilla signs the Firefox build on the unlisted channel. AMO signs it automatically in a few minutes and never publishes it.

The AMO API key is stored once per machine in Windows Credential Manager, as a generic credential named `magpie/addons.mozilla.org`. Windows encrypts it to your account. Get the JWT issuer and secret from https://addons.mozilla.org/developers/addon/api/key/, then run this in a terminal and paste them at the prompts:

```powershell
pnpm amo:key
```

It stores the key and checks it against AMO. `extension/scripts/sign-firefox.ps1 -Check` tests the stored key again, and `-Forget` deletes it. Signing passes the key to `web-ext` through environment variables of that one process, so it never lands in the repo, a file, or a command line.

AMO refuses to sign a version number twice, so every signed build needs a new version.

## Settings and the queue

Open Settings from the popup or the Downloads page. "Maximum concurrent downloads" (default 2, range 1 to 10) caps how many downloads run at once. Every extra Download click joins a first in, first out queue and starts when a running download finishes. Raising the limit starts queued downloads right away. Cancel removes a queued download without starting it.

The media list shows the page title first and the stream's host and file name underneath. Plain files show bytes of total, percent, speed and time left. HLS shows segments done, percent, speed and an estimate of time left.

## How a download works

1. The background script watches `webRequest.onHeadersReceived` (observe only) and keeps a per tab list of candidates: `.m3u8` or `application/vnd.apple.mpegurl` is HLS, `.mpd` is DASH, a `media` typed request or a large `video/*` XHR is a plain file. Segments (`video/mp2t`, `seg001.m4s`) are ignored on purpose.
2. The popup asks the engine to inspect a candidate. For a master playlist it returns the variants sorted by bandwidth.
3. The engine fetches segments 4 at a time, never more than 12 ahead of the writer, decrypts AES-128 if present, and appends them in order to a file in OPFS. TS segments go through mux.js and come out as fragmented MP4. fMP4 segments are written as is after the init segment.
4. Before fetching, the engine asks the background to set a Referer and Origin rule for the CDN host (declarativeNetRequest session rule on Chrome scoped to the extension's own requests, blocking `onBeforeSendHeaders` on Firefox). Cookies go along because fetches use `credentials: include` and the extension has host permission.
5. The finished OPFS file becomes a blob URL and goes to `downloads.download`. The OPFS copy is deleted five minutes later.

Chrome's service worker can be killed any time, so the engine lives in an offscreen document, which Chrome keeps alive. Firefox builds as MV2 with a persistent background page for the same reason, and because MV2 grants host permissions at install instead of asking per site.

## Test fixtures

`testsite/fixtures/gen.sh` renders a 20 second `testsrc2` clip with the frame number burned in and a beep every second, at 720p, 480p and 360p, then packages it nine ways. `ref/*.framemd5` holds the decoded frame hashes the e2e tests compare against.

## Roadmap

Phase 2: DASH download, merge separate audio renditions (needs an MP4 track muxer, mp4box.js), live recording, pause and resume, filename templates.

Phase 3: MSE capture content script for players that hide the manifest, DRM detection that explains itself, optional Go native host that hands the job to system ffmpeg for huge files.

## Known limits

- Only the first audio track is kept when video and audio are in the same segments; separate audio renditions are not merged yet.
- A live playlist saves only the segments listed at the moment you click.
- `web-ext lint` warns about `innerHTML` in React's bundle and nothing else.
- Firefox refuses OPFS when it runs in "Always use private browsing mode". Magpie then holds the download in memory until it saves, so RAM use equals the file size. `pnpm test:firefox:private` covers this mode.
- Filenames come from the page at the moment you click Download: JSON-LD video name, then `og:title`, `twitter:title`, `<title>`, `<h1>`, with a trailing or leading site name removed. If the tab has moved to another page, the title seen when the stream was detected is used instead.
- Firefox is tested through Selenium, not Playwright, because Playwright's Firefox build cannot load extensions.

## Website

`website/` is https://magpie.trevorblackman.dev, a Cloudflare Worker serving static assets from `website/site` on a custom domain. `website/site/_headers` sets `Cache-Control: no-transform` so Cloudflare cannot inject its analytics beacon, and the font and browser logos are self hosted, so the page makes no third party requests.

To ship a new version:

```powershell
pnpm release                  # 0.2.1 -> 0.2.2
pnpm release -Bump minor      # 0.2.1 -> 0.3.0
pnpm release -Version 0.2.2   # exact version
```

`scripts/release.ps1` runs typecheck and unit tests, bumps `extension/package.json`, builds both zips, has Mozilla sign the Firefox build (`pnpm sign:firefox`), and runs `website/deploy.ps1`. The deploy script copies the Chrome zip and signed xpi into `website/site`, rewrites the download links and version label in `index.html`, deletes files from older versions, runs `wrangler deploy`, and warns if the xpi is not served as `application/x-xpinstall`. Commit `extension/package.json` and `index.html` afterwards. The zips and xpi themselves are gitignored.
