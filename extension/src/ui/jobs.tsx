import { useMemo, useRef } from 'react';
import type { Job } from '../core/types';
import { api } from './api';
import { fmtBytes, fmtClock, fmtEta, fmtRate, jobProgress, nextRate, shortVariant, sourceLabel, type RateSample } from './format';
import { Badge, Button, IconButton, KindBadge, MediaRow, MediaTile } from './components';
import { IconStop, IconX } from './icons';

/**
 * Smoothed bytes per second for an active job, from the byte counts it reports.
 * Derived during render from the last sample, so a progress event costs one
 * render, not a render plus an effect that sets state and renders again. The
 * ref only changes when the byte count did, so rendering twice with the same
 * props (StrictMode) reads the same answer.
 */
function useRate(bytes: number, active: boolean): number {
  const last = useRef<RateSample | null>(null);
  if (!active) {
    last.current = null;
    return 0;
  }
  last.current = nextRate(last.current, bytes, Date.now());
  return last.current.rate;
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

const STATE_LABEL: Record<Job['state'], string> = {
  queued: 'Queued',
  inspecting: 'Starting',
  downloading: 'Downloading',
  muxing: 'Finishing',
  saving: 'Saving',
  error: 'Failed',
};

/** A download in flight or failed: the same row it had on the page, with a progress bar and status underneath. */
export function JobRow({ job, thumbs }: { job: Job; thumbs: boolean }) {
  const failed = job.state === 'error';
  const pct = jobProgress(job);
  const rate = useRate(job.bytes, job.state === 'downloading');
  const recording = job.live && job.state === 'downloading';
  const tone = recording || failed ? 'bad' : job.state === 'queued' ? 'default' : 'shine';
  const indeterminate = !failed && pct === null;
  const barColor = recording ? 'bg-live' : failed ? 'bg-rose-400' : 'bg-shine';
  const rendition = shortVariant(job.variantLabel);
  return (
    <MediaRow
      attrs={{ 'data-testid': 'job', 'data-job-id': job.id, 'data-state': job.state, 'data-filename': job.filename, 'data-pct': pct === null ? '' : Math.floor(pct * 100) }}
      tile={<MediaTile kind={job.kind} live={job.live} thumb={thumbs ? job.thumb : undefined} />}
      title={job.title || job.filename}
      titleTip={job.filename}
      meta={
        <>
          <KindBadge kind={job.kind} />
          {job.live && <Badge tone="bad">LIVE</Badge>}
          {job.group && <Badge tone="post">{`${job.group.index + 1} of ${job.group.total}`}</Badge>}
          {rendition && <Badge>{rendition}</Badge>}
          <span className="min-w-0 flex-1 truncate" title={job.url}>
            {sourceLabel(job.url)}
          </span>
        </>
      }
      action={
        <>
          {recording && (
            <Button tone="live" onClick={() => api.stop(job.id)} title="Stop recording and save the file">
              <IconStop size={14} />
              Stop
            </Button>
          )}
          {failed ? (
            <IconButton label="Remove" onClick={() => api.removeJob(job.id)} className="size-9">
              <IconX />
            </IconButton>
          ) : (
            <IconButton label="Cancel" tone="danger" onClick={() => api.cancel(job.id)} className="size-9">
              <IconX />
            </IconButton>
          )}
        </>
      }
    >
      <div className="h-1 overflow-hidden rounded bg-edge">
        <div className={`h-full rounded ${barColor} ${indeterminate ? 'bar-indeterminate' : 'transition-[width] duration-300'}`} style={indeterminate ? undefined : { width: `${(pct ?? 0) * 100}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-mute tabular-nums">
        <Badge tone={tone}>{recording ? 'Recording' : STATE_LABEL[job.state]}</Badge>
        <span className="min-w-0 truncate text-right" data-testid="job-status">
          {statusText(job, pct, rate)}
        </span>
      </div>
      {job.note && <div data-testid="job-note" className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">{job.note}</div>}
      {job.error && <div className="mt-1.5 rounded-md bg-live/10 px-2 py-1 text-[11px] text-rose-300">{job.error}</div>}
    </MediaRow>
  );
}

/**
 * The files of one post, still waiting or running, as one row: one bar for the
 * whole post, how many files are saved, and one Cancel for all of them. Files
 * that are saved have left the list, and the engine says how many; a file
 * that failed is listed under Failed on its own.
 */
export function GroupRow({ jobs, thumbs }: { jobs: Job[]; thumbs: boolean }) {
  const first = jobs[0]!;
  const total = first.group?.total ?? jobs.length;
  const saved = Math.max(0, ...jobs.map((j) => j.group?.saved ?? 0));
  const bytes = jobs.reduce((n, j) => n + j.bytes, 0);
  const pct = (saved + jobs.reduce((n, j) => n + (jobProgress(j) ?? 0), 0)) / total;
  const active = jobs.some((j) => j.state !== 'queued');
  const rate = useRate(bytes, active);
  const ids = useMemo(() => jobs.map((j) => j.id).join(' '), [jobs]);
  const running = jobs.filter((j) => j.state === 'downloading').length;
  const parts = [`${saved} of ${total} files saved`];
  if (bytes) parts.push(fmtBytes(bytes));
  if (rate > 0) parts.push(fmtRate(rate));
  return (
    <MediaRow
      attrs={{ 'data-testid': 'job-group', 'data-group-id': first.group?.id, 'data-jobs': ids, 'data-state': active ? 'downloading' : 'queued', 'data-saved': saved, 'data-pct': Math.floor(pct * 100) }}
      tile={<MediaTile kind="post" thumb={thumbs ? first.thumb : undefined} />}
      title={first.title || first.filename}
      titleTip={first.filename}
      meta={
        <>
          <KindBadge kind="post" />
          <Badge>{`${total} files`}</Badge>
          <span className="min-w-0 flex-1 truncate" title={first.url}>
            {sourceLabel(first.url).split(' · ')[0]}
          </span>
        </>
      }
      action={
        <IconButton label="Cancel" tone="danger" onClick={() => jobs.forEach((j) => void api.cancel(j.id))} className="size-9">
          <IconX />
        </IconButton>
      }
    >
      <div className="h-1 overflow-hidden rounded bg-edge">
        <div className="h-full rounded bg-shine transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-mute tabular-nums">
        <Badge tone={active ? 'shine' : 'default'}>{active ? (running > 1 ? `${running} at once` : 'Downloading') : first.queuePosition ? `Queued, #${first.queuePosition}` : 'Queued'}</Badge>
        <span className="min-w-0 truncate text-right" data-testid="job-status">
          {parts.join(' · ')}
        </span>
      </div>
    </MediaRow>
  );
}
