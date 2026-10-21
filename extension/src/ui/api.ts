import { browser } from 'wxt/browser';
import { useEffect, useState } from 'react';
import type { Candidate, Envelope, Inspection, Job, Result, UiRequest } from '../core/types';

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
};

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

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    void api.jobs().then((r) => r.ok && setJobs(r.value));
  }, []);
  useEvents((e) => {
    if (e.type === 'jobs') setJobs(e.jobs);
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
