import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { Sniffer } from '../src/background/sniffer';
import { setHeaderRule } from '../src/background/headers';
import { pageTitleFor } from '../src/background/pagetitle';
import { Archive } from '../src/background/archive';
import type { ArchiveEntry } from '../src/core/archive';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, type Settings } from '../src/core/settings';
import { err, ok, type Candidate, type EngineRequest, type Envelope, type Inspection, type Job, type Result, type UiRequest } from '../src/core/types';

export default defineBackground(() => {
  const sniffer = new Sniffer();
  sniffer.listen();

  // Media already in the archive is left out of the badge and flagged for the UI.
  const archive = new Archive();
  sniffer.isHidden = (c, shown) => archive.has(c, shown);
  archive.onChange = (entries) => {
    const env: Envelope = { magpie: 'ui', event: { type: 'archive', entries } };
    browser.runtime.sendMessage(env).catch(() => {});
    void sniffer.rebadgeAll();
  };
  void archive.ready.then(() => sniffer.rebadgeAll());

  // Private window entries go with the last private window, like the rest of private browsing.
  async function forgetPrivateIfClosed() {
    const windows = await browser.windows.getAll().catch(() => null);
    if (windows && !windows.some((w) => w.incognito)) await archive.forgetPrivate();
  }
  browser.windows.onRemoved.addListener(() => void forgetPrivateIfClosed());
  void archive.ready.then(forgetPrivateIfClosed);

  /** A finished download from the engine. One from a private window that closed meanwhile is forgotten at once. */
  async function archiveFinished(entry: ArchiveEntry): Promise<boolean> {
    const added = await archive.add(entry);
    if (entry.priv) await forgetPrivateIfClosed();
    return added;
  }

  let latestJobs: Job[] = [];

  let settings: Settings = DEFAULT_SETTINGS;
  const settingsReady = browser.storage.local
    .get(SETTINGS_KEY)
    .then((r) => void (settings = normalizeSettings((r as Record<string, unknown>)[SETTINGS_KEY])))
    .catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    void pushSettings();
    void archive.configure(settings).then(forgetPrivateIfClosed);
  });

  /** Tell a running engine about new settings. A Chrome engine that is not up yet gets them with its next start. */
  async function pushSettings() {
    if (direct) await direct({ type: 'configure', settings });
    else if (!import.meta.env.FIREFOX && (await offscreenExists())) await toEngine({ type: 'configure', settings });
  }

  // Firefox (MV2, persistent page): the engine runs right here.
  // Chrome (MV3): the engine runs in an offscreen document; we forward.
  let direct: ((req: EngineRequest) => Promise<Result<unknown>>) | null = null;
  if (import.meta.env.FIREFOX) {
    void (async () => {
      const { hostEngine, handle, broadcastJobs } = await import('../src/engine/host');
      const engine = hostEngine({
        setHeaderRule,
        saveBlob: (blobUrl, filename) => saveBlob(blobUrl, filename),
        whenSaved: (id) => downloadSettled(id),
        jobsChanged: (jobs) => {
          latestJobs = jobs;
          broadcastJobs(jobs);
        },
        archive: archiveFinished,
      });
      direct = (req) => handle(engine, req);
      await settingsReady;
      engine.configure(settings);
    })();
  }

  async function toEngine(req: EngineRequest): Promise<Result<unknown>> {
    if (direct) return direct(req);
    if (import.meta.env.FIREFOX) return err('Engine still starting, try again.');
    await ensureOffscreen();
    const env: Envelope = { magpie: 'engine', req };
    const res = (await browser.runtime.sendMessage(env)) as Result<unknown> | undefined;
    return res ?? err('Engine did not answer.');
  }

  // Inspect each new HLS manifest right away: a master's variant playlists then
  // fold under it, and a playlist without an end shows as live. The engine keeps
  // the result, so expanding the row later costs nothing.
  sniffer.onManifest = (c) => {
    if (c.kind !== 'hls') return;
    toEngine({ type: 'inspect', candidate: c })
      .then((r) => r.ok && sniffer.learn(c.id, r.value as Inspection))
      .catch(() => {});
  };

  async function saveBlob(blobUrl: string, filename: string): Promise<number | undefined> {
    try {
      return await browser.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      console.error('download failed', e);
      throw e;
    }
  }

  /** Resolves when a download is no longer in progress. */
  function downloadSettled(id: number): Promise<void> {
    return new Promise((resolve) => {
      const check = async () => {
        const [d] = await browser.downloads.search({ id }).catch(() => []);
        if (d && d.state === 'in_progress') return false;
        browser.downloads.onChanged.removeListener(onChanged);
        resolve();
        return true;
      };
      const onChanged = (delta: { id: number; state?: { current?: string } }) => {
        if (delta.id === id && delta.state?.current && delta.state.current !== 'in_progress') void check();
      };
      browser.downloads.onChanged.addListener(onChanged);
      void check();
    });
  }

  async function handleUi(req: UiRequest): Promise<Result<unknown>> {
    switch (req.type) {
      case 'activeTab': {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return ok(tab ? { id: tab.id, title: tab.title, url: tab.url } : null);
      }
      case 'candidates': {
        await sniffer.refreshTitles(req.tabId);
        await archive.ready;
        const list = await sniffer.forTab(req.tabId);
        const byTab = new Map<number, Candidate[]>();
        for (const c of list) byTab.set(c.tabId, [...(byTab.get(c.tabId) ?? []), c]);
        return ok(list.map((c) => (archive.has(c, byTab.get(c.tabId)) ? { ...c, archived: true } : c)));
      }
      case 'archive':
        return ok(await archive.list());
      case 'removeArchive':
        await archive.remove(req.id);
        return ok(null);
      case 'clearArchive':
        await archive.clear();
        return ok(null);
      case 'openSettings':
        await browser.runtime.openOptionsPage();
        return ok(null);
      case 'clearCandidates':
        sniffer.clear(req.tabId);
        return ok(null);
      case 'inspect': {
        const c = await sniffer.get(req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        return toEngine({ type: 'inspect', candidate: c });
      }
      case 'start': {
        const c = await sniffer.get(req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        const pageTitle = (await pageTitleFor(c)) || c.pageTitle;
        await settingsReady;
        return toEngine({ type: 'start', candidate: { ...c, pageTitle }, variantId: req.variantId, settings });
      }
      case 'cancel':
        return toEngine({ type: 'cancel', jobId: req.jobId });
      case 'stop':
        return toEngine({ type: 'stop', jobId: req.jobId });
      case 'removeJob':
        return toEngine({ type: 'removeJob', jobId: req.jobId });
      case 'clearFinished':
        return toEngine({ type: 'clearFinished' });
      case 'jobs': {
        if (!import.meta.env.FIREFOX && !(await offscreenExists())) return ok(latestJobs);
        return toEngine({ type: 'jobs' });
      }
    }
  }

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as Envelope;
    if (!msg || typeof msg !== 'object') return;
    if (msg.magpie === 'bg') {
      handleUi(msg.req)
        .then(sendResponse)
        .catch((e) => sendResponse(err(String(e))));
      return true;
    }
    if (msg.magpie === 'engine-to-bg') {
      const r = msg.req;
      if (r.type === 'saveBlob') {
        saveBlob(r.blobUrl, r.filename)
          .then((id) => sendResponse(ok(id)))
          .catch((e) => sendResponse(err(String(e))));
        return true;
      }
      if (r.type === 'headerRule') {
        setHeaderRule(r.host, r.referer, r.origin)
          .then(() => sendResponse(ok(null)))
          .catch((e) => sendResponse(err(String(e))));
        return true;
      }
      if (r.type === 'jobsChanged') {
        latestJobs = r.jobs;
        sendResponse(ok(null));
      }
      if (r.type === 'archive') {
        archiveFinished(r.entry)
          .then((added) => sendResponse(ok(added)))
          .catch((e) => sendResponse(err(String(e))));
        return true;
      }
    }
  });

  /* Chrome offscreen document lifecycle */
  const OFFSCREEN_URL = 'offscreen.html';
  let creating: Promise<void> | null = null;

  async function offscreenExists(): Promise<boolean> {
    const rt = browser.runtime as unknown as { getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]> };
    if (!rt.getContexts) return false;
    const ctxs = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }

  async function ensureOffscreen(): Promise<void> {
    if (await offscreenExists()) return;
    if (!creating) {
      const offscreen = (browser as unknown as { offscreen: typeof chrome.offscreen }).offscreen;
      creating = offscreen
        .createDocument({
          url: OFFSCREEN_URL,
          reasons: ['BLOBS' as chrome.offscreen.Reason, 'WORKERS' as chrome.offscreen.Reason],
          justification: 'Downloads, decrypts and muxes video segments; builds the blob handed to the downloads API.',
        })
        .catch((e: unknown) => {
          // "Only a single offscreen document may be created" means a race; fine.
          if (!String(e).includes('single offscreen')) throw e;
        })
        .finally(() => {
          creating = null;
        });
    }
    await creating;
  }

  if (!import.meta.env.FIREFOX) {
    browser.runtime.onStartup.addListener(() => void ensureOffscreen());
    browser.runtime.onInstalled.addListener(() => void ensureOffscreen());
    void ensureOffscreen();
  }
});
