import { browser } from 'wxt/browser';
import type { Candidate } from '../core/types';
import { cleanTitle, collectPageMeta, pickTitle, type PageMeta } from '../core/title';

function stripHash(url: string): string {
  return url.split('#')[0] ?? url;
}

/**
 * Run a self contained function in the tab's page and return what it returns.
 * The function is serialized, so it may not touch module scope. Rejects on a
 * page scripts cannot run on (store pages, the PDF viewer, browser pages).
 */
export async function runInTab<T>(tabId: number, fn: () => T): Promise<T | undefined> {
  if (import.meta.env.FIREFOX) {
    const tabs = browser.tabs as unknown as { executeScript(id: number, d: { code: string }): Promise<unknown[]> };
    const [r] = await tabs.executeScript(tabId, { code: `(${fn.toString()})()` });
    return r as T | undefined;
  }
  const scripting = (browser as unknown as { scripting: typeof chrome.scripting }).scripting;
  const [r] = await scripting.executeScript({ target: { tabId }, func: fn });
  return r?.result as T | undefined;
}

/** `fn` in the tab, or undefined after `ms` without an answer. */
export function runInTabTimed<T>(tabId: number, fn: () => T, ms: number): Promise<T | undefined> {
  return Promise.race([runInTab(tabId, fn), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
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
    const meta = await runInTabTimed<PageMeta>(c.tabId, collectPageMeta, 1500);
    const live = meta ? pickTitle(meta, c.pageUrl) : cleanTitle(tab.title ?? '', '', c.pageUrl);
    return live || stored;
  } catch {
    // Tab closed, or a page scripts cannot run on (store pages, PDF viewer).
    return stored;
  }
}
