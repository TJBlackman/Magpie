import { browser } from 'wxt/browser';
import { useEffect, useState } from 'react';
import type { Candidate, Envelope, Inspection, Job, Result, UiRequest } from '../core/types';
import { SETTINGS_KEY, normalizeSettings, type Settings } from '../core/settings';

export async function call<T>(req: UiRequest): Promise<Result<T>> {
  const env: Envelope = { magpie: 'bg', req };
  try {
    const res = (await browser.runtime.sendMessage(env)) as Result<T> | undefined;
    return res ?? { ok: false, error: 'No response from background.' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export const api = {
  activeTab: () => call<{ id: number; title: string; url: string } | null>({ type: 'activeTab' }),
  candidates: (tabId?: number) => call<Candidate[]>({ type: 'candidates', tabId }),
  clearCandidates: (tabId: number) => call<null>({ type: 'clearCandidates', tabId }),
  inspect: (candidateId: string) => call<Inspection>({ type: 'inspect', candidateId }),
  start: (candidateId: string, variantId: string) => call<Job>({ type: 'start', candidateId, variantId }),
  cancel: (jobId: string) => call<null>({ type: 'cancel', jobId }),
  removeJob: (jobId: string) => call<null>({ type: 'removeJob', jobId }),
  jobs: () => call<Job[]>({ type: 'jobs' }),
  openSettings: () => call<null>({ type: 'openSettings' }),
};

/** Current settings plus a saver. null until loaded. Follows changes made elsewhere. */
export function useSettings(): [Settings | null, (next: Settings) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void browser.storage.local.get(SETTINGS_KEY).then((r) => setSettings(normalizeSettings((r as Record<string, unknown>)[SETTINGS_KEY])));
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[SETTINGS_KEY]) setSettings(normalizeSettings(changes[SETTINGS_KEY].newValue));
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);
  const save = async (next: Settings) => {
    const clean = normalizeSettings(next);
    setSettings(clean);
    await browser.storage.local.set({ [SETTINGS_KEY]: clean });
  };
  return [settings, save];
}

/** Subscribe to broadcast events from the background / engine. */
export function useEvents(handler: (event: Extract<Envelope, { magpie: 'ui' }>['event']) => void) {
  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as Envelope;
      if (msg && msg.magpie === 'ui') handler(msg.event);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [handler]);
}

/** Running jobs first (oldest first), then the queue in order, then finished jobs newest first. */
export function orderJobs(jobs: Job[]): Job[] {
  const rank = (j: Job) => (j.state === 'queued' ? 1 : ['done', 'error', 'cancelled'].includes(j.state) ? 2 : 0);
  return [...jobs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 0) return a.startedAt - b.startedAt;
    if (rank(a) === 1) return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
    return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
  });
}

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    void api.jobs().then((r) => r.ok && setJobs(orderJobs(r.value)));
  }, []);
  useEvents((e) => {
    if (e.type === 'jobs') setJobs(orderJobs(e.jobs));
  });
  return jobs;
}

export function useCandidates(tabId: number | undefined, enabled = true): [Candidate[], () => void] {
  const [list, setList] = useState<Candidate[]>([]);
  const refresh = () => {
    if (!enabled) return;
    void api.candidates(tabId).then((r) => r.ok && setList(r.value));
  };
  useEffect(refresh, [tabId, enabled]);
  useEvents((e) => {
    if (e.type === 'candidates' && (tabId === undefined || e.tabId === tabId)) refresh();
  });
  return [list, refresh];
}

export function openManager() {
  void browser.tabs.create({ url: browser.runtime.getURL('/manager.html') });
}

export function showDownload(downloadId: number) {
  void browser.downloads.show(downloadId);
}
