# Plan: download every asset of a Reddit post

Status: Phase 1 implemented 2026-10-28 (`extension/src/core/reddit.ts`, `extension/src/background/reddit.ts`, testsite `/reddit.html`, `e2e/tests/reddit.spec.ts`). Differences from the design below: posts are read only on reddit.com and the test site, not by markup on every page (R1); detection of originals accepts the lightbox image as well as the `i.redd.it` host, so the test site can serve local files (R2); a 403 on an expired packaged MP4 does not fall back to HLS yet (R4); the history entry id is the group id, and `normalizeArchive` now keeps `kind`, `thumb` and `files` across restarts (R6). Reddit now answers plain `curl` with a JavaScript challenge page (a form that doubles a token), so the feed partial in Phase 3 needs a browser context or the challenge solved first. Phase 2 and 3 are not started.

Goal: on a subreddit feed, a user profile, or a single post page, Magpie lists each Reddit post as one row. One click saves every asset of that post at original quality: each gallery item, the image, the GIF, or the video with its audio. This is for subreddits and accounts the user has permission to save from, and the extension description says so.

## What Magpie does today, and why it misses Reddit

- The sniffer listens to `media`, `xmlhttprequest`, `other` and `object` requests only, and `looksLikeMedia` has no image types (`src/background/sniffer.ts:44`, `src/core/detect.ts:32`). Every `<img>` load is invisible.
- Feeds and carousels load `preview.redd.it` resized copies (320, 640, 1080 wide), not originals. Gallery items past the first load lazily, so even with image sniffing a 10 image gallery would show 1 to 3 small previews.
- A GIF post plays `preview.redd.it/<id>.gif?format=mp4` at a capped width. The sniffer would see that MP4, not the original GIF.
- Video posts already work if the user presses play: v.redd.it serves HLS fMP4 with separate audio, which 0.5.0 merges. But nothing ties the stream to its post, and the popup shows nothing until playback starts.
- No content scripts, no site logic. The only page access is `collectPageMeta` through `scripting.executeScript` (`src/background/pagetitle.ts`).

## What the subreddit looks like (measured 2026-10-28)

Sample: r/wallpaper top of year, 8 feed pages, 72 posts after removing ads. Plus the hot feed (24 posts) and two video heavy subs (r/LivingBackgrounds, r/Cinemagraphs) for the post types r/wallpaper lacked.

| Post type | r/wallpaper top year | Where the original lives in the DOM |
|---|---|---|
| image | 58 | `shreddit-post[content-href]` = `https://i.redd.it/<id>.<ext>` |
| gallery | 10 | `gallery-carousel li[slot=page-N] figure img[src^="https://i.redd.it/"]`, one per item, all present in the first HTML |
| crosspost | 3 | the original's `i.redd.it` URL inside the embedded post |
| gif | 1 | `content-href` = `https://i.redd.it/<id>.gif`; the player plays a capped MP4 |
| video | 0 (12 in the video subs) | `shreddit-player[packaged-media-json]` and `shreddit-player[src]` (HLS) |
| link | 0 (2 in the video subs) | external host, out of scope |

Facts that shape the design:

- The only video in the r/wallpaper hot feed was a promoted Pepsi ad. Ads are `<shreddit-ad-post>` and carry `post-promoted`. Skip both.
- A 10 image gallery (`t3_1orra8x`) had all 10 `i.redd.it` originals in the server HTML before any scrolling. Animated gallery items (`t3_1xe8p4n`, `t3_1x6h8if`) list `i.redd.it/<id>.gif` the same way.
- `i.redd.it` originals need no login. `curl` with `Accept: */*` got a 1,372,925 byte JPEG. With `Accept: text/html` the CDN answers 307 to an HTML viewer, so fetch with an image or `*/*` Accept, never a navigation.
- Animated gallery originals are large. The two sampled GIFs are 15.9 MB and 28.9 MB.
- `packaged-media-json` lists progressive MP4s, 220p to 1080p. ffprobe on the 1080p file of `t3_1x7vogc`: h264 1902x1080 plus aac. One fetch, audio included, no merge.
- Packaged MP4 URLs are signed and expired about 5 hours after the page loaded (`e=1793224800`, 22:00 UTC, page fetched 17:09 UTC). The HLS `a=` token lasts 30 days.
- Reddit caps video at 1080p. A post titled "4K seamless loop" served 1920x1080 max in both HLS and packaged MP4.
- v.redd.it HLS masters list each resolution twice, once per audio group (64k and 128k).
- The JSON API is closed to anonymous clients. `/.json`, `api.reddit.com` and headless Chrome all got 403 "blocked by network security". old.reddit redirects to login. Automated Chrome gets a reCAPTCHA page. The `/svc/shreddit/community-more-posts/<sort>/?name=<sub>` partial (what the feed uses for infinite scroll) answered plain curl with 200.

## Design decisions

### R1. Read the rendered page, not the API

A self contained function, `collectRedditPosts()`, runs in the tab through the same `executeScript` path as `collectPageMeta`. It walks `shreddit-post` elements (never `shreddit-ad-post`, never `[post-promoted]`) and returns raw facts per post: id, permalink, title, subreddit, author, created time, post type, `content-href`, gallery item URLs in slot order, player `src`, `packaged-media-json`, and one small preview URL for the thumbnail.

Detection is by markup (`document.querySelector('shreddit-post')`), not hostname. That lets the testsite serve fixture pages, and costs one selector on non Reddit pages.

Why not the JSON API: it is blocked for logged out users, and whether an extension fetch from a logged in session passes is unverified. The DOM is what the user's browser already shows. The JSON path (`/comments/<id>.json`, `media_metadata`, `gallery_data`) stays a fallback for R7.

