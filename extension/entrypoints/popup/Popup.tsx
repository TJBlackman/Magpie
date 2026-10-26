import { useEffect, useState } from 'react';
import { api, openManager, useArchive, useCandidates, useJobs } from '../../src/ui/api';
import { ArchiveList, Button, CandidateRow, ConfirmButton, DownloadedToggle, JobRow } from '../../src/ui/components';
import { isFinished } from '../../src/core/types';

export function Popup() {
  const [tab, setTab] = useState<{ id: number; title: string; url: string } | null>(null);
  useEffect(() => {
    void api.activeTab().then((r) => r.ok && setTab(r.value));
  }, []);
  const [candidates, refreshCandidates] = useCandidates(tab?.id, tab !== null);
  const [showDownloaded, setShowDownloaded] = useState(false);
  const fresh = candidates.filter((c) => !c.archived);
  const downloaded = candidates.length - fresh.length;
  const shown = showDownloaded ? candidates : fresh;
  const jobs = useJobs();
  const active = jobs.filter((j) => !isFinished(j.state));
  const finished = jobs.filter((j) => isFinished(j.state));
  const recent = finished.slice(0, 3);
  const archive = useArchive();

  return (
    <div className="flex w-[380px] flex-col gap-2 p-2">
      <header className="flex items-center gap-2">
        <span className="text-sm font-semibold">Magpie</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-mute" title={tab?.url}>
          {tab?.title ?? ''}
        </span>
        <Button tone="ghost" onClick={openManager}>
          Downloads
        </Button>
        <Button tone="ghost" onClick={() => void api.openSettings()}>
          Settings
        </Button>
      </header>

      <section>
        <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-mute">
          <span className="flex-1">Media on this page ({fresh.length})</span>
          <DownloadedToggle count={downloaded} shown={showDownloaded} onToggle={() => setShowDownloaded((v) => !v)} />
          {tab && candidates.length > 0 && (
            <Button tone="ghost" onClick={() => void api.clearCandidates(tab.id).then(refreshCandidates)}>
              clear
            </Button>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="rounded border border-dashed border-edge p-3 text-center text-mute">
            {downloaded ? 'All media on this page is in your archive.' : 'Nothing yet. Press play on a video and the stream will show up here.'}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {shown.map((c) => (
              <CandidateRow key={c.id} candidate={c} />
            ))}
          </div>
        )}
      </section>

      {(active.length > 0 || recent.length > 0) && (
        <section>
          <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-mute">
            <span>Downloads</span>
            {finished.length > 0 && (
              <Button tone="ghost" onClick={() => void api.clearFinished()} title="Remove failed and cancelled downloads from the list">
                clear finished
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {[...active, ...recent].map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        </section>
      )}

      {archive.length > 0 && (
        <section>
          <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-mute">
            <span>Archive ({archive.length})</span>
            <ConfirmButton onConfirm={() => void api.clearArchive()} confirm="click again to clear" title="Forget every archived download. Saved files stay where they are.">
              clear archive
            </ConfirmButton>
          </div>
          <ArchiveList entries={archive} className="max-h-60 overflow-y-auto" />
        </section>
      )}
    </div>
  );
}
