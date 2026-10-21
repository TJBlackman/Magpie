import { useEffect, useState } from 'react';
import { api, openManager, useCandidates, useJobs } from '../../src/ui/api';
import { Button, CandidateRow, JobRow } from '../../src/ui/components';

export function Popup() {
  const [tab, setTab] = useState<{ id: number; title: string; url: string } | null>(null);
  useEffect(() => {
    void api.activeTab().then((r) => r.ok && setTab(r.value));
  }, []);
  const [candidates, refreshCandidates] = useCandidates(tab?.id, tab !== null);
  const jobs = useJobs();
  const active = jobs.filter((j) => !['done', 'error', 'cancelled'].includes(j.state));
  const recent = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.state)).slice(0, 3);

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
          <span>Media on this page ({candidates.length})</span>
          {tab && candidates.length > 0 && (
            <Button tone="ghost" onClick={() => void api.clearCandidates(tab.id).then(refreshCandidates)}>
              clear
            </Button>
          )}
        </div>
        {candidates.length === 0 ? (
          <div className="rounded border border-dashed border-edge p-3 text-center text-mute">
            Nothing yet. Press play on a video and the stream will show up here.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {candidates.map((c) => (
              <CandidateRow key={c.id} candidate={c} />
            ))}
          </div>
        )}
      </section>

      {(active.length > 0 || recent.length > 0) && (
        <section>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-mute">Downloads</div>
          <div className="flex flex-col gap-1">
            {[...active, ...recent].map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
