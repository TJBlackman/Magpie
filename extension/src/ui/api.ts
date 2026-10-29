import { browser } from 'wxt/browser';
import { useEffect, useRef, useState } from 'react';
import type { Candidate, Envelope, Inspection, Job, Result, UiRequest } from '../core/types';
import { SETTINGS_KEY, normalizeSettings, type Settings } from '../core/settings';
import { DISMISSED_KEY, UPDATE_KEY, normalizeUpdate, updateFor } from '../core/update';
import type { ArchiveEntry } from '../core/archive';
import type { ThumbMap } from '../core/thumbs';
import { ThumbCache } from './thumbs';

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
  stop: (jobId: string) => call<null>({ type: 'stop', jobId }),
  removeJob: (jobId: string) => call<null>({ type: 'removeJob', jobId }),
  clearFailed: () => call<null>({ type: 'clearFailed' }),
  jobs: () => call<Job[]>({ type: 'jobs' }),
  archive: () => call<ArchiveEntry[]>({ type: 'archive' }),
  removeArchive: (id: string) => call<null>({ type: 'removeArchive', id }),
  clearArchive: () => call<null>({ type: 'clearArchive' }),
  thumbs: (ids: { jobs?: string[]; archive?: string[] }) => call<ThumbMap>({ type: 'thumbs', ...ids }),
  checkUpdate: () => call<null>({ type: 'checkUpdate' }),
};

/** A storage.local value, or undefined until loaded. Follows changes made elsewhere. */
function useStored(key: string): unknown {
  const [value, setValue] = useState<unknown>(undefined);
  useEffect(() => {
    void browser.storage.local.get(key).then((r) => setValue((r as Record<string, unknown>)[key] ?? null));
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[key]) setValue(changes[key].newValue ?? null);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [key]);
  return value;
}

/**
 * A newer version than the installed one, or null. `dismissed` is true once the
 * user closed the banner for that version; the next version shows it again.
 * While enabled, asks the background to check, which it does at most every 12 hours.
 */
export function useUpdate(enabled: boolean): { latest: string | null; dismissed: boolean; dismiss: () => void } {
  const state = useStored(UPDATE_KEY);
  const dismissedVersion = useStored(DISMISSED_KEY);
  useEffect(() => {
    if (enabled) void api.checkUpdate();
  }, [enabled]);
  const latest = enabled && state !== undefined ? updateFor(normalizeUpdate(state), browser.runtime.getManifest().version) : null;
  const dismiss = () => {
    if (latest) void browser.storage.local.set({ [DISMISSED_KEY]: latest });
  };
  return { latest, dismissed: latest !== null && dismissedVersion === latest, dismiss };
}

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

type UiEvent = Extract<Envelope, { magpie: 'ui' }>['event'];

/**
 * Subscribe to broadcast events from the background / engine. The listener is
 * added once; the handler is read through a ref, so a new closure each render
 * does not remove and re-add the listener several times a second.
 */
export function useEvents(handler: (event: UiEvent) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as Envelope;
      if (msg && msg.magpie === 'ui') latest.current(msg.event);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
}

/*
 * Thumbnails come with list answers and never with change events, which fire
 * several times a second while something downloads. These caches live as long
 * as the popup and fill rows from events; a row they have never seen is asked
 * about once.
 */
const jobThumbs = new ThumbCache();
const archiveThumbs = new ThumbCache();

/** Running jobs first (oldest first), then the queue in order, then failed jobs newest first. */
export function orderJobs(jobs: Job[]): Job[] {
  const rank = (j: Job) => (j.state === 'queued' ? 1 : j.state === 'error' ? 2 : 0);
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
  const apply = (rows: Job[]) => {
    const filled = jobThumbs.fill(rows);
    setJobs(orderJobs(filled));
    const ids = jobThumbs.missing(filled);
    if (!ids.length) return;
    void api.thumbs({ jobs: ids }).then((r) => {
      if (!r.ok) return;
      jobThumbs.learn(r.value.jobs);
      setJobs((cur) => jobThumbs.fill(cur));
    });
  };
  useEffect(() => {
    void api.jobs().then((r) => r.ok && apply(r.value));
  }, []);
  useEvents((e) => {
    if (e.type === 'jobs') apply(e.jobs);
  });
  return jobs;
}

export function useCandidates(tabId: number | undefined, enabled = true): [Candidate[], () => void] {
  const [list, setList] = useState<Candidate[]>([]);
  const seq = useRef(0);
  const refresh = () => {
    if (!enabled) return;
    // Only the newest request may update the list, so a slow older answer
    // cannot bring back items the user just cleared.
    const mine = ++seq.current;
    void api.candidates(tabId).then((r) => r.ok && mine === seq.current && setList(r.value));
  };
  useEffect(refresh, [tabId, enabled]);
  useEvents((e) => {
    if (e.type === 'candidates' && (tabId === undefined || e.tabId === tabId)) refresh();
    // The archive decides which candidates count as already downloaded.
    if (e.type === 'archive') refresh();
  });
  return [list, refresh];
}

/** Archive entries, newest first, following changes. */
export function useArchive(): ArchiveEntry[] {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const apply = (rows: ArchiveEntry[]) => {
    const filled = archiveThumbs.fill(rows);
    setEntries(filled);
    const ids = archiveThumbs.missing(filled);
    if (!ids.length) return;
    void api.thumbs({ archive: ids }).then((r) => {
      if (!r.ok) return;
      archiveThumbs.learn(r.value.archive);
      setEntries((cur) => archiveThumbs.fill(cur));
    });
  };
  useEffect(() => {
    void api.archive().then((r) => r.ok && apply(r.value));
  }, []);
  useEvents((e) => {
    if (e.type === 'archive') apply(e.entries);
  });
  return entries;
}

/** Open a page the archive links to in a new tab. */
export function openPage(url: string) {
  void browser.tabs.create({ url });
}
