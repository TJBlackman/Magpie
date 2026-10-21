import { browser } from 'wxt/browser';
import { candidateId, detect } from '../core/detect';
import type { Candidate, Envelope } from '../core/types';
import { pageTitleFor } from './pagetitle';

/**
 * Observe (never block) responses and collect media candidates per tab.
 * State lives in memory and, where available, storage.session so a restarted
 * Chrome service worker can recover it.
 */
export class Sniffer {
  private byTab = new Map<number, Map<string, Candidate>>();
  private restored: Promise<void>;
  /** Last time each tab's page title was read, to keep popup opens cheap. */
  private titleReadAt = new Map<number, number>();

  constructor() {
    this.restored = this.restore();
  }

  listen(): void {
    browser.webRequest.onHeadersReceived.addListener(
      (details) => void this.onResponse(details),
      { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
      ['responseHeaders'],
    );
    browser.tabs.onRemoved.addListener((tabId) => this.clear(tabId));
    browser.tabs.onUpdated.addListener((tabId, info) => {
      // A top level navigation starts a fresh list for the tab.
      if (info.status === 'loading' && info.url) this.clear(tabId);
    });
  }

  async forTab(tabId?: number): Promise<Candidate[]> {
    await this.restored;
    if (tabId === undefined) {
      return [...this.byTab.values()].flatMap((m) => [...m.values()]).sort((a, b) => b.seenAt - a.seenAt);
    }
    return [...(this.byTab.get(tabId)?.values() ?? [])].sort((a, b) => b.seenAt - a.seenAt);
  }

  /**
   * Re-read page titles (og:title and friends) for the tab, or every tab, and
   * store them on the candidates so the UI can lead with a title, not a URL.
   * Titles change after the stream starts on many sites, so this runs again
   * whenever the UI asks, at most every few seconds per tab.
   */
  async refreshTitles(tabId?: number, force = false): Promise<boolean> {
    await this.restored;
    const tabIds = tabId === undefined ? [...this.byTab.keys()] : [tabId];
    let changed = false;
    await Promise.all(
      tabIds.map(async (t) => {
        const list = [...(this.byTab.get(t)?.values() ?? [])];
        if (!list.length) return;
        if (!force && Date.now() - (this.titleReadAt.get(t) ?? 0) < 3000) return;
        this.titleReadAt.set(t, Date.now());
        // One read per page the tab has shown streams for.
        const byPage = new Map<string, Candidate[]>();
        for (const c of list) byPage.set(c.pageUrl, [...(byPage.get(c.pageUrl) ?? []), c]);
        for (const group of byPage.values()) {
          const title = await pageTitleFor(group[0]!);
          if (!title) continue;
          for (const c of group) {
            if (c.pageTitle !== title) {
              c.pageTitle = title;
              changed = true;
            }
          }
        }
      }),
    );
    if (changed) void this.persist();
    return changed;
  }

  clear(tabId: number): void {
    this.byTab.delete(tabId);
    this.titleReadAt.delete(tabId);
    void this.persist();
    void this.badge(tabId);
    // Open popups and the Downloads page re-read their list.
    this.notify(tabId);
  }

  private async onResponse(details: chrome.webRequest.OnHeadersReceivedDetails) {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    if (details.url.startsWith(browser.runtime.getURL(''))) return;
    const headers = details.responseHeaders ?? [];
    const h = (name: string) => headers.find((x: { name: string; value?: string }) => x.name.toLowerCase() === name)?.value ?? '';
    const mime = h('content-type');
    const lenRaw = h('content-length');
    const contentLength = lenRaw ? Number(lenRaw) : null;
    const kind = detect({ url: details.url, mime, resourceType: details.type, contentLength });
    if (!kind) return;

    await this.restored;
    const id = candidateId(details.tabId, details.url);
    let tabMap = this.byTab.get(details.tabId);
    if (!tabMap) {
      tabMap = new Map();
      this.byTab.set(details.tabId, tabMap);
    }
    const existing = tabMap.get(id);
    if (existing) {
      existing.seenAt = Date.now();
      return;
    }
    let pageUrl = '';
    let pageTitle = '';
    try {
      const tab = await browser.tabs.get(details.tabId);
      pageUrl = tab.url ?? '';
      pageTitle = tab.title ?? '';
    } catch {
      /* tab gone */
    }
    // Firefox gives the full document URL; Chrome only gives the initiator
    // origin, so prefer the tab URL there (CDNs often check the full Referer).
    const d = details as unknown as { documentUrl?: string; initiator?: string };
    const referer = d.documentUrl || pageUrl || d.initiator || '';
    const candidate: Candidate = {
      id,
      tabId: details.tabId,
      url: details.url,
      kind,
      mime: mime.split(';')[0]!.trim(),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      pageUrl,
      pageTitle,
      referer: referer || pageUrl,
      seenAt: Date.now(),
    };
    tabMap.set(id, candidate);
    void this.persist();
    void this.badge(details.tabId);
    this.notify(details.tabId);
    // The page usually finishes setting its title shortly after playback starts.
    setTimeout(() => {
      void this.refreshTitles(details.tabId, true).then((changed) => changed && this.notify(details.tabId));
    }, 1500);
  }

  private notify(tabId: number) {
    const env: Envelope = { magpie: 'ui', event: { type: 'candidates', tabId } };
    browser.runtime.sendMessage(env).catch(() => {});
  }

  private async badge(tabId: number) {
    const n = this.byTab.get(tabId)?.size ?? 0;
    const action = (browser as unknown as { action?: typeof browser.action; browserAction?: typeof browser.action }).action
      ?? (browser as unknown as { browserAction?: typeof browser.action }).browserAction;
    if (!action) return;
    try {
      await action.setBadgeText({ tabId, text: n ? String(n) : '' });
      await action.setBadgeBackgroundColor({ tabId, color: '#22d3ee' });
    } catch {
      /* tab gone */
    }
  }

  private get session(): chrome.storage.StorageArea | null {
    return (browser.storage as unknown as { session?: chrome.storage.StorageArea }).session ?? null;
  }

  private async persist() {
    const s = this.session;
    if (!s) return;
    const flat: Candidate[] = [...this.byTab.values()].flatMap((m) => [...m.values()]);
    await s.set({ candidates: flat }).catch(() => {});
  }

  private async restore() {
    const s = this.session;
    if (!s) return;
    try {
      const { candidates } = (await s.get('candidates')) as { candidates?: Candidate[] };
      for (const c of candidates ?? []) {
        let m = this.byTab.get(c.tabId);
        if (!m) {
          m = new Map();
          this.byTab.set(c.tabId, m);
        }
        m.set(c.id, c);
      }
    } catch {
      /* nothing saved */
    }
  }
}
