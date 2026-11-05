import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { api, openPage, useArchive, useCandidates, useJobs, useSettings, useUpdate } from '../../src/ui/api';
import { Button, ConfirmButton, DownloadedToggle, Empty, IconButton, Section, TextButton, Toast, UpdateBanner } from '../../src/ui/components';
import { CandidateCard, QualitySheet, type CardJob } from '../../src/ui/candidates';
import { GroupRow, JobRow } from '../../src/ui/jobs';
import { HistoryList } from '../../src/ui/history';
import { SettingsPanel } from '../../src/ui/settings';
import { IconCheck, IconChevron, IconDownload, IconError, IconRedo, IconSearch, IconSettings, IconVideo, IconX, Logo } from '../../src/ui/icons';
import { fmtClock, hostOf, jobProgress, shortUrl } from '../../src/ui/format';
import type { Candidate, Job } from '../../src/core/types';
import { SITE_URL } from '../../src/core/update';

type View = 'page' | 'jobs' | 'history';

/** What "This page" means: one tab, or every tab when the popup is opened as a page of its own. */
type Scope = { all: true; label: string; url?: undefined; tabId?: undefined } | { all: false; label: string; url: string; tabId: number };

const ALL_TABS: Scope = { all: true, label: 'All open tabs' };

/** "3 tabs with media", for the header when the popup lists every tab. */
function tabsWithMedia(list: Candidate[]): string {
  const n = new Set(list.map((c) => c.tabId)).size;
  return n ? `${n} ${n === 1 ? 'tab' : 'tabs'} with media` : 'All open tabs';
}

function scopeFor(tab: { id?: number; title?: string; url?: string } | null | undefined): Scope {
  return tab && tab.id !== undefined && tab.url ? { all: false, tabId: tab.id, label: tab.title || tab.url, url: tab.url } : ALL_TABS;
}

/**
 * The toolbar popup shows the active tab. Opened as a page of its own
 * (popup.html in a tab) it shows every tab, or one tab with `?tab=<id>`.
 */
async function resolveScope(): Promise<Scope> {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) return scopeFor(await browser.tabs.get(forced).catch(() => null));
  // getCurrent() is the tab this page lives in, and undefined inside the toolbar popup.
  if (await browser.tabs.getCurrent()) return ALL_TABS;
  const r = await api.activeTab();
  return scopeFor(r.ok ? r.value : null);
}

/** A tab's count, tinted on the selected tab. A failure is an alert mark beside it, announced as "n failed". */
function Pill({ n, failed = 0 }: { n: number; failed?: number }) {
  return (
    <>
      {n > 0 && <span className="pill inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-white/[0.08] px-1.5 text-[10.5px] font-semibold text-mute tabular-nums transition-colors">{n}</span>}
      {failed > 0 && (
        <span role="img" aria-label={`${failed} failed`} title={`${failed} failed`} className="-ml-0.5 flex shrink-0 items-center text-live">
          <IconError size={14} />
        </span>
      )}
    </>
  );
}

/**
 * A tab's scrolling list. A list scrolled down gets a hairline and a short
 * fade under the tab bar; a list with more below fades at the bottom, so a
 * card cut by the edge reads as "more", not as a rendering fault.
 */
