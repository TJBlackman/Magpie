import { useState } from 'react';
import { api, useArchive, useCandidates, useJobs } from '../../src/ui/api';
import { ArchiveList, Button, CandidateRow, ConfirmButton, DownloadedToggle, JobRow } from '../../src/ui/components';
import { shortUrl } from '../../src/ui/format';
import { isFinished, type Candidate } from '../../src/core/types';

export function Manager() {
  const jobs = useJobs();
  const archive = useArchive();
  const [candidates] = useCandidates(undefined);
  const [showDownloaded, setShowDownloaded] = useState(false);
  const fresh = candidates.filter((c) => !c.archived);
  const downloaded = candidates.length - fresh.length;
  const finished = jobs.filter((j) => isFinished(j.state)).length;
  const byPage = new Map<string, Candidate[]>();
  for (const c of showDownloaded ? candidates : fresh) {
    const key = `${c.tabId}|${c.pageUrl}`;
    byPage.set(key, [...(byPage.get(key) ?? []), c]);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Magpie</h1>
        <span className="flex-1 text-mute">downloads, archive and detected media across all tabs</span>
        <Button tone="ghost" onClick={() => void api.openSettings()}>
          Settings
        </Button>
      </header>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-wide text-mute">Downloads ({jobs.length})</h2>
          {finished > 0 && (
            <Button tone="ghost" onClick={() => void api.clearFinished()} title="Remove failed and cancelled downloads from the list">
              Clear finished
            </Button>
          )}
        </div>
        {jobs.length === 0 ? (
          <div className="rounded border border-dashed border-edge p-4 text-center text-mute">Nothing downloading.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-wide text-mute">Archive ({archive.length})</h2>
          {archive.length > 0 && (
            <ConfirmButton onConfirm={() => void api.clearArchive()} confirm="Click again to clear" title="Forget every archived download. Saved files stay where they are.">
              Clear archive
            </ConfirmButton>
          )}
        </div>
        <ArchiveList entries={archive} />
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-wide text-mute">Detected media ({fresh.length})</h2>
          <DownloadedToggle count={downloaded} shown={showDownloaded} onToggle={() => setShowDownloaded((v) => !v)} />
        </div>
        {byPage.size === 0 ? (
          <div className="rounded border border-dashed border-edge p-4 text-center text-mute">
            {downloaded ? 'Everything detected is already in your archive.' : 'Nothing detected in any open tab.'}
          </div>
        ) : (
          [...byPage.entries()].map(([key, list]) => (
            <div key={key} className="mb-3">
              <div className="mb-1 truncate text-[11px] text-mute" title={list[0]!.pageUrl}>
                {shortUrl(list[0]!.pageUrl)}
              </div>
              <div className="flex flex-col gap-1">
                {list.map((c) => (
                  <CandidateRow key={c.id} candidate={c} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
