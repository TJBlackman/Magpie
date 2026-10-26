import { browser } from 'wxt/browser';
import { candidateId, detect, manifestUrl, sameStream } from '../core/detect';
import type { Candidate, Envelope, Inspection } from '../core/types';
import { pageTitleFor } from './pagetitle';

/** Reloads after the first sighting that mark a manifest as live. Players fetch a VOD manifest once. */
const LIVE_RELOADS = 2;
/** URLs remembered per tab. A live stream whose URL changes on every reload adds one each time. */
const MAX_URLS = 2000;

/**
 * Observe (never block) responses and collect media candidates per tab.
 * State lives in memory and, where available, storage.session so a restarted
 * Chrome service worker can recover it.
 *
 * One stream is one candidate. A live player reloads its manifest every few
 * seconds, often with a new URL each time (LL-HLS directives, cache busters,
 * fresh tokens); those reloads update the existing candidate instead of
 * adding rows. Variant playlists of a listed master are kept but hidden.
 */
export class Sniffer {
  private byTab = new Map<number, Map<string, Candidate>>();
  /** Per tab: every URL a candidate has carried, to its candidate id. */
  private urls = new Map<number, Map<string, string>>();
  /** Per tab: origin + path values that several streams share at once, so URLs there never merge. */
  private shared = new Map<number, Set<string>>();
  private restored: Promise<void>;
  /** Last time each tab's page title was read, to keep popup opens cheap. */
  private titleReadAt = new Map<number, number>();
  /** Called once per new manifest. The background inspects it and reports back through learn(). */
  onManifest: ((c: Candidate) => void) | null = null;
  /** Candidates left out of the badge count: media the archive already has. */
  isHidden: (c: Candidate) => boolean = () => false;

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

  /** Candidates to show, newest first. Variant playlists of a listed master are left out. */
  async forTab(tabId?: number): Promise<Candidate[]> {
    await this.restored;
    const list = tabId === undefined ? [...this.byTab.values()].flatMap((m) => [...m.values()]) : [...(this.byTab.get(tabId)?.values() ?? [])];
    return list.filter((c) => !c.parentId).sort((a, b) => b.seenAt - a.seenAt);
  }

  /** Any candidate by id, hidden ones included. */
  async get(id: string): Promise<Candidate | undefined> {
    await this.restored;
    for (const m of this.byTab.values()) {
      const c = m.get(id);
      if (c) return c;
    }
    return undefined;
  }