function Panel({ shown, children }: { shown: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = { top: el.scrollTop > 0, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1 };
    setEdges((e) => (e.top === next.top && e.bottom === next.bottom ? e : next));
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(measure, [shown, measure]);
  const fade = edges.top && edges.bottom ? 'fade-both' : edges.top ? 'fade-top' : edges.bottom ? 'fade-bottom' : '';
  return (
    <div hidden={!shown} className={`min-h-0 flex-1 border-t transition-colors ${edges.top ? 'border-edge' : 'border-transparent'}`}>
      <div ref={scroller} onScroll={measure} className={`h-full overflow-y-auto px-3.5 pb-4 scroll-thin ${fade}`}>
        <div className="flex min-h-full flex-col">{children}</div>
      </div>
    </div>
  );
}

/** A card's job, if it has one: the job, or for a post the files of it, as one fraction. */
function cardJobs(active: Job[]): Map<string, CardJob> {
  const groups = new Map<string, Job[]>();
  const out = new Map<string, CardJob>();
  for (const j of active) {
    const key = j.group?.candidateId ?? j.candidateId;
    const list = groups.get(key);
    if (list) list.push(j);
    else groups.set(key, [j]);
  }
  for (const [key, list] of groups) {
    const first = list[0]!;
    const queued = list.every((j) => j.state === 'queued');
    let pct: number | null;
    if (first.group) {
      const saved = Math.max(0, ...list.map((j) => j.group?.saved ?? 0));
      pct = (saved + list.reduce((n, j) => n + (jobProgress(j) ?? 0), 0)) / first.group.total;
    } else pct = jobProgress(first);
    out.set(key, { id: first.id, queued, pct, elapsed: first.live ? first.duration : undefined });
  }
  return out;
}

export function Popup() {
  const [scope, setScope] = useState<Scope | null>(null);
  useEffect(() => {
    void resolveScope().then(setScope);
  }, []);
  const [candidates, refreshCandidates] = useCandidates(scope?.tabId, scope !== null);
  const [settings, saveSettings] = useSettings();
  // Media already in history stays on the list, gray with when it was downloaded, unless the user hides it. The choice is kept.
  const showDownloaded = !(settings?.hideDownloaded ?? false);
  const toggleDownloaded = () => settings && void saveSettings({ ...settings, hideDownloaded: showDownloaded });
  // Derived lists are memoized: the popup re-renders with every progress event while something downloads.
  const fresh = useMemo(() => candidates.filter((c) => !c.archived), [candidates]);
  const downloaded = candidates.length - fresh.length;
  const shown = showDownloaded ? candidates : fresh;

  const jobs = useJobs();
  const active = jobs.filter((j) => j.state !== 'error');
  const failed = jobs.filter((j) => j.state === 'error');
  const recordings = active.filter((j) => j.live && j.state !== 'queued');
  // A post's files stay together: the post counts as running while any of its files runs.
  const busyGroups = new Set(active.filter((j) => j.group && j.state !== 'queued').map((j) => j.group!.id));
  const runs = (j: Job) => (j.group ? busyGroups.has(j.group.id) : j.state !== 'queued');
  const running = active.filter((j) => runs(j) && !j.live);
  const waiting = active.filter((j) => !runs(j) && !j.live);
  // Candidates with a job waiting or running: the card on This page steps back and shows the progress. A post's files point back at the post's card.
  const byCard = useMemo(() => cardJobs(active), [active]);
  // The files of one post are one row on Downloads; the others stay rows of their own.
  const rowsOf = (list: Job[]) => {
    const out: ({ group: string; jobs: Job[]; job?: undefined } | { group?: undefined; job: Job })[] = [];
    const seen = new Map<string, Job[]>();
    for (const j of list) {
      if (!j.group) {
        out.push({ job: j });
        continue;
      }
      const g = seen.get(j.group.id);
      if (g) g.push(j);
      else {
        const first = [j];
        seen.set(j.group.id, first);
        out.push({ group: j.group.id, jobs: first });
      }
    }
    return out;
  };
  const recordingJob = active.find((j) => j.live && j.state !== 'queued');
  const recording = !!recordingJob;
  const thumbs = settings?.thumbnails ?? true;
  const update = useUpdate(settings?.updateCheck ?? false);

  const archive = useArchive();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? archive.filter((e) => e.title.toLowerCase().includes(q) || e.file.toLowerCase().includes(q) || e.page.toLowerCase().includes(q)) : archive), [archive, q]);

  const [view, setView] = useState<View>('page');
  const [sheetId, setSheetId] = useState<string | null>(null);
  /** A failed job the open sheet is a second try at: it leaves the list once the new download starts. */
  const [retryOf, setRetryOf] = useState<string | null>(null);
  /** Opens a card's sheet, or for a gray card shows the job it already has instead of starting a second download. Stable, so memoized cards skip re-rendering. */
  const openCard = useCallback((c: Candidate, queuedJobId?: string) => {
    if (!queuedJobId) {
      setSheetId(c.id);
      return;
    }
    setView('jobs');
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-testid="job"][data-job-id="${queuedJobId}"], [data-testid="job-group"][data-jobs~="${queuedJobId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.classList.add('flash');
      row?.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
    });
  }, []);
  // The card's arrow: the best quality now, with a toast to follow it; anything the engine refuses opens the sheet, which says why.
  const quickStart = useCallback(async (c: Candidate) => {
    const r = await api.start(c.id, 'best');
    if (r.ok) setToast({ text: c.live ? 'Recording started' : 'Added to downloads', view: true, undo: r.value.id, live: c.live });
    else setSheetId(c.id);
  }, []);
  const sheet = sheetId ? candidates.find((c) => c.id === sheetId) : undefined;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; view?: boolean; undo?: string; live?: boolean } | null>(null);
  // A toast belongs to the moment: switching views clears it.
  useEffect(() => setToast(null), [view]);
  const onMissing = useCallback(() => setToast({ text: 'That file is no longer in your downloads' }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSheetId(null);
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // In the all tabs view, cards group under the page they play on.
  const all = scope?.all ?? false;
  const groups = useMemo(() => {
    const out: { key: string; page: string; list: Candidate[] }[] = [];
    for (const c of shown) {
      const key = all ? `${c.tabId}|${c.pageUrl}` : '';
      const g = out.find((x) => x.key === key);
      if (g) g.list.push(c);
      else out.push({ key, page: c.pageUrl, list: [c] });
    }
    return out;
  }, [shown, all]);

  const tab = (v: View, label: string, pill: ReactNode, tip?: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => setView(v)}
      title={tip}
      className={`relative flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[9px] px-2 text-[12.5px] whitespace-nowrap transition-colors ${view === v ? 'bg-panel3 font-semibold text-text shadow-[inset_0_1px_0_rgba(255,255,255,.06),0_1px_3px_rgba(0,0,0,.45)] ring-1 ring-btn-edge ring-inset [--tab-bg:var(--color-panel3)] [&_.pill]:bg-shine/[0.16] [&_.pill]:text-[#67e8f9]' : 'font-medium text-mute [--tab-bg:var(--color-panel)] hover:bg-white/[0.03] hover:text-text'}`}
    >
      {label}
      {pill}
    </button>
  );

  const failedRetry = (j: Job) => {
    const id = j.group?.candidateId ?? j.candidateId;
    if (!candidates.some((c) => c.id === id && !c.live)) return undefined;
    return () => {
      setRetryOf(j.id);
      setView('page');
      setSheetId(id);
    };
  };

  return (
    <div data-popup-root className="relative mx-auto flex h-[580px] w-[400px] flex-col overflow-hidden bg-ink bg-[radial-gradient(420px_220px_at_50%_-90px,rgba(34,211,238,.09),transparent_70%)]">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 px-3.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#67e8f9] to-shine text-[#06121a] shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_2px_8px_rgba(34,211,238,.18)]">
          <Logo />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[14px] font-semibold tracking-[0.01em]">Magpie</div>
          <div className="truncate text-[11.5px] text-dim" title={scope && !scope.all ? `${scope.label}\n${scope.url}` : undefined}>
            {scope && (scope.all ? tabsWithMedia(candidates) : hostOf(scope.url))}
          </div>
        </div>
        {recordingJob && view !== 'jobs' && (
          <button
            type="button"
            onClick={() => setView('jobs')}
            title="Recording. Open Downloads"
            className="flex h-7 items-center gap-1.5 rounded-full bg-panel3 pr-2.5 pl-2 text-[11.5px] font-semibold text-text ring-1 ring-edge3 transition-colors ring-inset hover:bg-btn-hover"
          >
            <span className="pulse size-2 rounded-full bg-live" />
            REC <span className="font-medium tabular-nums">{fmtClock(recordingJob.duration ?? 0)}</span>
          </button>
        )}
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)} active={settingsOpen}>
          <IconSettings size={18} />
        </IconButton>
      </header>

      {update.latest && !update.dismissed && <UpdateBanner version={update.latest} onGet={() => openPage(SITE_URL)} onDismiss={update.dismiss} />}

      <div role="tablist" className="mx-3.5 mb-1 grid shrink-0 grid-cols-3 gap-0.5 rounded-xl bg-panel p-[3px] ring-1 ring-edge ring-inset">
        {tab('page', all ? 'All tabs' : 'This page', <Pill n={shown.length} />, downloaded ? `${fresh.length} new, ${downloaded} already downloaded` : undefined)}
        {tab(
          'jobs',
          'Downloads',
          <Pill n={active.length} failed={failed.length} />,
          [recording ? 'Recording' : '', failed.length ? `${failed.length} failed` : ''].filter(Boolean).join(', ') || undefined,
        )}
        {tab('history', 'History', <Pill n={archive.length} />)}
      </div>

      <Panel shown={view === 'page'}>
        {shown.length === 0 ? (
          downloaded ? (
            <>
              <div className="mt-2">
                <DownloadedToggle count={downloaded} shown={showDownloaded} onToggle={toggleDownloaded} />
              </div>
              <Empty icon={<IconCheck size={24} />} title="Everything here is already downloaded">
                Show it to download it again.
              </Empty>
            </>
          ) : (
            <Empty
              icon={<IconVideo size={24} />}
              title="Nothing detected yet"
              below={
                scope && (
                  <div className="flex items-center gap-2 text-[11.5px] text-dim">
                    <span className="relative flex size-2">
                      <span className="ping absolute inline-flex size-full rounded-full bg-shine/70" />
                      <span className="relative inline-flex size-2 rounded-full bg-shine" />
                    </span>
                    {scope.all ? 'Listening on every tab' : `Listening on ${hostOf(scope.url)}`}
                  </div>
                )
              }
              action={
                scope && !scope.all ? (
                  <Button tone="accent" size="md" onClick={() => void browser.tabs.reload(scope.tabId)} title="Reload the page, then press play">
                    <IconRedo size={14} />
                    Reload page
                  </Button>
                ) : undefined
              }
            >
              Press play on a video and the stream shows up here. Already playing? Reload the page.
            </Empty>
          )
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {downloaded > 0 && (
              <div className="-mb-1">
                <DownloadedToggle count={downloaded} shown={showDownloaded} onToggle={toggleDownloaded} />
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key} className="flex flex-col gap-2 first:[&>div:first-child]:mt-0">
                {scope?.all && (
                  <div className="mt-3 mb-0.5 flex items-center gap-2 text-[11.5px]" title={g.page}>
                    <span className="flex size-4 shrink-0 items-center justify-center rounded bg-panel3 text-[9px] font-bold text-mute uppercase ring-1 ring-edge2 ring-inset">{hostOf(g.page).slice(0, 1)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold text-text">{shortUrl(g.page).split('/')[0]}</span>
                      <span className="text-dim">{shortUrl(g.page).slice(shortUrl(g.page).indexOf('/'))}</span>
                    </span>
                    <span className="shrink-0 text-dim tabular-nums">{g.list.length}</span>
                  </div>
                )}
                {g.list.map((c) => (
                  <CandidateCard key={c.id} candidate={c} thumbs={thumbs} job={byCard.get(c.id)} onOpen={openCard} onQuick={quickStart} />
                ))}
              </div>
            ))}
            {scope && !scope.all && (
              <div className="-mr-2 -mt-1 flex justify-end">
                <TextButton onClick={() => void api.clearCandidates(scope.tabId).then(refreshCandidates)} title="Forget the media seen on this page. Playing it again lists it again.">
                  Clear list
                </TextButton>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel shown={view === 'jobs'}>
        {active.length === 0 && failed.length === 0 ? (
          <Empty icon={<IconDownload size={24} />} title="Nothing downloading" action={<Button tone="accent" size="md" onClick={() => setView('page')}>Show media on this page</Button>}>
            Pick a video to download and its progress shows up here.
          </Empty>
        ) : (
          <>
            {active.length === 0 && <p className="mt-3 px-0.5 text-[12px] text-mute">Nothing downloading</p>}
            {recordings.length > 0 && (
              <>
                <Section title="Recording" count={recordings.length} />
                <div className="flex flex-col gap-2">
                  {recordings.map((j) => (
                    <JobRow key={j.id} job={j} thumbs={thumbs} />
                  ))}
                </div>
              </>
            )}
            {running.length > 0 && (
              <>
                <Section title="Downloading" count={running.length}>
                  {settings && (
                    <TextButton onClick={() => setSettingsOpen(true)} title="Change how many downloads run at once, in Settings">
                      {`${settings.maxConcurrent} at a time`}
                      <IconChevron size={12} className="rotate-90" />
                    </TextButton>
                  )}
                </Section>
                <div className="flex flex-col gap-2">
                  {rowsOf(running).map((r) => (r.group !== undefined ? <GroupRow key={r.group} jobs={r.jobs} thumbs={thumbs} /> : <JobRow key={r.job.id} job={r.job} thumbs={thumbs} />))}
                </div>
              </>
            )}
            {waiting.length > 0 && (
              <>
                <Section title="Queued" count={waiting.length} />
                <div className="flex flex-col gap-2">
                  {rowsOf(waiting).map((r) => (r.group !== undefined ? <GroupRow key={r.group} jobs={r.jobs} thumbs={thumbs} /> : <JobRow key={r.job.id} job={r.job} thumbs={thumbs} />))}
                </div>
              </>
            )}
            {failed.length > 0 && (
              <>
                <Section title="Failed" count={failed.length}>
                  <TextButton onClick={() => void api.clearFailed()} title="Remove failed downloads from the list">
                    Clear failed
                  </TextButton>
                </Section>
                <div className="flex flex-col gap-2">
                  {failed.map((j) => (
                    <JobRow key={j.id} job={j} thumbs={thumbs} onRetry={failedRetry(j)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </Panel>

      <Panel shown={view === 'history'}>
        {archive.length > 0 && (
          <>
            <div className="mt-1.5 flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-panel px-3 text-dim ring-1 ring-btn-edge ring-inset outline-offset-2 outline-text has-[:focus-visible]:outline-2">
              <IconSearch size={15} />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search history" aria-label={`Search ${archive.length} downloads`} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-dim [&::-webkit-search-cancel-button]:hidden" />
              {query && (
                <IconButton label="Clear search" onClick={() => setQuery('')} className="-mr-2 size-7">
                  <IconX size={14} />
                </IconButton>
              )}
            </div>
            {q ? <Section title="Matches" count={matches.length} /> : <div className="h-3 shrink-0" />}
          </>
        )}
        <HistoryList entries={matches} total={archive.length} query={query} thumbs={thumbs} onMissing={onMissing} onBrowse={() => setView('page')} />
        {archive.length > 0 && !q && (
          <div className="-mr-2 mt-1 flex justify-end">
            <ConfirmButton onConfirm={() => void api.clearArchive()} confirm="Click again to clear" title="Forget every download in history. Saved files stay where they are.">
              Clear history
            </ConfirmButton>
          </div>
        )}
      </Panel>

      <Toast
        message={toast?.text ?? null}
        live={toast?.live}
        actions={[
          ...(toast?.undo ? [{ label: 'Undo', onClick: () => (void api.cancel(toast.undo!), setToast({ text: toast.live ? 'Recording discarded' : 'Download canceled' })) }] : []),
          ...(toast?.view && view !== 'jobs' ? [{ label: 'View', onClick: () => (setView('jobs'), setToast(null)) }] : []),
        ]}
      />

      {sheet && (
        <QualitySheet
          onMissing={onMissing}
          key={sheet.id}
          candidate={sheet}
          thumbs={thumbs}
          onClose={() => (setSheetId(null), setRetryOf(null))}
          onStarted={(jobId) => {
            if (retryOf) void api.removeJob(retryOf);
            setRetryOf(null);
            setSheetId(null);
            setToast({ text: sheet.live ? 'Recording started' : 'Added to downloads', view: true, undo: jobId, live: sheet.live });
          }}
        />
      )}
      {settingsOpen && <SettingsPanel latest={update.latest} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
