import { browser } from 'wxt/browser';
import type { Candidate } from '../core/types';
import { cleanTitle, collectPageMeta, pickTitle, type PageMeta } from '../core/title';

function stripHash(url: string): string {
  return url.split('#')[0] ?? url;
}

async function readMeta(tabId: number): Promise<PageMeta | undefined> {
  if (import.meta.env.FIREFOX) {
    const tabs = browser.tabs as unknown as { executeScript(id: number, d: { code: string }): Promise<unknown[]> };
    const [r] = await tabs.executeScript(tabId, { code: `(${collectPageMeta.toString()})()` });
    return r as PageMeta | undefined;
  }
  const scripting = (browser as unknown as { scripting: typeof chrome.scripting }).scripting;
  const [r] = await scripting.executeScript({ target: { tabId }, func: collectPageMeta });
  return r?.result as PageMeta | undefined;
}

/**
 * Title for the download, read from the page at the moment the user clicks
 * Download: JSON-LD video name, og:title, twitter:title, <title>, then <h1>.
 * Falls back to the tab title captured when the stream was first seen.
 */
export async function pageTitleFor(c: Candidate): Promise<string> {
  const stored = cleanTitle(c.pageTitle, '', c.pageUrl);
  try {
    const tab = await browser.tabs.get(c.tabId);
    // The tab moved on to another page; its metadata no longer describes this stream.
    if (!tab.url || stripHash(tab.url) !== stripHash(c.pageUrl)) return stored;
    const meta = await Promise.race([
      readMeta(c.tabId),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    const live = meta ? pickTitle(meta, c.pageUrl) : cleanTitle(tab.title ?? '', '', c.pageUrl);
    return live || stored;
  } catch {
    // Tab closed, or a page scripts cannot run on (store pages, PDF viewer).
    return stored;
  }
}