### R2. Turn facts into assets in a pure function

`src/sites/reddit.ts` exports `redditAssets(raw): RedditPost` with an ordered `assets` list. Pure, so vitest covers it with fixture HTML.

| Post type | Assets |
|---|---|
| image | the `i.redd.it` original |
| gallery | each `i.redd.it` item in slot order, stills and GIFs alike |
| gif | the `i.redd.it` GIF |
| video | the largest packaged MP4; the HLS master as fallback |
| crosspost | the embedded original's assets |
| link, text, anything else | none; the row says "Not hosted on Reddit" and is disabled |

### R3. A post is a candidate; its assets become ordinary jobs

- `MediaKind` gains `'post'`. A post candidate carries `assets: Asset[]` and `post: { id, subreddit, author }`.
- Starting a post makes one job per asset, all with a shared `groupId`. Images, GIFs and packaged MP4s are `kind: 'file'` jobs, so `streamFile` downloads them as is. The HLS fallback is a normal `hls` job with the best variant picked automatically: highest resolution, then highest audio bitrate.
- This reuses the queue, `maxConcurrent`, progress, cancel, and per job errors. A failed asset can be retried alone.
- `guessExtension` learns `jpg jpeg png webp gif`.

### R4. Fresh URLs at start

Packaged MP4 links die within hours. The background reruns `collectRedditPosts()` for that one post when the user clicks Start. A queued job that hits 403 on `packaged-media.redd.it` falls back to the HLS master once.

### R5. File layout

```
Reddit/<subreddit>/<title> [<post id>].<ext>          one asset
Reddit/<subreddit>/<title> [<post id>]/01.<ext>       two or more
```

Each segment goes through `sanitizeFilename`, and a new `joinPath` joins them. The post id keeps names unique and makes R6 reliable. This composes with the Downloads subfolder setting discussed earlier (`Magpie/Reddit/...`), which can ship first or alongside.

### R6. Archive and "already downloaded"

One archive entry per post, written when its last asset saves, with `files: n` and the post thumbnail. `isArchived` matches post candidates by Reddit post id, so a saved post grays out or hides like any downloaded stream. Sniffed requests belonging to a post (its HLS master, the GIF's preview MP4) fold under it through `parentId`, so the list shows one row per post, not three.

### R7. Markup drift

Shreddit attribute names are internal and will change. Mitigations:

- All selectors live in `collectRedditPosts()`. Fixture tests fail loudly when a capture from a newer Reddit no longer parses.
- If a `shreddit-post` yields no assets but has a known media type, the row says "Reddit changed its page; open the post page" instead of saving nothing.
- Later, if needed, a same origin fetch of `/comments/<id>.json` from the tab as a second source, once confirmed it works for a logged in user.

### R8. Popup

- On a Reddit tab, This page lists post rows above sniffed streams. The tile shows the post preview. Below the title, a summary line such as `r/wallpaper · Gallery, 10 images` or `Video 1080p`.
- Clicking a row opens the existing sheet, listing the assets read only, with one button: `Download 10 files`.
- Downloads tab groups jobs by `groupId`, for example `Avengers Assemble 3 of 10`. Expanding shows each file.
- Phase 2 adds `Download all on this page (24 posts)`, which skips archived posts.

### R9. Permission wording

Manifest `description`, README, website hero and FAQ, and the AMO listing get one plain line: Magpie is for media you own or have permission to save, such as your own subreddits and accounts. No in popup gate.

## Phases

### Phase 1: one post, every asset

1. `collectRedditPosts()` plus `redditAssets()` with fixtures captured today: image, 10 item gallery, animated gallery, GIF, video with packaged MP4 and audio, crosspost, ad, link post.
2. `'post'` kind, `assets`, `groupId`, image extensions, `joinPath`, file layout.
3. Background: run the collector when the popup asks for candidates and on Start; merge post rows; fold sniffed children.
4. Popup row, sheet, grouped jobs. Archive per post.
5. Description wording (R9).
6. Testsite `/reddit/` page with the same markup pointing at local fixtures: jpg, png, two GIFs, a packaged style MP4 with audio, an HLS master with two audio groups. e2e: gallery saves N files with matching hashes, GIF saves byte identical, video saves one file with one video and one audio stream, ads never appear.
7. Manual pass in the user's logged in Chrome: r/wallpaper hot feed, a gallery post page, a user profile page, Firefox.

### Phase 2: whole page

`Download all on this page`, skip already saved posts, and a progress summary in the Downloads tab.

### Phase 3, optional: whole subreddit or account

Page through `/svc/shreddit/community-more-posts/<sort>/?name=<sub>&after=<cursor>` with a post limit and a pause between pages, so the user does not have to scroll. Same markup, so the R1 collector runs on fetched HTML through `DOMParser`. Needs its own design pass for rate limits and stopping.

## Risks still open

- Not yet seen in a real browser: the post page, user profile pages, and whether shreddit drops far off screen posts from the DOM on long scrolls. All Phase 1 step 7.
- Reddit markup changes break extraction until the collector is updated (R7).
- Big GIF galleries mean hundreds of MB per post. Concurrency 2 keeps it polite. A per post size warning may be worth adding.
- Some Reddit videos have no packaged MP4 list. Those use HLS, which already works.

## Not in this plan

- Imgur, Redgifs, YouTube and other external link posts.
- Comments, text posts, captions as sidecar files.
- old.reddit.com (now login only, different markup).
- The Reddit JSON API as the primary source.
