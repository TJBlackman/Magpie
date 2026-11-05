import { useMemo, useRef, type ReactNode } from 'react';
import type { Job } from '../core/types';
import { api, openPage } from './api';
import { fmtBytes, fmtClock, fmtEta, fmtRate, friendlyError, hostOf, jobProgress, nextRate, shortVariant, type RateSample } from './format';
import { Badge, Button, Callout, IconButton, MediaRow, MediaTile } from './components';
import { IconError, IconExternal, IconRedo, IconStop, IconTrash, IconX } from './icons';

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

/** Bytes still to fetch: exact for a file with a size, estimated from the segments so far for a stream. NaN when unknown. */
function remaining(job: Job): number {
  if (job.bytesTotal) return job.bytesTotal - job.bytes;
  if (job.segmentsDone && job.segmentsTotal) return (job.segmentsTotal - job.segmentsDone) * (job.bytes / job.segmentsDone);
  return NaN;
}

/** The left half of the status line: how far along, in words people use. */
function statusText(job: Job, pct: number | null): string {
  switch (job.state) {
    case 'queued':
      return job.queuePosition ? `#${job.queuePosition} in line` : 'Waiting for a free slot';
    case 'inspecting':
      return 'Starting';
    case 'muxing':
      return 'Finishing the file';
    case 'saving':
      return 'Saving to your downloads';
    case 'downloading': {
      if (job.live) return `Recording ${fmtClock(job.duration ?? 0)} · ${fmtBytes(job.bytes)}`;
      const total = job.bytesTotal ?? (job.segmentsDone && job.segmentsTotal ? (job.bytes / job.segmentsDone) * job.segmentsTotal : 0);
      const of = total ? `${fmtBytes(job.bytes)} of ${job.bytesTotal ? '' : '~'}${fmtBytes(total)}` : fmtBytes(job.bytes);
      return pct === null ? of : `${of} · ${Math.floor(pct * 100)}%`;
    }
    default:
      return job.bytes ? `Stopped at ${fmtBytes(job.bytes)}` : '';
  }
}

/** The right half: speed and time left. Time left is the one thing that never truncates. */
function SpeedText({ job, rate }: { job: Job; rate: number }) {
  if (job.state === 'queued' && job.bytesTotal) return <span className="shrink-0">{fmtBytes(job.bytesTotal)}</span>;
  if (job.state !== 'downloading' || rate <= 0) return null;
  const eta = job.live ? '' : fmtEta(remaining(job) / rate);
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5">
      <span className="truncate">{fmtRate(rate)}</span>
      {eta && (
        <span className="shrink-0">
          · <span className="font-semibold text-text">{eta}</span>
        </span>
      )}
    </span>
  );
}

const STATE_CHIP: Partial<Record<Job['state'], { label: string; tone: 'default' | 'shine' | 'bad' }>> = {
  inspecting: { label: 'STARTING', tone: 'shine' },
  muxing: { label: 'FINISHING', tone: 'shine' },
  saving: { label: 'SAVING', tone: 'shine' },
};

/** The thin bar under a job: accent while it fills, red while recording or after a failure, a sliding segment when the size is unknown. */
function Bar({ pct, tone, moving }: { pct: number | null; tone: 'shine' | 'live' | 'bad' | 'idle'; moving: boolean }) {
  const color = { shine: 'bg-shine', live: 'bg-live', bad: 'bg-rose-400/80', idle: 'bg-edge3' }[tone];
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      {pct === null ? (
        <div className={`bar-indeterminate h-full rounded-full ${color}`} />
      ) : (
        <div className={`h-full rounded-full transition-[width] duration-300 ${color} ${moving ? 'bar-sheen' : ''}`} style={{ width: `${Math.max(pct * 100, pct > 0 ? 2 : 0)}%` }} />
      )}
    </div>
  );
}

function StatusLine({ chip, left, right, testId = 'job-status' }: { chip?: ReactNode; left: string; right?: ReactNode; testId?: string }) {
  return (
    <div className="mt-2 flex h-[18px] items-center gap-2 text-[11.5px] text-mute tabular-nums">
      {chip}
      <span className="min-w-0 flex-1 truncate" data-testid={testId}>
        {left}
      </span>
      {right}
    </div>
  );
}

