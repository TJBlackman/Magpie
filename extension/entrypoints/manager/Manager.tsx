import { api, useCandidates, useJobs } from '../../src/ui/api';
import { Button, CandidateRow, JobRow } from '../../src/ui/components';
import { shortUrl } from '../../src/ui/format';
import type { Candidate } from '../../src/core/types';

export function Manager() {
  const jobs = useJobs();
  const [candidates] = useCandidates(undefined);
  const byPage = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.tabId}|${c.pageUrl}`;
    byPage.set(key, [...(byPage.get(key) ?? []), c]);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Magpie</h1>
        <span className="flex-1 text-mute">downloads and detected media across all tabs</span>
        <Button tone="ghost" onClick={() => void api.openSettings()}>
          Settings
        </Button>
      </header>

      <section>
        <h2 className="mb-2 text-[11px] uppercase tracking-wide text-mute">Downloads ({jobs.length})</h2>
        {jobs.length === 0 ? (
          <div className="rounded border border-dashed border-edge p-4 text-center text-mute">No downloads yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[11px] uppercase tracking-wide text-mute">Detected media ({candidates.length})</h2>
        {byPage.size === 0 ? (
          <div className="rounded border border-dashed border-edge p-4 text-center text-mute">Nothing detected in any open tab.</div>
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
