import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { api, useArchive, useCandidates, useJobs, useSettings } from '../../src/ui/api';
import { Button, ConfirmButton, DownloadedToggle, Empty, IconButton, Section, Toast } from '../../src/ui/components';
import { CandidateCard, QualitySheet } from '../../src/ui/candidates';
import { JobRow } from '../../src/ui/jobs';
import { HistoryList } from '../../src/ui/history';
import { SettingsPanel } from '../../src/ui/settings';
import { IconPlay, IconSearch, IconSettings, IconX, Logo } from '../../src/ui/icons';
import { shortUrl } from '../../src/ui/format';
import type { Candidate } from '../../src/core/types';

type View = 'page' | 'jobs' | 'history';

/** What "This page" means: one tab, or every tab when the popup is opened as a page of its own. */
type Scope = { all: true; label: string; url?: undefined; tabId?: undefined } | { all: false; label: string; url: string; tabId: number };

const ALL_TABS: Scope = { all: true, label: 'All open tabs' };

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

function Pill({ n, live }: { n: number; live?: boolean }) {
  if (!n) return null;
  return <span className={`pill inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-bold ${live ? 'bg-live text-white' : 'bg-edge2 text-text'}`}>{n}</span>;
}

function Panel({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div hidden={!shown} className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4 scroll-thin">
      {children}
    </div>
  );
}