/** A download in flight or failed: the same row it had on the page, with a progress bar and status underneath. */
export function JobRow({ job, thumbs, onRetry }: { job: Job; thumbs: boolean; onRetry?: () => void }) {
  const failed = job.state === 'error';
  const pct = jobProgress(job);
  const rate = useRate(job.bytes, job.state === 'downloading');
  const recording = !!job.live && job.state === 'downloading';
  const rendition = shortVariant(job.variantLabel);
  const chip = recording ? (
    <Badge tone="bad">
      <span className="pulse size-1.5 rounded-full bg-live" />
      REC
    </Badge>
  ) : STATE_CHIP[job.state] ? (
    <Badge tone={STATE_CHIP[job.state]!.tone}>{STATE_CHIP[job.state]!.label}</Badge>
  ) : null;
  return (
    <MediaRow
      attrs={{ 'data-testid': 'job', 'data-job-id': job.id, 'data-state': job.state, 'data-filename': job.filename, 'data-pct': pct === null ? '' : Math.floor(pct * 100) }}
      tile={<MediaTile kind={job.kind} live={job.live} thumb={thumbs ? job.thumb : undefined} muted={job.state === 'queued'} />}
      title={job.title || job.filename}
      titleTip={job.filename}
      meta={
        <>
          {job.group && <Badge>{`${job.group.index + 1} OF ${job.group.total}`}</Badge>}
          <span className="min-w-0 flex-1 truncate" title={job.url}>
            {rendition && <span className="font-medium text-text/90">{rendition}</span>}
            {hostOf(job.url) && <span className={rendition ? 'text-dim' : ''}>{`${rendition ? ' · ' : ''}${hostOf(job.url)}`}</span>}
          </span>
        </>
      }
      action={
        <>
          {recording && (
            <Button tone="default" onClick={() => api.stop(job.id)} title="Stop recording and save the file" className="text-[#ff9fb1] ring-live/30 hover:bg-live/15">
              <IconStop size={12} />
              Stop
            </Button>
          )}
          {failed ? (
            <IconButton label="Remove" framed onClick={() => api.removeJob(job.id)}>
              <IconX size={17} />
            </IconButton>
          ) : job.live ? (
            <IconButton label="Discard recording" tone="danger" framed onClick={() => api.cancel(job.id)}>
              <IconTrash size={16} />
            </IconButton>
          ) : (
            <IconButton label="Cancel" tone="danger" framed onClick={() => api.cancel(job.id)}>
              <IconX size={17} />
            </IconButton>
          )}
        </>
      }
    >
      {!failed && !job.live && job.state !== 'queued' && <Bar pct={pct} tone="shine" moving={job.state === 'downloading'} />}
      {failed ? (
        <>
          {job.error && (
            <p className="-mt-0.5 flex gap-2 text-[12px] leading-[1.45] text-[#c9d2dd]" title={job.error}>
              <IconError size={14} className="mt-0.5 shrink-0 text-live" />
              <span className="line-clamp-2">{friendlyError(job.error)}</span>
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            {onRetry ? (
              <Button tone="default" onClick={onRetry} title="Open the quality sheet for this video again">
                <IconRedo size={13} />
                Try again
              </Button>
            ) : job.pageUrl ? (
              <Button tone="default" onClick={() => openPage(job.pageUrl!)} title={`Open ${job.pageUrl} in a new tab`}>
                <IconExternal size={13} />
                Open the page
              </Button>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-dim tabular-nums" data-testid="job-status">
              {statusText(job, pct)}
            </span>
          </div>
        </>
      ) : (
        <StatusLine chip={chip} left={statusText(job, pct)} right={<SpeedText job={job} rate={rate} />} />
      )}
      {job.note && (
        <div data-testid="job-note" className="mt-2">
          <Callout tone="info">{job.note}</Callout>
        </div>
      )}
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
  return (
    <MediaRow
      attrs={{ 'data-testid': 'job-group', 'data-group-id': first.group?.id, 'data-jobs': ids, 'data-state': active ? 'downloading' : 'queued', 'data-saved': saved, 'data-pct': Math.floor(pct * 100) }}
      tile={<MediaTile kind="post" thumb={thumbs ? first.thumb : undefined} muted={!active} />}
      title={first.title || first.filename}
      titleTip={first.filename}
      meta={
        <>
          <Badge>{`${total} files`}</Badge>
          <span className="min-w-0 flex-1 truncate" title={first.url}>
            {hostOf(first.url)}
          </span>
        </>
      }
      action={
        <IconButton label="Cancel" tone="danger" framed onClick={() => jobs.forEach((j) => void api.cancel(j.id))}>
          <IconX size={17} />
        </IconButton>
      }
    >
      <Bar pct={active ? pct : 0} tone={active ? 'shine' : 'idle'} moving={active} />
      <StatusLine
        chip={active ? running > 1 ? <Badge tone="shine">{`${running} AT ONCE`}</Badge> : null : <Badge>{first.queuePosition ? `QUEUED #${first.queuePosition}` : 'QUEUED'}</Badge>}
        left={parts.join(' · ')}
        right={rate > 0 ? <span className="shrink-0">{fmtRate(rate)}</span> : null}
      />
    </MediaRow>
  );
}
