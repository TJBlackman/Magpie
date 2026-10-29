import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { Sniffer } from '../src/background/sniffer';
import { setHeaderRule } from '../src/background/headers';
import { pageTitleFor } from '../src/background/pagetitle';
import { collectTab, mayHoldPosts, readPosts } from '../src/background/reddit';
import { Archive } from '../src/background/archive';
import { assetPaths, sidecar, type RedditPost } from '../src/core/reddit';
import type { ArchiveEntry } from '../src/core/archive';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, type Settings } from '../src/core/settings';
import { pickThumbs, withoutThumb, type ThumbMap } from '../src/core/thumbs';
import { UPDATE_KEY, VERSION_URL, checkDue, normalizeUpdate, parseVersionFile, type UpdateState } from '../src/core/update';
import { err, ok, type Candidate, type EngineRequest, type Envelope, type Inspection, type Job, type Result, type UiRequest } from '../src/core/types';

export default defineBackground(() => {
  const sniffer = new Sniffer();
  sniffer.listen();

  // Media already in the archive is left out of the badge and flagged for the UI.
  const archive = new Archive();
  sniffer.isHidden = (c, shown) => archive.has(c, shown);
  archive.onChange = (entries) => {
    // Without thumbnails: 500 entries with frames would be over a megabyte per change.
    const env: Envelope = { magpie: 'ui', event: { type: 'archive', entries: entries.map(withoutThumb) } };
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

  /** A finished download from the engine. One from a private window that closed meanwhile is forgotten at once. A post's entry also gets its sidecar written. */
  async function archiveFinished(entry: ArchiveEntry): Promise<boolean> {
    void writeSidecar(entry.id);
    const added = await archive.add(entry);
    if (entry.priv) await forgetPrivateIfClosed();
    return added;
  }

  /*
   * A post's metadata goes beside its files as post.json, written once the
   * last file is saved: the engine then reports the post's history entry,
   * whose id is the group's. Until then the post waits here. `seen` turns on
   * once the group's jobs have been listed, so a group that later leaves the
   * list without finishing (cancelled, or its failed file removed) is dropped.
   */
  type PendingSidecar = { post: RedditPost; paths: string[]; seen: boolean };
  const sidecars = new Map<string, PendingSidecar>();
  const SIDECARS_KEY = 'sidecars';
  const sessionStore = (browser.storage as unknown as { session?: chrome.storage.StorageArea }).session;
  /** A Chrome service worker restarts between a file's save and the archive message now and then; the pending sidecars survive in storage.session. */
  const sidecarsReady = (async () => {
    try {
      const saved = ((await sessionStore?.get(SIDECARS_KEY)) as Record<string, Record<string, PendingSidecar>> | undefined)?.[SIDECARS_KEY];
      for (const [id, s] of Object.entries(saved ?? {})) if (!sidecars.has(id)) sidecars.set(id, s);
    } catch {
      /* nothing saved */
    }
  })();
  function persistSidecars() {
    void sessionStore?.set({ [SIDECARS_KEY]: Object.fromEntries(sidecars) }).catch(() => {});
  }

  async function writeSidecar(groupId: string) {
    await sidecarsReady;
    const s = sidecars.get(groupId);
    if (!s) return;
    sidecars.delete(groupId);
    persistSidecars();
    const { filename, json } = sidecar(s.post, s.paths, new Date());
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    try {
      await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      console.error('sidecar failed', filename, e);
    }
  }

  function pruneSidecars(jobs: Job[]) {
    if (!sidecars.size) return;
    const live = new Set(jobs.map((j) => j.group?.id));
    let changed = false;
    for (const [id, s] of sidecars) {
      if (live.has(id)) {
        changed ||= !s.seen;
        s.seen = true;
      } else if (s.seen) {
        sidecars.delete(id);
        changed = true;
      }
    }
    if (changed) persistSidecars();
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
    void checkForUpdate().catch(() => {});
  });

  /*
   * Update check: on start and whenever a popup opens, read version.json if the
   * last read is 12 hours old (30 minutes after one that failed). Off in Settings
   * means no request at all. The popup decides whether the answer is news.
   */
  let updateCheck: Promise<void> | null = null;
  function checkForUpdate(): Promise<void> {
    updateCheck ??= readVersionFile().finally(() => (updateCheck = null));
    return updateCheck;
  }
  async function readVersionFile() {
    await settingsReady;
    if (!settings.updateCheck) return;
    const prev = normalizeUpdate(((await browser.storage.local.get(UPDATE_KEY)) as Record<string, unknown>)[UPDATE_KEY]);
    const now = Date.now();
    if (!checkDue(prev, now)) return;
    const latest = await fetch(VERSION_URL, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then(parseVersionFile)
      .catch(() => null);
    const next: UpdateState = latest ? { checkedAt: now, ok: true, latest } : { ...prev, checkedAt: now, ok: false };
    await browser.storage.local.set({ [UPDATE_KEY]: next });
  }
  void checkForUpdate().catch(() => {});

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
          pruneSidecars(jobs);
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

  // Inspect each new HLS or DASH manifest right away: a master's variant
  // playlists and the files an MPD lists then fold under it, and a playlist
  // without an end shows as live. The engine keeps the result, so expanding
  // the row later costs nothing.
  sniffer.onManifest = (c) => {
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

  /*
   * Thumbnails are captured for the candidates a popup shows, one at a time,
   * at most once per stream, and only while the setting is on. A list request
   * replaces the pending set, so closing the popup stops the work soon after.
   */
  /** Streams whose capture failed, with when: tried again after a minute, since the cause is often a link that expired or an engine still starting. */
  const thumbFailed = new Map<string, number>();
  const THUMB_RETRY = 60_000;
  let thumbPending: Candidate[] = [];
  let thumbInFlight: string | null = null;
  let thumbBusy = false;

  function wantThumbs(list: Candidate[]) {
    if (!settings.thumbnails) return;
    // A post's tile is its preview image from the page; there is no stream to sample.
    thumbPending = list.filter((c) => !c.thumb && c.kind !== 'post' && !c.archived && Date.now() - (thumbFailed.get(c.id) ?? 0) > THUMB_RETRY && c.id !== thumbInFlight);
    void drainThumbs();
  }

  /*
   * Reddit posts come from the page, not from requests: whenever a popup asks
   * for a tab's list, the tab's posts are read and merged in as rows. Reading
   * a feed costs one script run of a few milliseconds.
   */
  async function collectPosts(tabId: number | undefined) {
    const tabs = tabId !== undefined ? [tabId] : (await browser.tabs.query({}).catch(() => [])).filter((t) => mayHoldPosts(t.url)).map((t) => t.id!);
    await Promise.all(
      tabs.map(async (t) => {
        const rows = await collectTab(t).catch(() => null);
        if (rows) await sniffer.setPosts(t, rows);
      }),
    );
  }

  /**
   * Start every file of a post, one job each, in a group. The page is read
   * again first: packaged MP4 links expire within hours, and the row may be
   * older than that. A tab that moved on keeps the row's own list.
   */
  async function startPost(c: Candidate, settings: Settings): Promise<Result<unknown>> {
    let post: RedditPost | undefined = c.post;
    const tab = await browser.tabs.get(c.tabId).catch(() => null);
    if (tab?.url && mayHoldPosts(tab.url)) {
      const fresh = (await readPosts(c.tabId, tab.url)).find((p) => p.permalink === c.url);
      if (fresh?.assets.length) post = fresh;
    }
    if (!post?.assets.length) return err(post?.note ?? 'Nothing to save for this post.');
    const paths = assetPaths(post);
    const groupId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const title = post.title || c.pageTitle;
    const group = { id: groupId, total: post.assets.length, candidateId: c.id, post: { url: c.url, pageUrl: c.pageUrl, pageTitle: title, incognito: c.incognito, kind: c.kind, thumb: c.thumb } };
    // Listed before the first job starts, so a post whose files save at once still gets its sidecar.
    await sidecarsReady;
    sidecars.set(groupId, { post, paths, seen: false });
    persistSidecars();
    let first: Result<unknown> | null = null;
    const started: string[] = [];
    for (const [i, a] of post.assets.entries()) {
      const one: Candidate = {
        id: `${c.id}~${i}`,
        tabId: c.tabId,
        url: a.url,
        kind: a.kind,
        mime: a.mime,
        contentLength: null,
        pageUrl: c.pageUrl,
        pageTitle: title,
        referer: c.pageUrl,
        seenAt: Date.now(),
        saveAs: paths[i],
        group: { ...group, index: i },
      };
      if (c.incognito) one.incognito = true;
      if (c.thumb) one.thumb = c.thumb;
      const r = await toEngine({ type: 'start', candidate: one, variantId: a.kind === 'file' ? 'file' : 'best', settings });
      first ??= r;
      if (!r.ok) {
        // A post is all or nothing: the files already queued would never complete the group.
        sidecars.delete(groupId);
        persistSidecars();
        for (const jobId of started) await toEngine({ type: 'cancel', jobId }).catch(() => {});
        return r;
      }
      started.push((r.value as Job).id);
    }
    return first ?? err('Nothing to save for this post.');
  }

  async function drainThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbPending.length && settings.thumbnails) {
        const c = thumbPending.shift()!;
        thumbInFlight = c.id;
        const r = await toEngine({ type: 'thumbnail', candidate: c }).catch((e) => err(String(e)));
        thumbInFlight = null;
        if (r.ok && typeof r.value === 'string') sniffer.setThumb(c.id, r.value);
        else thumbFailed.set(c.id, Date.now());
      }
    } finally {
      thumbBusy = false;
    }
  }

  async function handleUi(req: UiRequest): Promise<Result<unknown>> {
    switch (req.type) {
      case 'activeTab': {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return ok(tab ? { id: tab.id, title: tab.title, url: tab.url } : null);
      }
      case 'candidates': {
        await Promise.all([sniffer.refreshTitles(req.tabId), collectPosts(req.tabId)]);
        await archive.ready;
        const list = await sniffer.forTab(req.tabId);
        const byTab = new Map<number, Candidate[]>();
        for (const c of list) byTab.set(c.tabId, [...(byTab.get(c.tabId) ?? []), c]);
        const shown = list.map((c) => (archive.has(c, byTab.get(c.tabId)) ? { ...c, archived: true } : c));
        wantThumbs(shown);
        return ok(shown);
      }
      case 'archive':
        return ok(await archive.list());
      case 'removeArchive':
        await archive.remove(req.id);
        return ok(null);
      case 'clearArchive':
        await archive.clear();
        return ok(null);
      case 'clearCandidates':
        sniffer.clear(req.tabId);
        return ok(null);
      case 'inspect': {
        const c = await sniffer.get(req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        if (c.kind === 'post') {
          // The sheet lists the post's files, read only; there is nothing to fetch.
          const post = c.post;
          const inspection: Inspection = {
            candidateId: c.id,
            kind: 'post',
            variants: (post?.assets ?? []).map((a, i) => ({ id: String(i), label: a.label, uri: a.url })),
            notes: post?.note ? [post.note] : [],
          };
          return ok(inspection);
        }
        return toEngine({ type: 'inspect', candidate: c });
      }
      case 'start': {
        const c = await sniffer.get(req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        await settingsReady;
        if (c.kind === 'post') return startPost(c, settings);
        const pageTitle = (await pageTitleFor(c)) || c.pageTitle;
        return toEngine({ type: 'start', candidate: { ...c, pageTitle }, variantId: req.variantId, settings });
      }
      case 'cancel':
        return toEngine({ type: 'cancel', jobId: req.jobId });
      case 'stop':
        return toEngine({ type: 'stop', jobId: req.jobId });
      case 'removeJob':
        return toEngine({ type: 'removeJob', jobId: req.jobId });
      case 'clearFailed':
        return toEngine({ type: 'clearFailed' });
      case 'jobs': {
        if (!import.meta.env.FIREFOX && !(await offscreenExists())) return ok(latestJobs);
        return toEngine({ type: 'jobs' });
      }
      case 'thumbs': {
        const out: ThumbMap = { jobs: {}, archive: {} };
        if (req.jobs?.length) {
          const r = await handleUi({ type: 'jobs' });
          if (r.ok) out.jobs = pickThumbs(r.value as Job[], req.jobs);
        }
        if (req.archive?.length) out.archive = pickThumbs(await archive.list(), req.archive);
        return ok(out);
      }
      case 'checkUpdate':
        void checkForUpdate().catch(() => {});
        return ok(null);
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
        pruneSidecars(r.jobs);
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