  /**
   * Apply what inspecting a manifest found: a playlist without an end is live,
   * and a master's variant and rendition playlists get hidden under it.
   */
  learn(id: string, inspection: Inspection): void {
    const c = [...this.byTab.values()].map((m) => m.get(id)).find(Boolean);
    if (!c) return;
    let changed = false;
    if (inspection.live && !c.live) {
      this.markLive(c);
      changed = true;
    }
    if (inspection.children?.length) {
      c.children = inspection.children.map(manifestUrl);
      for (const other of this.byTab.get(c.tabId)?.values() ?? []) {
        if (other === c || other.parentId || !listsChild(c, other.url)) continue;
        other.parentId = c.id;
        if (other.live) c.live = true;
        changed = true;
      }
    }
    if (!changed) return;
    void this.persist();
    void this.badge(c.tabId);
    this.notify(c.tabId);
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
    this.urls.delete(tabId);
    this.shared.delete(tabId);
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
    const tabId = details.tabId;
    const url = kind === 'file' ? details.url : manifestUrl(details.url);
    const tabMap = getOrSet(this.byTab, tabId, () => new Map<string, Candidate>());
    const urls = getOrSet(this.urls, tabId, () => new Map<string, string>());
    const shared = getOrSet(this.shared, tabId, () => new Set<string>());

    const known = tabMap.get(urls.get(url) ?? '');
    if (known) {
      if (known.url === url) return this.touch(known);
      // An older URL of a merged stream came back while the newer one is in use:
      // two streams share this path. Stop merging there; this URL gets its own row.
      shared.add(pathOf(url));
      urls.delete(url);
    } else if (kind !== 'file' && !shared.has(pathOf(url))) {
      const twin = [...tabMap.values()].find((c) => c.kind === kind && sameStream(c.url, url));
      if (twin) {
        // The newest URL carries the freshest token, so downloads use it.
        twin.url = url;
        this.remember(tabId, url, twin.id);
        return this.touch(twin);
      }
    }

    // Firefox says whether the request came from a private window; Chrome only says so on the tab.
    const d = details as unknown as { documentUrl?: string; initiator?: string; incognito?: boolean };
    let pageUrl = '';
    let pageTitle = '';
    let incognito = d.incognito === true;
    try {
      const tab = await browser.tabs.get(tabId);
      pageUrl = tab.url ?? '';
      pageTitle = tab.title ?? '';
      incognito ||= tab.incognito;
    } catch {
      /* tab gone */
    }
    // Firefox gives the full document URL; Chrome only gives the initiator
    // origin, so prefer the tab URL there (CDNs often check the full Referer).
    const referer = d.documentUrl || pageUrl || d.initiator || '';
    let id = candidateId(tabId, url);
    if (tabMap.has(id)) id = candidateId(tabId, `${url}#${Date.now()}`);
    const candidate: Candidate = {
      id,
      tabId,
      url,
      kind,
      mime: mime.split(';')[0]!.trim(),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      pageUrl,
      pageTitle,
      referer: referer || pageUrl,
      seenAt: Date.now(),
    };
    if (incognito) candidate.incognito = true;
    const parent = kind === 'file' ? undefined : [...tabMap.values()].find((m) => listsChild(m, url));
    if (parent) candidate.parentId = parent.id;
    tabMap.set(id, candidate);
    this.remember(tabId, url, id);
    void this.persist();
    if (kind !== 'file') this.onManifest?.(candidate);
    if (parent) return;
    void this.badge(tabId);
    this.notify(tabId);
    // The page usually finishes setting its title shortly after playback starts.
    setTimeout(() => {
      void this.refreshTitles(tabId, true).then((changed) => changed && this.notify(tabId));
    }, 1500);
  }

  /** Another sighting of a known candidate. Manifests that keep reloading are live. */
  private touch(c: Candidate) {
    c.seenAt = Date.now();
    if (c.kind === 'file') return;
    c.reloads = (c.reloads ?? 0) + 1;
    if (c.live || c.reloads < LIVE_RELOADS) return;
    this.markLive(c);
    void this.persist();
    // A live stream is never hidden as archived, so the count can change.
    void this.badge(c.tabId);
    this.notify(c.tabId);
  }

  /** A live variant makes its master live too, since the master is the row the user sees. */
  private markLive(c: Candidate) {
    c.live = true;
    const parent = c.parentId ? this.byTab.get(c.tabId)?.get(c.parentId) : undefined;
    if (parent) parent.live = true;
  }

  private remember(tabId: number, url: string, id: string) {
    const urls = getOrSet(this.urls, tabId, () => new Map<string, string>());
    urls.delete(url);
    urls.set(url, id);
    if (urls.size > MAX_URLS) urls.delete(urls.keys().next().value!);
  }

  /** Recount every tab's badge, e.g. after the archive changed. */
  async rebadgeAll(): Promise<void> {
    await this.restored;
    await Promise.all([...this.byTab.keys()].map((t) => this.badge(t)));
  }

  private notify(tabId: number) {
    const env: Envelope = { magpie: 'ui', event: { type: 'candidates', tabId } };
    browser.runtime.sendMessage(env).catch(() => {});
  }

  private async badge(tabId: number) {
    const n = [...(this.byTab.get(tabId)?.values() ?? [])].filter((c) => !c.parentId && !this.isHidden(c)).length;
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
        getOrSet(this.byTab, c.tabId, () => new Map<string, Candidate>()).set(c.id, c);
        this.remember(c.tabId, c.url, c.id);
      }
    } catch {
      /* nothing saved */
    }
  }
}

/** True when `master` lists `url` as one of its variant or rendition playlists. */
function listsChild(master: Candidate, url: string): boolean {
  return !!master.children?.some((child) => child === manifestUrl(url) || sameStream(child, url));
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}
