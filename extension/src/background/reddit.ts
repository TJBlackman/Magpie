import { browser } from 'wxt/browser';
import { candidateId, manifestUrl } from '../core/detect';
import { assetAllowed, collectRedditPosts, redditAssets, type RedditPost } from '../core/reddit';
import type { Candidate } from '../core/types';
import { runInTabTimed } from './pagetitle';

/** How long a page gets to answer. A feed with a few dozen posts answers in a few milliseconds. */
const COLLECT_MS = 2000;

/** Only pages that can hold Reddit posts: reddit.com, and the local test site. Every other page is left alone. */
export function mayHoldPosts(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === 'reddit.com' || u.hostname.endsWith('.reddit.com') || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * The post with only the files Magpie will fetch: Reddit's media hosts and
 * the page's own origin (see assetAllowed). A post left with nothing says so.
 */
export function restrictAssets(post: RedditPost, pageUrl: string): RedditPost {
  const assets = post.assets.filter((a) => assetAllowed(a.url, pageUrl));
  if (assets.length === post.assets.length) return post;
  return { ...post, assets, note: assets.length ? post.note : 'The files are not on Reddit, so they are left alone.' };
}

/** The posts the tab shows right now, as read from its page, or none when the page cannot be read. */
export async function readPosts(tabId: number, pageUrl: string): Promise<RedditPost[]> {
  const raws = await runInTabTimed(tabId, collectRedditPosts, COLLECT_MS).catch(() => undefined);
  return (raws ?? []).map((r) => restrictAssets(redditAssets(r), pageUrl));
}

/**
 * The row for a post. Its id follows the permalink, so a second read of the
 * page updates the row instead of adding one. The player's HLS master is
 * listed as a child, so the stream the page loads when the video plays folds
 * under the post instead of getting a row of its own.
 */
export function postCandidate(post: RedditPost, tab: { id: number; url: string; incognito?: boolean }, seenAt: number): Candidate {
  const c: Candidate = {
    id: candidateId(tab.id, post.permalink),
    tabId: tab.id,
    url: post.permalink,
    kind: 'post',
    mime: '',
    contentLength: null,
    pageUrl: tab.url,
    pageTitle: post.title,
    referer: tab.url,
    seenAt,
    post,
  };
  if (post.preview) c.thumb = post.preview;
  if (tab.incognito) c.incognito = true;
  const children = post.assets.filter((a) => a.kind === 'hls').map((a) => manifestUrl(a.url));
  if (children.length) c.children = children;
  return c;
}

/** Every post on the tab as rows, in page order. Null for a tab that cannot hold posts. */
export async function collectTab(tabId: number): Promise<Candidate[] | null> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.id === undefined || !mayHoldPosts(tab.url)) return null;
  const posts = await readPosts(tabId, tab.url);
  const now = Date.now();
  // The list sorts newest first; a post further down the page counts as seen a little earlier.
  return posts.map((p, i) => postCandidate(p, { id: tab.id!, url: tab.url!, incognito: tab.incognito }, now - i));
}
