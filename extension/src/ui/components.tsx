import { useEffect, useRef, useState } from 'react';
import type { Candidate, Inspection, Job } from '../core/types';
import type { ArchiveEntry } from '../core/archive';
import { api, openPage, showDownload } from './api';
import { fmtBytes, fmtClock, fmtDate, fmtDateTime, fmtEta, fmtRate, isWebUrl, jobProgress, kindLabel, shortUrl, sourceLabel } from './format';

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

export function Button({ children, onClick, disabled, tone = 'default', title }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'default' | 'shine' | 'ghost' | 'danger'; title?: string }) {
  const cls = {
    default: 'bg-edge hover:bg-zinc-700 text-zinc-100',
    shine: 'bg-shine text-ink hover:bg-cyan-300 font-semibold',
    ghost: 'text-mute hover:text-zinc-100',
    danger: 'text-red-300 hover:text-red-200',
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
  const [added, setAdded] = useState(0);

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
    else setAdded((n) => n + 1);
  };

  const source = sourceLabel(candidate.url);
  const title = candidate.pageTitle || source;

  return (
    <div className="rounded border border-edge bg-panel" data-testid="candidate" data-url={candidate.url}>
      <button type="button" onClick={toggle} className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/60">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-zinc-100" data-testid="candidate-title" title={title}>
            {title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mute">
            <Badge tone={candidate.kind === 'dash' ? 'warn' : 'shine'}>{kindLabel(candidate.kind)}</Badge>
            {candidate.live && (
              <span data-testid="live-badge">
                <Badge tone="bad">LIVE</Badge>
              </span>
            )}
            {candidate.archived && (
              <span data-testid="archived-badge" title="Already in your archive">
                <Badge tone="good">DOWNLOADED</Badge>
              </span>
            )}
            <span className="min-w-0 flex-1 truncate" title={candidate.url}>
              {source}
            </span>
            {candidate.contentLength ? <span>{fmtBytes(candidate.contentLength)}</span> : null}
          </div>
        </div>
        <span className={`mt-0.5 text-mute transition ${open ? 'rotate-90' : ''}`}>{'›'}</span>
      </button>
      {open && (
        <div className="border-t border-edge px-2 py-1.5">
          {busy && !inspection && <div className="text-mute">Inspecting...</div>}
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
          {added > 0 && <div className="mt-1 text-[11px] text-mute">Added to Downloads{added > 1 ? ` (${added} times)` : ''}.</div>}
        </div>
      )}
    </div>
  );
}

/** Smoothed bytes per second for an active job, from the byte counts it reports. */
function useRate(bytes: number, active: boolean): number {
  const last = useRef<{ t: number; b: number } | null>(null);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (!active) {
      last.current = null;
      setRate(0);
      return;
    }
    const now = Date.now();
    const prev = last.current;
    if (prev && now > prev.t && bytes > prev.b) {
      const sample = ((bytes - prev.b) * 1000) / (now - prev.t);
      setRate((r) => (r ? r * 0.7 + sample * 0.3 : sample));
    }
    if (!prev || bytes !== prev.b) last.current = { t: now, b: bytes };
  }, [bytes, active]);
  return rate;
}

function statusText(job: Job, pct: number | null, rate: number): string {
  switch (job.state) {
    case 'queued':
      return job.queuePosition ? `Waiting, #${job.queuePosition} in queue` : 'Waiting';
    case 'inspecting':
      return 'Starting';
    case 'muxing':
      return 'Finishing';
    case 'saving':
      return 'Saving to your downloads';
    case 'downloading': {
      const parts: string[] = [];
      if (job.live) {
        parts.push(`Recording ${fmtClock(job.duration ?? 0)}`, fmtBytes(job.bytes));
        if (rate > 0) parts.push(fmtRate(rate));
        return parts.join(' · ');
      }
      if (job.kind === 'file') {
        parts.push(job.bytesTotal ? `${fmtBytes(job.bytes)} of ${fmtBytes(job.bytesTotal)}` : fmtBytes(job.bytes));
      } else {
        parts.push(`${job.segmentsDone} of ${job.segmentsTotal} segments`, fmtBytes(job.bytes));
      }
      if (pct !== null) parts.push(`${Math.floor(pct * 100)}%`);
      if (rate > 0) {
        parts.push(fmtRate(rate));
        const remaining = job.bytesTotal
          ? job.bytesTotal - job.bytes
          : job.segmentsDone && job.segmentsTotal
            ? (job.segmentsTotal - job.segmentsDone) * (job.bytes / job.segmentsDone)
            : NaN;
        const eta = fmtEta(remaining / rate);
        if (eta) parts.push(eta);
      }
      return parts.join(' · ');
    }
    default:
      return fmtBytes(job.bytes);
  }
}

