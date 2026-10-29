import { cleanSegment } from './filename';

/**
 * Reddit posts: read what the page shows, turn it into the files to save.
 *
 * Reddit's JSON API is closed to logged out clients, so the facts come from the
 * rendered page: every post is a `shreddit-post` element whose attributes name
 * the post, and whose children hold the originals. The markup is Reddit's
 * internal and will drift; every selector lives in collectRedditPosts, and the
 * fixture tests in reddit.test.ts say when a capture no longer parses.
 */

/** Raw facts read from one `shreddit-post` element, as the page shows them. */
export interface RedditRaw {
  /** `t3_1x4toay`. */
  id: string;
  /** Absolute post URL. */
  permalink: string;
  title: string;
  /** `r/comics`, '' on a profile post without one. */
  subreddit: string;
  author: string;
  /** The `created-timestamp` attribute as written: `2026-10-13T11:04:05.164000+0000`. */
  created: string;
  /** The `post-type` attribute: image, gallery, gif, video, crosspost, link, text, ... */
  type: string;
  /** `content-href`: the image or GIF original, `https://www.reddit.com/gallery/<id>` for a gallery, the v.redd.it id for a video. */
  contentHref: string;
  /** `i.redd.it` originals of a gallery in slot order. */
  gallery: string[];
  /** Every `i.redd.it` image the post shows outside a gallery (an image post, or the post a crosspost embeds). */
  images: string[];
  /** The player's `src`: the v.redd.it HLS master for a video, a capped MP4 of the GIF for a GIF post. */
  playerSrc: string;
  /** The player's `packaged-media-json`, raw: progressive MP4s with audio, several sizes. */
  packaged: string;
  /** A small preview, for the row's tile. */
  preview: string;
}

/**
 * Runs inside the page via scripting.executeScript / tabs.executeScript, so it
 * must stay self contained: no imports, no references to module scope. Ads
 * are `shreddit-ad-post`, a different element, and never match.
 */
export function collectRedditPosts(root: ParentNode = document): RedditRaw[] {
  const base = (root as Document).baseURI || location.href;
  const abs = (href: string) => {
    try {
      return new URL(href, base).href;
    } catch {
      return href;
    }
  };
  const attr = (el: Element, name: string) => (el.getAttribute(name) ?? '').trim();
  // An original is served from i.redd.it, or is the lightbox image (the preview beside it says non-lightboxed-content).
  const ORIGINAL = 'img[src^="https://i.redd.it/"], img.media-lightbox-img:not(.non-lightboxed-content)';
  const src = (img: Element | null) => (img ? abs(img.getAttribute('src') || img.getAttribute('data-lazy-src') || '') : '');
  const out: RedditRaw[] = [];
  for (const el of Array.from(root.querySelectorAll('shreddit-post'))) {
    if (el.hasAttribute('promoted') || el.hasAttribute('post-promoted')) continue;
    const id = attr(el, 'id');
    if (!id) continue;
    // Gallery items are <li slot="page-N">, in the HTML in slot order, every one of them, before any scrolling.
    const pages = Array.from(el.querySelectorAll('gallery-carousel li[slot^="page-"]'))
      .map((li) => ({ n: Number(attr(li, 'slot').slice(5)), url: src(li.querySelector(ORIGINAL)) }))
      .filter((p) => Number.isFinite(p.n) && p.url)
      .sort((a, b) => a.n - b.n);
    const images: string[] = [];
    for (const img of Array.from(el.querySelectorAll(ORIGINAL))) {
      const url = src(img);
      if (url && !images.includes(url) && !img.closest('gallery-carousel')) images.push(url);
    }
    const player = el.querySelector('shreddit-player-2, shreddit-player');
    // The poster of a video, else the first preview: its srcset's first entry is the smallest size.
    const previewImg = el.querySelector('img[slot="poster"]') ?? el.querySelector('img[src*="preview.redd.it/"], img[src*="external-preview.redd.it/"], img.non-lightboxed-content');
    const srcset = previewImg?.getAttribute('srcset') ?? '';
    const previewUrl = (srcset.split(',')[0] ?? '').trim().split(/\s+/)[0] || (previewImg?.getAttribute('src') ?? '');
    const preview = previewUrl ? abs(previewUrl) : '';
    out.push({
      id,
      permalink: abs(attr(el, 'permalink')),
      title: attr(el, 'post-title'),
      subreddit: attr(el, 'subreddit-prefixed-name'),
      author: attr(el, 'author'),
      created: attr(el, 'created-timestamp'),
      type: attr(el, 'post-type'),
      contentHref: attr(el, 'content-href') ? abs(attr(el, 'content-href')) : '',
      gallery: pages.map((p) => p.url),
      images,
      playerSrc: player ? abs(attr(player, 'src')) : '',
      packaged: player ? attr(player, 'packaged-media-json') : '',
      preview,
    });
  }
  return out;
}

