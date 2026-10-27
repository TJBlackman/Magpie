import { useEffect, useRef, useState } from 'react';
import type { Job } from '../core/types';
import { api } from './api';
import { fmtBytes, fmtClock, fmtEta, fmtRate, jobProgress, shortVariant, sourceLabel } from './format';
import { Badge, Button, IconButton, KindBadge, MediaRow, MediaTile } from './components';
import { IconStop, IconX } from './icons';

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
      {job.note && <div className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">{job.note}</div>}
      {job.error && <div className="mt-1.5 rounded-md bg-live/10 px-2 py-1 text-[11px] text-rose-300">{job.error}</div>}
    </MediaRow>
  );
}
