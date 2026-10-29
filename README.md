# Magpie

A browser extension that collects streaming video from the page you are watching and saves it as one file. Chrome and Firefox from one codebase. Personal project, no store listing. Download the latest build and install steps at [magpie.trevorblackman.dev](https://magpie.trevorblackman.dev).

What works in v0.5:

| Delivery | Detect | Download | Verified by |
|---|---|---|---|
| Plain file (`<video src>` or big XHR) | yes | yes, streamed to disk | e2e |
| HLS, MPEG-TS segments | yes | yes, remuxed to MP4 in the browser | e2e (Chrome + Firefox) |
| HLS, fMP4 segments, master playlist | yes | yes, quality picker | e2e (Chrome + Firefox) |
| HLS, AES-128 | yes | yes, decrypted with WebCrypto | e2e |
| HLS, byte range single file | yes | yes, Range requests | e2e |
| Cookie and Referer gated CDNs | yes | yes | e2e (Chrome + Firefox) |
| HLS with a separate audio rendition, fMP4 or MPEG-TS | yes | yes, video and audio merged into one MP4 | e2e (Chrome + Firefox) |
| DASH, static (SegmentTemplate, SegmentTimeline, SegmentBase) | yes | yes, quality picker, audio merged | e2e |
| DASH, SegmentList | yes | yes | unit tests, no fixture |
| Live HLS (webcams, live events) | yes, one row per stream | yes, records until Stop or the stream ends | e2e (Chrome + Firefox) |
| Live DASH (dynamic MPD, `$Number$` or `SegmentTimeline`) | yes | yes, records until Stop or the stream ends | e2e |
| Hidden manifests, blob only players | no (phase 3 MSE capture) | no | fixture exists |
| DRM | no | never | none |

"Verified" means the e2e test pulls the finished file out of the extension and compares every decoded video frame hash against the ffmpeg reference rendition. 600 of 600 frames match on every passing case. Where audio is merged from a separate track, the test also compares every encoded AAC packet against the source (939 of 939) and checks that the two tracks start within 50 ms of each other.

## Layout

```
extension/   WXT + React + Tailwind v4. Builds dist/chrome-mv3 and dist/firefox-mv2
  entrypoints/background.ts   sniffer (webRequest observe only) + message router
  entrypoints/offscreen/      Chrome only: hosts the engine (service workers cannot make blob URLs)
  entrypoints/popup/          the whole UI: This page, Downloads and History tabs, quality sheet, settings panel
  src/core/                   HLS and DASH parsers, sidx index, detection rules, filenames, history matching (pure, unit tested)
  src/engine/                 fetch pool, AES, TS to MP4 remux, two track merge, OPFS output, job state, MP4 duration
  src/background/             sniffer, history store, per browser Referer rules (DNR on Chrome, webRequest on Firefox)
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
pnpm test:e2e                      # Chrome, 37 tests, about 3 minutes
pnpm test:firefox                  # Firefox, 6 cases (one live, two merged audio), about 45 s
pnpm --dir extension merge:check   # merges the fixture pairs with the real muxer and checks them with ffmpeg, no browser
```

To poke at the test site by hand: `pnpm server`, then open http://127.0.0.1:8787.

## Previewing the popup

```powershell
pnpm preview
```

Opens http://localhost:5179 with the real popup rendered against a fake background (`extension/preview/fake-browser.ts` stands in for `wxt/browser`): nature videos on a page, downloads that progress and queue, a live cam, history and settings. Edits under `extension/src/ui` and `extension/entrypoints/popup` hot reload. The bar above the popup switches between the toolbar popup view and the opened as a page view, and between scenarios (default, empty, busy). Nothing in `extension/preview` ships in the extension.

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

## The popup

Everything lives in the popup: three tabs (This page, Downloads, History) and a settings panel behind the gear. A card on This page opens a sheet that lists the stream's renditions; pick one and press Download, or Start recording for a live stream. The Downloads tab shows running and queued jobs, and any that failed. A download that finishes leaves the tab the moment it is saved; a cancelled one leaves at once. Opened as a page of its own (`popup.html` in a tab), This page lists media from every open tab grouped by page, and `popup.html?tab=<id>` shows one tab the way the toolbar popup would. The e2e tests drive both.

## Thumbnails

Every row shows a frame of its stream. The frame comes from the stream itself, not the page: the engine fetches one segment of the lowest quality rendition (or the first megabyte of a plain file), decrypts and remuxes it the way a download would, decodes it in a hidden video element in the engine's own document, and keeps one frame as a 128 by 72 JPEG of a few kilobytes. Capture runs for the streams a popup is showing, one at a time, at most once per stream, and only while "Show thumbnails" in Settings is on. Nothing is fetched when the popup is closed or the setting is off. The frame travels with the item: the download row and the history entry show the same picture, and history stores it. It travels once, though: list answers carry thumbnails, change events (job progress several times a second, history changes) do not, and the popup asks `thumbs` by id for a row it has not seen. The popup also subscribes to events once instead of per render, memoizes the card and history rows, and derives the download speed during render, so a progress event costs one render of the rows that changed. For DASH the sample is the init and first segment of the lowest video representation; for a live stream it is the second newest segment, one that is surely complete. DRM, MP4 files with their index at the end, and streams whose sample does not decode keep the kind icon.

## Settings and the queue

Open Settings from the gear in the popup. "Parallel downloads" (default 2, range 1 to 10) caps how many downloads run at once. Every extra Download click joins a first in, first out queue and starts when a running download finishes. Raising the limit starts queued downloads right away. Cancel removes a queued download without starting it.

The media list shows the page title first and the stream's host and file name underneath. Plain files show bytes of total, percent, speed and time left. HLS and DASH show segments done, percent, speed and an estimate of time left; when audio comes from a separate track, the count is the video segments and the audio rides along.

## Separate audio tracks

Many HLS masters put audio in its own rendition (`EXT-X-MEDIA:TYPE=AUDIO` with a URI), and DASH always keeps video and audio in separate adaptation sets. Magpie merges the two into one MP4 as it downloads, without a muxer library and without holding the file in memory:

- Both init segments are joined into one `moov`: the audio track is renumbered past the video tracks, its durations are rescaled to the movie timescale, and `mvex` gets both `trex` entries. Edit lists are kept, so the 21 ms AAC lead that encoders write stays where it was.
- Fragments are then written in playlist order, video and audio interleaved by their start time, each `moof` and `mdat` pair copied as is with its track id, `mfhd` sequence number and (if the packager used one) `base_data_offset` rewritten. MPEG-TS renditions go through mux.js first, one track per side, keeping the original timestamps so the two sides stay aligned.
- Both tracks shift by the same number of seconds so the file starts at 0, the same way live fMP4 recordings already did.

Which audio: the rendition marked `DEFAULT=YES`, else the first `AUTOSELECT=YES`, else the first in the variant's group. If that one has no URI, the audio is already in the video segments and nothing is merged. For DASH the audio adaptation set with `Role` main comes first, then AAC over Dolby codecs that Chrome cannot decode, then the highest bandwidth. Other languages are not selectable yet; the sheet says which one you get. The download is video only, and the sheet says why, when the pair cannot be merged: a stream with `EXT-X-DISCONTINUITY` (server side ad insertion resets the clock), a second init segment partway through, or an audio playlist the CDN refuses.

`pnpm --dir extension merge:check` runs the merge on the fixture pairs outside the browser and checks the result with ffmpeg: one video and one audio stream, 600 of 600 frames, 939 of 939 audio packets, and start times within 50 ms.

## DASH

An `.mpd` row inspects like a master playlist: one variant per video representation, sorted by bandwidth, with the chosen audio shown on the label. Supported: static MPDs with `SegmentTemplate` (`$Number$` and `$Time$`, `SegmentTimeline`, per attribute inheritance from the Period, AdaptationSet and Representation), `SegmentList`, `SegmentBase` (one file per representation; the `sidx` index is read with a Range request at inspect time and segments become byte ranges), `BaseURL` at every level, multiple Periods (the longest one is downloaded, since the first is usually a preroll), and dynamic MPDs for live recording. A representation with `ContentProtection`, an `EssentialProperty` nobody understands, no init segment, or WebM is left out with a note; the MPD is refused when no video is left, or when every audio track is protected. The files a SegmentBase player fetches with Range requests fold under the MPD row.

Live DASH: the recorder syncs its clock to the MPD's `UTCTiming` when there is one (`direct`, `http-xsdate`, `http-iso` or `http-head`), reloads the MPD every `minimumUpdatePeriod` (held between 1 and 10 seconds), starts up to 30 seconds back from the live edge, and appends segments by their time in the Period as they become available, so a `SegmentTimeline` whose numbering never advances works the same as `$Number$`. Live `SegmentBase` and live MPEG-TS are refused. A segment the clock says is due but the server does not have yet is retried on the next reload; a segment that is gone leaves a gap and a note. The recording ends on Stop, when the MPD turns static, when the Period changes, or after six failed reloads, and saves what it has.

## History

A finished download leaves the Downloads list and goes to History, the popup's third tab. In the code and in storage it is still called the archive. Each entry holds the page title, the saved file name (on hover), the date, the length and the page URL, a few hundred bytes in all. The URL opens the page in a new tab, so you can check it is the video you think it is. The length comes from the HLS playlist, the recorded seconds of a live stream, or the movie header of a plain MP4; WebM and other files show none.

"History size" in Settings (default 25, range 0 to 500) caps the list. A new entry pushes out the oldest, and lowering the number deletes the oldest ones at once. The field saves on Enter or when you leave it, so typing 50 over 25 never saves a 5 first. 0 turns history off; finished downloads then leave the Downloads tab without a record, and the file is in your downloads folder.

Media already in history is left out of This page and the toolbar badge. "N downloaded" in the heading shows those rows again, gray with a DOWNLOADED tag, and they can still be downloaded. A card whose download is queued or running also goes gray, with an IN DOWNLOADS tag; opening it switches to the Downloads tab and points at the job instead of starting a second one. The × on an entry removes it, and its media counts as new again. "Clear history" asks for a second click. The search box filters by title, file name and page.

A stream counts as downloaded when either holds:

- Its URL equals an entry's once LL-HLS directives, signature and expiry parameters (`Signature`, `Expires`, `token`, `hdnts`, `X-Amz-*` and similar) and values that look like a Unix time from 2020 to 2049 are dropped. This works on any page, so the same video embedded elsewhere is recognized too.
- It plays on the same page (hash and `utm_*` ignored) and its URL also matches once path segments holding a token (`exp=...~acl=...~hmac=...`) and long opaque query values are ignored. This catches CDNs that sign the path.

Numeric ids, hex ids (ObjectIds, hashes) and UUIDs always count, as does a time shaped value under a name ending in `id`, so `?id=1234567` and `?id=1234568` stay apart. When another stream on the same page has the same shape but a different URL (a course page, a feed), the page rule is off for that page and only the exact URL counts. Live streams are never hidden, since the next recording holds new footage.

History lives in the extension's own storage and never leaves the browser. Entries from private windows (Chrome incognito with "Allow in Incognito", Firefox private windows including "Always use private browsing mode") are kept in `storage.session` and forgotten when the last private window closes, like the rest of private browsing. "Remember downloads from private windows" in Settings keeps them with the rest.

Nothing in the popup opens the saved file, because history keeps no download id. The file is in your downloads folder under the name shown on hover.

## Live streams

A live player reloads its playlist every few seconds, and many change the URL each time: LL-HLS `_HLS_msn` and `_HLS_part` directives, a timestamp cache buster, or a fresh token. Magpie keeps one row per stream anyway:

- `_HLS_` parameters are dropped from manifest URLs (the HLS spec reserves the prefix for these directives).
- Another URL with the same origin and path whose differing query values look volatile (6+ digit numbers, or 16+ character tokens with letters and digits) counts as a reload of the same stream. `?cam=1` and `?cam=2` stay separate. If an older URL comes back while a newer one is in use, two streams share that path and Magpie stops merging there.
- Each new HLS or DASH manifest is inspected right away. Variant and audio playlists listed by a master fold under the master row. A playlist without `EXT-X-ENDLIST`, a dynamic MPD, or a manifest the page keeps reloading, gets a LIVE badge.

Download on a live stream records. It starts with up to 30 seconds already published (what the player was showing), reloads the playlist every target duration, and appends new segments by media sequence number. Stop fetches the playlist once more and saves. Cancel throws the recording away. The recording also ends and saves on `EXT-X-ENDLIST` or after six failed reloads in a row. Missing segments leave a gap and a note on the job. The saved MP4 gets the recorded length written into its header at the end, and the filename gets the start time. Live recordings do not count toward the concurrent download limit.

fMP4 fragments from a live stream carry the stream's own clock, often hours in. The recorder shifts every track by the same number of seconds so the file starts at 0, removes the start delay that all tracks share from the init's edit list (an offset some encoders put there), and turns per segment `sidx` boxes into `free` boxes.

Twitch stitches ads into each viewer's playlist: a run of segments on a clock of its own behind `EXT-X-DISCONTINUITY` tags, titled after their source (`Amazon|<creative id>`) where the stream's own segments are titled `live`. They stand in for the live content of the break, and the stream's clock runs on without them. The recorder leaves them out, notes the seconds skipped on the job, and carries the file on from where it was when the stream comes back, as it does after any `EXT-X-DISCONTINUITY` (MPEG-TS and fMP4 alike, VOD downloads too, and a stream that restarts its numbering). An ad under some other title would be recorded, behind cuts, so the file still plays through. Before this, a preroll put the stream hours into the file behind a hole and a midroll stacked the ad over the start with its audio dropped, which players showed as a frozen picture or silence.

### Long recordings

Downloads are assembled in OPFS, on disk. Both browsers cap an extension's OPFS at 10 GiB unless it has the `unlimitedStorage` permission; Firefox also needs `navigator.storage.persist()`, which it grants that permission without a prompt. With both, the cap is the free disk (Chrome) or half the disk (Firefox).

Firefox private windows refuse OPFS and IndexedDB, so a download there lives in memory, and saving it briefly needs about twice its size. A live recording there is saved in 2 GB parts (`... part 1.mp4`, `... part 2.mp4`), each one released as soon as Firefox has written it out. Each part plays on its own from 0.

Measured with a throwaway soak harness that replays streams at 60x through the real extension (October 2026):

| Run | Result |
|---|---|
| 4 h TS stream, Chrome | 3 h 55 min saved, every frame present, browser memory 356 to 429 MB throughout |
| 12 GB fMP4, Chrome | 11.95 GB saved, peak 533 MB |
| 12 GB fMP4, Firefox | 11.95 GB saved, 0.8 to 1 GB throughout |
| 12 GB fMP4, Firefox private | six parts, 6 to 7 GB of RAM while recording, 7.8 GB peak; about 24 GB without parts |
| 4 h TS, Firefox private, 100 MB parts | four parts, each from 0, frames contiguous across them |

## How a download works

1. The background script watches `webRequest.onHeadersReceived` (observe only) and keeps a per tab list of candidates: `.m3u8` or `application/vnd.apple.mpegurl` is HLS, `.mpd` is DASH, a `media` typed request or a large `video/*` XHR is a plain file. Segments (`video/mp2t`, `seg001.m4s`) are ignored on purpose.
2. The popup asks the engine to inspect a candidate. For a master playlist or an MPD it returns the variants sorted by bandwidth.
3. The engine fetches segments 4 at a time, never more than 12 ahead of the writer, decrypts AES-128 if present, and appends them in order to a file in OPFS. TS segments go through mux.js and come out as fragmented MP4. fMP4 segments are written as is after the init segment. A separate audio track is fetched alongside, 2 at a time, and interleaved into the same file.
4. Before fetching, the engine asks the background to set a Referer and Origin rule for the CDN host (declarativeNetRequest session rule on Chrome scoped to the extension's own requests, blocking `onBeforeSendHeaders` on Firefox). Cookies go along because fetches use `credentials: include` and the extension has host permission.
5. The finished OPFS file becomes a blob URL and goes to `downloads.download`. The OPFS copy is deleted five minutes later.
6. The engine reports the finished job to the background, which adds it to history, and the job leaves the Downloads list. In Chrome that is a message from the offscreen document, which has no storage API.

Chrome's service worker can be killed any time, so the engine lives in an offscreen document, which Chrome keeps alive. Firefox builds as MV2 with a persistent background page for the same reason, and because MV2 grants host permissions at install instead of asking per site.

## Test fixtures

`/live/<session>/master.m3u8` on the test server replays the hls-ts clip as a live stream, and `/live-fmp4/<session>/` replays `hls-live-fmp4`, the 720p fMP4 rendition with fragment times moved 2 hours in by `fixtures/shift_tfdt.py` (`live.html?src=fmp4`): two segments at the start, one more every 4 seconds, `EXT-X-ENDLIST` after the fifth. `live.html?churn=cachebust` and `?churn=msn` make hls.js change the playlist URL on every reload.

`/live-dash/<session>/manifest.mpd` replays the dash fixture as a dynamic MPD: `availabilityStartTime` is the session start, segment n is served from n times 4 seconds in and 404 before that, `UTCTiming` points at `/time`, and the MPD turns static after about 24 seconds (`live-dash.html`). `/live-dash-timeline/<session>/manifest.mpd` does the same with a `SegmentTimeline` whose `$Time$` window slides and whose `startNumber` never moves, the shape many live packagers emit (`live-dash.html?mode=timeline`).

`testsite/fixtures/gen.sh` renders a 20 second `testsrc2` clip with the frame number burned in and a beep every second, at 720p, 480p and 360p, then packages it eleven ways: progressive, HLS as TS, fMP4 ladder, AES-128, byte range, separate audio as fMP4 and as TS, and DASH with `$Number$`, `SegmentTimeline` and `SegmentBase`. `ref/*.framemd5` holds the decoded frame hashes the e2e tests compare against, and `ref/audio.packets` the encoded AAC packet hashes (decoded audio cannot be compared across packagings, because the priming frame and edit lists differ).

## Roadmap

Phase 2, remaining: audio language picker, pause and resume, filename templates.

Phase 3: MSE capture content script for players that hide the manifest, DRM detection that explains itself, optional Go native host that hands the job to system ffmpeg for huge files.

## Known limits

- Only the first audio track is kept when video and audio are in the same segments. With a separate audio rendition the default language is merged; other languages are not selectable yet.
- Live HLS streams with a separate audio rendition record video only. Live DASH records both.
- DASH representations with `ContentProtection` or WebM are left out, and `xlink` Periods are skipped. Multi Period MPDs download the longest Period only. Live DASH with `SegmentBase` or MPEG-TS is refused.
- A live recording polls the playlist URL it started with. A site whose playlist URL needs a new token every few minutes ends the recording when the old one expires; it saves what it has.
- A recording lives in an OPFS file that the browser commits only when it closes. Quitting the browser or a crash during a recording loses it.
- Saving copies the file into Downloads, and the OPFS copy goes five minutes later, so a save briefly needs free disk for two copies.
- `web-ext lint` warns about `innerHTML` in React's bundle and nothing else.
- Firefox refuses OPFS when it runs in "Always use private browsing mode". Magpie then holds the download in memory until it saves, so RAM use equals the file size, twice that while saving. Live recordings there save in 2 GB parts; other downloads do not. `pnpm test:firefox:private` covers this mode.
- Filenames come from the page at the moment you click Download: JSON-LD video name, then `og:title`, `twitter:title`, `<title>`, `<h1>`, with a trailing or leading site name removed. If the tab has moved to another page, the title seen when the stream was detected is used instead.
- Firefox is tested through Selenium, not Playwright, because Playwright's Firefox build cannot load extensions.
- History misses a video, and shows it as available, when the site serves it from a different CDN host on the next visit, or signs the path in a segment without `=` or `~`.

## Website

`website/` is https://magpie.trevorblackman.dev, a Cloudflare Worker serving static assets from `website/site` on a custom domain. `website/site/_headers` sets `Cache-Control: no-transform` so Cloudflare cannot inject its analytics beacon, and the font and browser logos are self hosted, so the page makes no third party requests.

To ship a new version:

```powershell
pnpm release                  # 0.2.1 -> 0.2.2
pnpm release -Bump minor      # 0.2.1 -> 0.3.0
pnpm release -Version 0.2.2   # exact version
```

`scripts/release.ps1` runs typecheck and unit tests, bumps `extension/package.json`, builds both zips, has Mozilla sign the Firefox build (`pnpm sign:firefox`), and runs `website/deploy.ps1`. The deploy script copies the Chrome zip and signed xpi into `website/site`, rewrites the download links and version label in `index.html`, deletes files from older versions, runs `wrangler deploy`, and warns if the xpi is not served as `application/x-xpinstall`. Commit `extension/package.json` and `index.html` afterwards. The zips and xpi themselves are gitignored.

The page uses the popup's own palette (the `@theme` block in `extension/src/ui/style.css`) and shows screenshots of the real popup from `website/site/shots`. After a UI change, `pnpm site:shots` recaptures them: it starts the preview harness on port 5180 and photographs This page, the quality sheet, Downloads, History and the all tabs view with Playwright from `e2e/`. The pictures are committed, so a release without UI changes needs no recapture.