export function Popup() {
  const [scope, setScope] = useState<Scope | null>(null);
  useEffect(() => {
    void resolveScope().then(setScope);
  }, []);
  const [candidates, refreshCandidates] = useCandidates(scope?.tabId, scope !== null);
  const [showDownloaded, setShowDownloaded] = useState(false);
  // Derived lists are memoized: the popup re-renders with every progress event while something downloads.
  const fresh = useMemo(() => candidates.filter((c) => !c.archived), [candidates]);
  const downloaded = candidates.length - fresh.length;
  const shown = showDownloaded ? candidates : fresh;

  const jobs = useJobs();
  const active = jobs.filter((j) => j.state !== 'error');
  const failed = jobs.filter((j) => j.state === 'error');
  const running = active.filter((j) => j.state === 'downloading' && !j.live).length;
  // Candidates with a job waiting or running, so the card on This page goes gray.
  const queued = new Map(active.map((j) => [j.candidateId, j.id]));
  const recording = active.some((j) => j.live && j.state === 'downloading');
  const [settings] = useSettings();
  const thumbs = settings?.thumbnails ?? true;

  const archive = useArchive();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? archive.filter((e) => e.title.toLowerCase().includes(q) || e.file.toLowerCase().includes(q) || e.page.toLowerCase().includes(q)) : archive), [archive, q]);

  const [view, setView] = useState<View>('page');
  const [sheetId, setSheetId] = useState<string | null>(null);
  /** Opens a card's sheet, or for a gray card shows the job it already has instead of starting a second download. Stable, so memoized cards skip re-rendering. */
  const openCard = useCallback((c: Candidate, queuedJobId?: string) => {
    if (!queuedJobId) {
      setSheetId(c.id);
      return;
    }
    setView('jobs');
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-testid="job"][data-job-id="${queuedJobId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.classList.add('flash');
      row?.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
    });
  }, []);
  const sheet = sheetId ? candidates.find((c) => c.id === sheetId) : undefined;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
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

  const tab = (v: View, label: string, pill: ReactNode) => (
    <button type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition ${view === v ? 'bg-panel2 text-text shadow-[inset_0_1px_0_rgba(255,255,255,.04),0_2px_6px_rgba(0,0,0,.35)] [&_.pill]:bg-shine [&_.pill]:text-shine-ink' : 'text-mute hover:text-text'}`}>
      {label}
      {pill}
    </button>
  );

  return (
    <div className="relative mx-auto flex h-[580px] w-[400px] flex-col overflow-hidden bg-[radial-gradient(900px_300px_at_50%_-120px,rgba(34,211,238,.10),transparent_60%)]">
      <header className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-shine to-indigo-500 text-[#06121a] shadow-[0_2px_10px_rgba(34,211,238,.35)]">
          <Logo />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-wide">Magpie</div>
          <div className="truncate text-[11px] text-mute" title={scope?.url}>
            {scope ? (scope.all ? scope.label : `${shortUrl(scope.url).split('/')[0]} · ${scope.label}`) : ''}
          </div>
        </div>
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)} active={settingsOpen}>
          <IconSettings size={18} />
        </IconButton>
      </header>

      <div role="tablist" className="mx-3.5 mb-2.5 flex rounded-xl border border-edge bg-panel p-[3px]">
        {tab('page', 'This page', <Pill n={fresh.length} />)}
        {tab('jobs', 'Downloads', <Pill n={active.length} live={recording} />)}
        {tab('history', 'History', <Pill n={archive.length} />)}
      </div>

      <Panel shown={view === 'page'}>
        <Section title={scope?.all ? 'Media in open tabs' : 'Media on this page'}>
          <DownloadedToggle count={downloaded} shown={showDownloaded} onToggle={() => setShowDownloaded((v) => !v)} />
          {scope && !scope.all && candidates.length > 0 && (
            <Button tone="ghost" onClick={() => void api.clearCandidates(scope.tabId).then(refreshCandidates)} title="Forget the media seen on this page">
              Clear
            </Button>
          )}
        </Section>
        {shown.length === 0 ? (
          <Empty icon={<IconPlay size={26} />} title={downloaded ? 'Everything here is already downloaded' : 'Nothing detected yet'}>
            {downloaded ? 'Show downloaded media to get it again.' : 'Press play on a video and the stream shows up here.'}
          </Empty>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="mb-2 flex flex-col gap-1.5">
              {scope?.all && (
                <div className="mt-1 truncate text-[11px] text-mute" title={g.page}>
                  {shortUrl(g.page)}
                </div>
              )}
              {g.list.map((c) => (
                <CandidateCard key={c.id} candidate={c} thumbs={thumbs} queuedJobId={queued.get(c.id)} onOpen={openCard} />
              ))}
            </div>
          ))
        )}
      </Panel>

      <Panel shown={view === 'jobs'}>
        <Section title={`Active (${active.length})`}>
          {settings && <span className="text-[11px] font-medium text-dim">{`${running} of ${settings.maxConcurrent} slots`}</span>}
        </Section>
        {active.length === 0 ? (
          <p className="px-1 py-1.5 text-[12px] text-dim">Nothing downloading</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {active.map((j) => (
              <JobRow key={j.id} job={j} thumbs={thumbs} />
            ))}
          </div>
        )}
        {failed.length > 0 && (
          <>
            <Section title={`Failed (${failed.length})`}>
              <Button tone="ghost" onClick={() => void api.clearFailed()} title="Remove failed downloads from the list">
                Clear failed
              </Button>
            </Section>
            <div className="flex flex-col gap-1.5">
              {failed.map((j) => (
                <JobRow key={j.id} job={j} thumbs={thumbs} />
              ))}
            </div>
          </>
        )}
      </Panel>

      <Panel shown={view === 'history'}>
        {archive.length > 0 && (
          <div className="mt-0.5 mb-2 flex h-[34px] items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 text-dim focus-within:border-shine/60">
            <IconSearch />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${archive.length} downloaded videos`} className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-dim [&::-webkit-search-cancel-button]:hidden" />
            {query && (
              <IconButton label="Clear search" onClick={() => setQuery('')} className="size-6">
                <IconX size={14} />
              </IconButton>
            )}
          </div>
        )}
        {archive.length > 0 && (
          <Section title={q ? `${matches.length} of ${archive.length}` : `${archive.length} downloaded`}>
            <ConfirmButton onConfirm={() => void api.clearArchive()} confirm="Click again to clear" title="Forget every download in history. Saved files stay where they are.">
              Clear history
            </ConfirmButton>
          </Section>
        )}
        {archive.length === 0 && <div className="h-2.5" />}
        <HistoryList entries={matches} total={archive.length} query={query} thumbs={thumbs} />
      </Panel>

      {sheet && <QualitySheet key={sheet.id} candidate={sheet} thumbs={thumbs} onClose={() => setSheetId(null)} onStarted={() => (setSheetId(null), setToast('Added to downloads'))} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <Toast message={toast} />
    </div>
  );
}