/** One file to save. `hls` is a v.redd.it master, downloaded like any other HLS stream. */
export interface RedditAsset {
  url: string;
  kind: 'file' | 'hls';
  mime: string;
  /** What the sheet lists: "1 of 20 · PNG", "1080p · MP4 with audio". */
  label: string;
}

export interface RedditPost {
  /** `1x4toay`, without the `t3_` prefix. */
  id: string;
  permalink: string;
  title: string;
  /** `comics`, without the `r/` prefix. */
  subreddit: string;
  author: string;
  /** When the post was made, ISO 8601 in UTC (`2026-10-13T11:04:05Z`), '' when the page did not say. */
  created: string;
  type: string;
  assets: RedditAsset[];
  preview: string;
  /** "Gallery, 20 images", "Video 1080p", "GIF", "Image, PNG". */
  summary: string;
  /** Why there is nothing to save, when there is nothing. */
  note?: string;
}

/**
 * Reddit's timestamp as plain ISO 8601 in UTC: microseconds dropped, `+0000`
 * made `Z`. Other offsets are kept with a colon. Anything unexpected is '',
 * so a folder never gets a mangled date.
 */
export function normalizeCreated(raw: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!m) return '';
  const zone = (m[2] ?? 'Z').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return `${m[1]}${zone === '+00:00' || zone === '-00:00' ? 'Z' : zone}`;
}

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function extOf(url: string): string {
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  return (m?.[1] ?? '').toLowerCase();
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i;

/**
 * An image file, not a preview or a page: i.redd.it is where originals live,
 * preview.redd.it and external-preview.redd.it serve resized copies, and
 * reddit.com/gallery/<id> is a page. Any other host with an image extension
 * is taken as is (the test site).
 */
function isOriginal(url: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === 'i.redd.it') return true;
  if (host.endsWith('.redd.it') || host.endsWith('reddit.com')) return false;
  return IMAGE_EXT.test(url);
}

function imageAsset(url: string, label: string): RedditAsset {
  const ext = extOf(url);
  return { url, kind: 'file', mime: IMAGE_MIME[ext] ?? 'image/' + (ext || 'jpeg'), label: `${label} · ${(ext || 'jpg').toUpperCase()}` };
}

interface Packaged {
  url: string;
  height: number;
  bitrate: number;
}

