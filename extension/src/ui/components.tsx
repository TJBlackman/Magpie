import { useState } from 'react';
import type { Candidate, Inspection, Job } from '../core/types';
import { api, showDownload } from './api';
import { fmtBytes, kindLabel, shortUrl } from './format';

export function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'shine' | 'warn' | 'bad' | 'good' }) {
  const cls = {
    default: 'bg-edge text-mute',
    shine: 'bg-shine/15 text-shine',
    warn: 'bg-amber-500/15 text-amber-300',
    bad: 'bg-red-500/15 text-red-300',
    good: 'bg-emerald-500/15 text-emerald-300',
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${cls}`}>{children}</span>;
}

export function Button({ children, onClick, disabled, tone = 'default', title }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'default' | 'shine' | 'ghost'; title?: string }) {
  const cls = {
    default: 'bg-edge hover:bg-zinc-700 text-zinc-100',
    shine: 'bg-shine text-ink hover:bg-cyan-300 font-semibold',
    ghost: 'text-mute hover:text-zinc-100',
  }[tone];
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`rounded px-2 py-1 text-xs transition disabled:opacity-40 ${cls}`}>
      {children}
    </button>
  );
}

export function CandidateRow({ candidate }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !inspection && !busy) {
      setBusy(true);
      setError(null);
      const r = await api.inspect(candidate.id);
      setBusy(false);
      if (r.ok) setInspection(r.value);
      else setError(r.error);
    }
  };

  const start = async (variantId: string) => {
    setBusy(true);
    const r = await api.start(candidate.id, variantId);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="rounded border border-edge bg-panel" data-testid="candidate" data-url={candidate.url}>
      <button type="button" onClick={toggle} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/60">
        <Badge tone={candidate.kind === 'dash' ? 'warn' : 'shine'}>{kindLabel(candidate.kind)}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300" title={candidate.url}>
          {shortUrl(candidate.url)}
        </span>
        {candidate.contentLength ? <span className="text-[11px] text-mute">{fmtBytes(candidate.contentLength)}</span> : null}
      </button>
      {open && (
        <div className="border-t border-edge px-2 py-1.5">
          {busy && !inspection && <div className="text-mute">Inspecting…</div>}
          {error && <div className="text-red-300">{error}</div>}
          {inspection?.notes.map((n) => (
            <div key={n} className="mb-1 text-amber-300">
              {n}
            </div>
          ))}
          {inspection && (
            <ul className="flex flex-col gap-1">
              {inspection.variants.map((v) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-zinc-200" title={v.uri}>
                    {v.label}
                  </span>
                  <Button tone="shine" disabled={busy} onClick={() => start(v.id)} title={`Download ${v.label}`}>
                    Download
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function JobRow({ job }: { job: Job }) {
  const pct = job.segmentsTotal ? Math.round((job.segmentsDone / job.segmentsTotal) * 100) : 0;
  const active = ['queued', 'inspecting', 'downloading', 'muxing', 'saving'].includes(job.state);
  const tone = job.state === 'done' ? 'good' : job.state === 'error' ? 'bad' : job.state === 'cancelled' ? 'default' : 'shine';
  return (
    <div className="rounded border border-edge bg-panel px-2 py-1.5" data-testid="job" data-job-id={job.id} data-state={job.state} data-filename={job.filename}>
      <div className="flex items-center gap-2">
        <Badge tone={tone}>{job.state}</Badge>
        <span className="min-w-0 flex-1 truncate" title={job.title}>
          {job.filename}
        </span>
        {active && (
          <Button tone="ghost" onClick={() => api.cancel(job.id)}>
            Cancel
          </Button>
        )}
        {!active && job.downloadId !== undefined && job.state === 'done' && (
          <Button tone="ghost" onClick={() => showDownload(job.downloadId!)}>
            Show
          </Button>
        )}
        {!active && (
          <Button tone="ghost" onClick={() => api.removeJob(job.id)}>
            ×
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-mute">
        <div className="h-1 flex-1 overflow-hidden rounded bg-edge">
          <div className={`h-full ${job.state === 'error' ? 'bg-red-400' : 'bg-shine'}`} style={{ width: `${job.state === 'done' ? 100 : pct}%` }} />
        </div>
        <span>
          {job.kind === 'file' ? fmtBytes(job.bytes) : `${job.segmentsDone}/${job.segmentsTotal} · ${fmtBytes(job.bytes)}`}
        </span>
      </div>
      {job.error && <div className="mt-1 text-red-300">{job.error}</div>}
    </div>
  );
}
