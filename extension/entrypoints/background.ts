import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { Sniffer } from '../src/background/sniffer';
import { setHeaderRule } from '../src/background/headers';
import { err, ok, type EngineRequest, type Envelope, type Job, type Result, type UiRequest } from '../src/core/types';

export default defineBackground(() => {
  const sniffer = new Sniffer();
  sniffer.listen();

  let latestJobs: Job[] = [];

  // Firefox (MV2, persistent page): the engine runs right here.
  // Chrome (MV3): the engine runs in an offscreen document; we forward.
  let direct: ((req: EngineRequest) => Promise<Result<unknown>>) | null = null;
  if (import.meta.env.FIREFOX) {
    void (async () => {
      const { hostEngine, handle, broadcastJobs } = await import('../src/engine/host');
      const engine = hostEngine({
        setHeaderRule,
        saveBlob: (blobUrl, filename) => saveBlob(blobUrl, filename),
        jobsChanged: (jobs) => {
          latestJobs = jobs;
          broadcastJobs(jobs);
        },
      });
      direct = (req) => handle(engine, req);
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

  async function saveBlob(blobUrl: string, filename: string): Promise<number | undefined> {
    try {
      return await browser.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      console.error('download failed', e);
      throw e;
    }
  }

  async function handleUi(req: UiRequest): Promise<Result<unknown>> {
    switch (req.type) {
      case 'activeTab': {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return ok(tab ? { id: tab.id, title: tab.title, url: tab.url } : null);
      }
      case 'candidates':
        return ok(await sniffer.forTab(req.tabId));
      case 'clearCandidates':
        sniffer.clear(req.tabId);
        return ok(null);
      case 'inspect': {
        const c = (await sniffer.forTab()).find((x) => x.id === req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        return toEngine({ type: 'inspect', candidate: c });
      }
      case 'start': {
        const c = (await sniffer.forTab()).find((x) => x.id === req.candidateId);
        if (!c) return err('Candidate no longer known (tab navigated?).');
        return toEngine({ type: 'start', candidate: c, variantId: req.variantId });
      }
      case 'cancel':
        return toEngine({ type: 'cancel', jobId: req.jobId });
      case 'removeJob':
        return toEngine({ type: 'removeJob', jobId: req.jobId });
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