/** The progressive MP4s a player's `packaged-media-json` lists, largest first. Unparseable JSON gives none. */
export function parsePackaged(raw: string): Packaged[] {
  if (!raw) return [];
  try {
    const json = JSON.parse(raw) as { playbackMp4s?: { permutations?: { source?: { url?: string; bitrateBps?: number; dimensions?: { height?: number } } }[] } };
    return (json.playbackMp4s?.permutations ?? [])
      .map((p) => ({ url: p.source?.url ?? '', height: p.source?.dimensions?.height ?? 0, bitrate: p.source?.bitrateBps ?? 0 }))
      .filter((p) => /^https?:\/\//.test(p.url))
      .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  } catch {
    return [];
  }
}

const HOSTED = new Set(['image', 'gallery', 'gif', 'video', 'crosspost']);

/**
 * The files of a post, in the order they are shown. A pure function of what
 * collectRedditPosts read, so fixtures test it. A crosspost is read like the
 * post it embeds: the gallery, the player or the image is inside its element.
 */
export function redditAssets(raw: RedditRaw): RedditPost {
  const post: RedditPost = {
    id: raw.id.replace(/^t3_/, ''),
    permalink: raw.permalink,
    title: raw.title,
    subreddit: raw.subreddit.replace(/^r\//, ''),
    author: raw.author,
    created: normalizeCreated(raw.created),
    type: raw.type,
    assets: [],
    preview: raw.preview,
    summary: '',
  };
  const gallery = raw.gallery.filter(isOriginal);
  const packaged = parsePackaged(raw.packaged);
  const hls = /\.m3u8(\?|$)/i.test(raw.playerSrc) ? raw.playerSrc : '';
  const single = isOriginal(raw.contentHref) ? raw.contentHref : raw.images.find(isOriginal) ?? '';

  if (gallery.length) {
    post.assets = gallery.map((url, i) => imageAsset(url, `${i + 1} of ${gallery.length}`));
    const gifs = gallery.filter((u) => extOf(u) === 'gif').length;
    post.summary = `Gallery, ${gallery.length} ${gifs === gallery.length ? 'GIFs' : gifs ? `items, ${gifs} animated` : 'images'}`;
  } else if (packaged.length || hls) {
    const best = packaged[0];
    if (best) post.assets = [{ url: best.url, kind: 'file', mime: 'video/mp4', label: `${best.height}p · MP4 with audio` }];
    else post.assets = [{ url: hls, kind: 'hls', mime: 'application/vnd.apple.mpegurl', label: 'HLS, best quality' }];
    post.summary = best ? `Video ${best.height}p` : 'Video';
  } else if (single) {
    const gif = extOf(single) === 'gif';
    post.assets = [imageAsset(single, gif ? 'GIF' : 'Image')];
    post.summary = gif ? 'GIF' : `Image, ${(extOf(single) || 'jpg').toUpperCase()}`;
  } else if (HOSTED.has(raw.type)) {
    post.summary = raw.type === 'crosspost' ? 'Crosspost' : raw.type[0]!.toUpperCase() + raw.type.slice(1);
    post.note = 'Reddit changed its page and the files could not be found. Open the post page and try again.';
  } else {
    post.summary = raw.type === 'link' ? 'Link' : raw.type === 'text' ? 'Text post' : raw.type || 'Post';
    post.note = 'Not hosted on Reddit. Nothing to save here.';
  }
  if (raw.type === 'crosspost' && post.assets.length) post.summary = `Crosspost, ${post.summary.toLowerCase()}`;
  return post;
}

/** One path segment the downloads API accepts anywhere (see cleanSegment). */
function segment(name: string, fallback: string, max = 120): string {
  return cleanSegment(name, fallback, max);
}

/** `2026-10-13 thisecommercelife · The day all billionaires died [1x4toay]`: the post's name on disk. */
export function postName(post: RedditPost): string {
  const date = post.created.slice(0, 10);
  const who = segment(post.author, '');
  const lead = [date, who].filter(Boolean).join(' ');
  const title = segment(post.title, 'post', 100);
  return `${lead ? `${lead} · ` : ''}${title} [${post.id}]`;
}

/**
 * Where each asset is saved, relative to the downloads folder:
 *   Reddit/<subreddit>/<date> <author> · <title> [<post id>].<ext>          one file
 *   Reddit/<subreddit>/<date> <author> · <title> [<post id>]/01.<ext>       two or more
 * The date is the post's, in UTC. The post id keeps names unique across
 * posts with the same title, and names the post's URL: https://redd.it/<id>.
 */
export function assetPaths(post: RedditPost): string[] {
  const dir = ['Reddit', segment(post.subreddit || post.author, 'reddit'), postName(post)];
  const ext = (a: RedditAsset) => (a.kind === 'hls' ? 'mp4' : extOf(a.url) || 'bin');
  if (post.assets.length === 1) return [`${dir.slice(0, 2).join('/')}/${dir[2]}.${ext(post.assets[0]!)}`];
  const width = String(post.assets.length).length;
  return post.assets.map((a, i) => `${dir.join('/')}/${String(i + 1).padStart(Math.max(2, width), '0')}.${ext(a)}`);
}

/** The folder (or the one file) a post was saved as, for history. */
export function postPath(post: RedditPost): string {
  const paths = assetPaths(post);
  return paths.length === 1 ? paths[0]! : paths[0]!.slice(0, paths[0]!.lastIndexOf('/'));
}

/**
 * The sidecar written beside a post's files once the last one is saved:
 * `post.json` in the post's folder, or `<name>.json` next to a single file.
 * Everything the page said about the post, and where each file came from.
 */
export function sidecar(post: RedditPost, paths: string[], downloadedAt: Date): { filename: string; json: string } {
  const first = paths[0] ?? postPath(post);
  const filename = paths.length === 1 ? first.replace(/\.[a-z0-9]+$/i, '') + '.json' : `${first.slice(0, first.lastIndexOf('/'))}/post.json`;
  const body = {
    source: 'reddit',
    id: post.id,
    url: post.permalink,
    subreddit: post.subreddit,
    author: post.author,
    title: post.title,
    created: post.created,
    type: post.type,
    downloaded: downloadedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    files: post.assets.map((a, i) => ({ name: (paths[i] ?? '').slice((paths[i] ?? '').lastIndexOf('/') + 1), source: a.url })),
  };
  return { filename, json: JSON.stringify(body, null, 2) + '\n' };
}

/**
 * True when a file a post names may be fetched: it lives on Reddit's media
 * hosts (i.redd.it, v.redd.it, packaged-media.redd.it and the rest of
 * redd.it), or on the page's own origin (the test site serves its fixtures
 * itself). Anything else the page's markup points at is left alone, since the
 * download carries the user's cookies.
 */
export function assetAllowed(url: string, pageUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.hostname === 'redd.it' || u.hostname.endsWith('.redd.it')) return true;
    return u.origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}