export function JobRow({ job }: { job: Job }) {
  const active = ['queued', 'inspecting', 'downloading', 'muxing', 'saving'].includes(job.state);
  const pct = jobProgress(job);
  const rate = useRate(job.bytes, job.state === 'downloading');
  const tone = job.state === 'done' ? 'good' : job.state === 'error' ? 'bad' : job.state === 'cancelled' || job.state === 'queued' ? 'default' : 'shine';
  const indeterminate = active && pct === null;
  const barColor = job.state === 'error' ? 'bg-red-400' : job.state === 'cancelled' ? 'bg-zinc-500' : 'bg-shine';
  const recording = job.live && job.state === 'downloading';
  return (
    <div
      className="rounded border border-edge bg-panel px-2 py-1.5"
      data-testid="job"
      data-job-id={job.id}
      data-state={job.state}
      data-filename={job.filename}
      data-pct={pct === null ? '' : Math.floor(pct * 100)}
    >
      <div className="flex items-center gap-2">
        <Badge tone={recording ? 'bad' : tone}>{recording ? 'recording' : job.state}</Badge>
        <span className="min-w-0 flex-1 truncate" title={job.title}>
          {job.filename}
        </span>
        {recording && (
          <Button tone="shine" onClick={() => api.stop(job.id)} title="Stop recording and save the file">
            Stop
          </Button>
        )}
        {active && (
          <Button tone="ghost" onClick={() => api.cancel(job.id)} title={recording ? 'Stop recording and throw it away' : undefined}>
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
            {'×'}
          </Button>
        )}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-edge">
        <div
          className={`h-full rounded ${barColor} ${indeterminate ? 'bar-indeterminate' : 'transition-[width] duration-300'}`}
          style={indeterminate ? undefined : { width: `${(pct ?? 0) * 100}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] text-mute" data-testid="job-status">
        {statusText(job, pct, rate)}
      </div>
      {job.note && <div className="mt-1 text-amber-300">{job.note}</div>}
      {job.error && <div className="mt-1 text-red-300">{job.error}</div>}
    </div>
  );
}

/** A ghost button that asks for a second click within 3 seconds, for clears that cannot be undone. */
export function ConfirmButton({ children, confirm, onConfirm, title }: { children: React.ReactNode; confirm: string; onConfirm: () => void; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      tone={armed ? 'danger' : 'ghost'}
      title={title}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirm : children}
    </Button>
  );
}

/** Shows or hides media the archive already has. Nothing when there is none. */
export function DownloadedToggle({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <Button tone="ghost" onClick={onToggle} title={shown ? 'Hide media already in your archive' : 'Show media already in your archive'}>
      {shown ? 'hide downloaded' : `${count} downloaded`}
    </Button>
  );
}

/** One finished download: title, date, length, and a link to the page it came from. */
export function ArchiveRow({ entry }: { entry: ArchiveEntry }) {
  const page = entry.page;
  return (
    <div className="flex items-start gap-2 rounded border border-edge bg-panel px-2 py-1.5" data-testid="archive-entry" data-job-id={entry.id} data-file={entry.file}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-zinc-100" data-testid="archive-title" title={entry.file}>
          {entry.title || entry.file}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mute">
          <span className="shrink-0" title={fmtDateTime(entry.at)}>
            {fmtDate(entry.at)}
          </span>
          {entry.secs ? <span className="shrink-0">{`· ${fmtClock(entry.secs)}`}</span> : null}
          {page && <span className="shrink-0">·</span>}
          {page && isWebUrl(page) ? (
            <a
              href={page}
              target="_blank"
              rel="noreferrer"
              title={`Open ${page} in a new tab`}
              className="min-w-0 truncate text-shine hover:underline"
              onClick={(e) => {
                e.preventDefault();
                openPage(page);
              }}
            >
              {shortUrl(page)}
            </a>
          ) : page ? (
            <span className="min-w-0 truncate" title={page}>
              {shortUrl(page)}
            </span>
          ) : null}
        </div>
      </div>
      <Button tone="ghost" onClick={() => void api.removeArchive(entry.id)} title="Remove from archive. The video shows as available again.">
        {'×'}
      </Button>
    </div>
  );
}

/** Archive entries, or a line saying there are none. */
export function ArchiveList({ entries, className = '' }: { entries: ArchiveEntry[]; className?: string }) {
  if (!entries.length) {
    return <div className="rounded border border-dashed border-edge p-3 text-center text-mute">Finished downloads show up here.</div>;
  }
  return (
    <div className={`flex flex-col gap-1 ${className}`} data-testid="archive">
      {entries.map((e) => (
        <ArchiveRow key={e.id} entry={e} />
      ))}
    </div>
  );
}
