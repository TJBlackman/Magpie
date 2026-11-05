import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Job } from '../core/types';
import { api, openPage } from './api';
import { fmtApprox, fmtBytes, fmtClock, fmtEta, fmtHeight, fmtRate, friendlyError, hostOf, jobProgress, nextRate, shortVariant, siteOf, type RateSample } from './format';
import { Badge, Button, Callout, FitText, IconButton, MediaRow, MediaTile, textWidth } from './components';
import { IconError, IconExternal, IconMinusCircle, IconRedo, IconStop, IconTrash, IconX } from './icons';

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
      if (job.live) return `${fmtClock(job.duration ?? 0)} recorded · ${fmtBytes(job.bytes)}`;
      const total = job.bytesTotal ?? (job.segmentsDone && job.segmentsTotal ? (job.bytes / job.segmentsDone) * job.segmentsTotal : 0);
      const of = total ? `${fmtBytes(job.bytes)} of ${job.bytesTotal ? fmtBytes(total) : fmtApprox(total)}` : fmtBytes(job.bytes);
      return pct === null || (total && !job.bytesTotal) ? of : `${of} · ${Math.floor(pct * 100)}%`;
    }
    default:
      return job.bytes ? `Stopped at ${fmtBytes(job.bytes)}` : '';
  }
}

/** The right half: speed and time left. Time left is the one thing that never truncates. */
function SpeedText({ job, rate }: { job: Job; rate: number }) {
  if (job.state === 'queued' && job.bytesTotal) return <span className="shrink-0">{fmtBytes(job.bytesTotal)}</span>;
  if (job.state !== 'downloading' || rate <= 0) return null;
  // Without an exact total the time left is an estimate, and says so.
  const eta = job.live ? '' : fmtEta(remaining(job) / rate, !job.bytesTotal);
  return (
    <span className="shrink-0">
      {fmtRate(rate)}
      {eta && (
        <>
          {' · '}
          <span className="font-semibold text-text">{eta}</span>
        </>
      )}
    </span>
  );
}

/** "0:03 recorded · 27 MB": the time in the title's colour, the size in the line's. A live stream's speed is only its bitrate, so it is left out. */
function RecordedText({ job }: { job: Job }) {
  return (
    <>
      <span className="font-semibold text-text">{`${fmtClock(job.duration ?? 0)} recorded`}</span>
      {` · ${fmtBytes(job.bytes)}`}
    </>
  );
}

/** A meta line's lead value: the quality or size. */
const LEAD = 'tabular-nums';

const STATE_CHIP: Partial<Record<Job['state'], { label: string; tone: 'default' | 'shine' | 'bad' }>> = {
  inspecting: { label: 'Starting', tone: 'shine' },
  muxing: { label: 'Finishing', tone: 'shine' },
  saving: { label: 'Saving', tone: 'shine' },
};

/** The thin bar under a job: accent while it fills, red while recording or after a failure, a sliding segment when the size is unknown. */
function Bar({ pct, tone, moving }: { pct: number | null; tone: 'shine' | 'live' | 'bad' | 'idle'; moving: boolean }) {
  const color = { shine: 'bg-shine', live: 'bg-live', bad: 'bg-live/80', idle: 'bg-edge3' }[tone];
  return (
    <div className="mt-1 h-1 rounded-full bg-[#65696f]">
      {pct === null ? (
        <div className={`bar-indeterminate h-full rounded-full ${color}`} />
      ) : (
        <div className={`h-full rounded-full transition-[width] duration-300 ${color} ${moving ? 'bar-sheen' : ''}`} style={{ width: `${Math.max(pct * 100, pct > 0 ? 2 : 0)}%`, backgroundSize: `${100 / Math.max(pct, 0.02)}% 100%` }} />
      )}
    </div>
  );
}

function StatusLine({ chip, left, right, testId = 'job-status' }: { chip?: ReactNode; left: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <div className="mt-2 flex min-h-5 items-center gap-2 text-[11.5px] text-mute tabular-nums has-[button]:min-h-8">
      {chip}
      <span className="min-w-0 flex-1 truncate" data-testid={testId}>
        {left}
      </span>
      {right}
    </div>
  );
}

/**
 * A download in flight, waiting or failed: the same row it had on the page.
 * A running one adds a progress bar and a status line. A waiting one and a
 * failed one stay one row tall, with their state on the second line, so the
 * running downloads keep the room.
 */
export function JobRow({ job, thumbs, onRetry, inset, card }: { job: Job; thumbs: boolean; onRetry?: () => void; inset?: boolean; card?: boolean }) {
  const [discarding, setDiscarding] = useState(false);
  const failed = job.state === 'error';
  // When a failure's reason and its fix do not both fit on the line, the fix takes its own line below.
  // The line's width is the same either way, so the choice cannot flip back and forth.
  const [tight, setTight] = useState(false);
  const reasonRef = useRef<HTMLSpanElement>(null);
  const fixRef = useRef<HTMLButtonElement>(null);
  const reason = friendlyError(job.error ?? 'The download stopped.');
  const queued = job.state === 'queued';
  const pct = jobProgress(job);
  const rate = useRate(job.bytes, job.state === 'downloading');
  const recording = !!job.live && job.state === 'downloading';
  const rendition = shortVariant(job.variantLabel) || fmtHeight(job.height);
  const chip = recording ? (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      <span className="ping absolute inline-flex size-full rounded-full bg-live/70" />
      <span className="relative inline-flex size-2 rounded-full bg-live" />
    </span>
  ) : STATE_CHIP[job.state] ? (
    <Badge tone={STATE_CHIP[job.state]!.tone}>{STATE_CHIP[job.state]!.label}</Badge>
  ) : null;
  const lead = rendition && <span className={LEAD}>{rendition}</span>;
  const meta = failed ? (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[#f5c76a]" title={`${job.error ?? ''}${job.bytes ? `\nStopped at ${fmtBytes(job.bytes)}` : ''}`} data-testid="job-error">
      <IconError size={13} className="shrink-0" />
      <span ref={reasonRef} className="min-w-0 flex-1 truncate">
        <FitText text={reason} />
      </span>
    </span>
  ) : queued ? (
    <span className="min-w-0 flex-1 truncate">
      <span data-testid="job-status" className="text-fg2">{statusText(job, pct)}</span>
      {[rendition, job.bytesTotal ? fmtBytes(job.bytesTotal) : job.sizeEstimate ? fmtApprox(job.sizeEstimate) : ''].filter(Boolean).map((part) => ` · ${part}`).join('')}
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate" title={job.url}>
      {lead}
      {lead ? ' · ' : ''}
      {siteOf(hostOf(job.pageUrl || job.url)) || hostOf(job.url)}
      {job.live ? ` · since ${new Date(job.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
    </span>
  );
  // A failure offers the way back: the sheet again while the media is listed, else its page, where playing it gives a fresh link.
  const recover = failed
    ? onRetry && !/no longer has it|404|410/i.test(friendlyError(job.error ?? '') + (job.error ?? ''))
      ? { hint: 'Its page is still open, so a retry gets a fresh link.', label: 'Retry', icon: <IconRedo size={13} />, tip: 'Pick a quality for this video again', run: onRetry }
      : job.pageUrl
        ? { hint: 'Play it on its page so Magpie catches a fresh link, then download it again.', label: 'Open page', icon: <IconExternal size={13} />, tip: `Open ${job.pageUrl} in a new tab`, run: () => openPage(job.pageUrl!) }
        : null
    : null;
  const hasFix = !!recover;
  useLayoutEffect(() => {
    const span = reasonRef.current;
    const line = span?.parentElement?.parentElement;
    if (!failed || !hasFix || !span || !line || typeof ResizeObserver === 'undefined') return;
    const run = () => {
      // Icon 13 + gap 6, the reason, gap 6, the fix (its -4px margin tucks it in).
      const need = 13 + 6 + textWidth(reason, getComputedStyle(span)) + 6 + (fixRef.current?.offsetWidth ?? 0) - 4;
      setTight(need > line.clientWidth);
    };
    run();
    const watch = new ResizeObserver(run);
    watch.observe(line);
    void document.fonts?.ready.then(run);
    return () => watch.disconnect();
  }, [failed, hasFix, reason]);
  const fix = recover && (
    <button ref={fixRef} type="button" onClick={recover.run} title={recover.hint} className={`${tight ? '-ml-2' : '-my-[7px] -mr-1'} inline-flex h-8 shrink-0 items-center rounded-lg px-2 text-[12px] font-semibold whitespace-nowrap text-[#83f3e5] transition-colors hover:bg-shine/10`}>
      {recover.label}
      {recover.label === 'Open page' && <IconExternal size={13} className="ml-1" />}
    </button>
  );
  const progress = (
    <>
          {!job.live && <Bar pct={pct} tone="shine" moving={job.state === 'downloading'} />}
          {discarding ? (
            <div
              className="mt-2"
              role="group"
              aria-label="Discard the recording?"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                setDiscarding(false);
              }}
            >
              <p className="text-[12.5px] font-medium text-text">Discard this recording?</p>
              <p className="mt-0.5 text-[11.5px] text-mute tabular-nums">{`Deletes the ${fmtClock(job.duration ?? 0)} recorded so far, ${fmtBytes(job.bytes)}, without saving a file.`}</p>
              <div className="mt-2.5 flex justify-end gap-2">
                <Button tone="default" size="md" onClick={() => setDiscarding(false)} autoFocus>
                  Keep recording
                </Button>
                <Button tone="destroy" size="md" onClick={() => api.cancel(job.id)}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
          <StatusLine
            chip={chip}
            left={recording ? <RecordedText job={job} /> : statusText(job, pct)}
            right={
              recording ? (
                <>
                  <Button tone="stop" size="md" onClick={() => api.stop(job.id)} title="Stop recording and save the file">
                    <IconStop size={15} />
                    Stop and save
                  </Button>
                </>
              ) : (
                <SpeedText job={job} rate={rate} />
              )
            }
          />
          )}
          {job.note && (
            <div data-testid="job-note" className="mt-2">
              <Callout tone="info">{job.note}</Callout>
            </div>
          )}
    </>
  );
  // A running or recording download with a frame is a card: the frame as a banner, its title on it, progress below.
  if (card && thumbs && job.thumb && !failed && !queued) {
    const stopLabel = job.live ? 'Discard the recording' : 'Cancel the download';
    return (
      <div data-testid="job" data-job-id={job.id} data-state={job.state} data-filename={job.filename} data-pct={pct === null ? '' : Math.floor(pct * 100)} className="card-surface relative overflow-hidden rounded-[16px]">
        <div className="relative h-[76px] overflow-hidden">
          <img src={job.thumb} alt="" data-testid="thumb" draggable={false} className="absolute inset-0 size-full object-cover" />
          <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(11,12,13,.1)_0%,rgba(11,12,13,.72)_42%,rgba(11,12,13,.92)_100%)]" />
          <span className="absolute inset-x-3.5 bottom-2.5 block">
            <span className="font-display block truncate text-[15px] leading-[19px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]" title={job.filename}>
              <FitText text={job.title || job.filename} />
            </span>
            <span className="mt-0.5 flex text-[11.5px] text-[#d6d8db] tabular-nums">{meta}</span>
          </span>
          {!(job.live && discarding) && (
            <button type="button" aria-label={stopLabel} title={stopLabel} onClick={() => (job.live ? setDiscarding(true) : void api.cancel(job.id))} className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-full bg-[#16181b]/90 text-white shadow-[0_2px_8px_rgba(0,0,0,.45)] ring-1 ring-[#6e7279] ring-inset transition-colors hover:bg-[#16181b] hover:text-[#83f3e5] focus-visible:shadow-[0_0_0_2px_#0b0c0d]">
              {job.live ? <IconTrash size={15} /> : <IconX size={15} />}
            </button>
          )}
        </div>
        <div className="px-3.5 pt-2 pb-3">{progress}</div>
      </div>
    );
  }
  return (
    <MediaRow
      inset={inset}
      attrs={{ 'data-testid': 'job', 'data-job-id': job.id, 'data-state': job.state, 'data-filename': job.filename, 'data-pct': pct === null ? '' : Math.floor(pct * 100) }}
      tile={<MediaTile kind={job.kind} live={job.live} thumb={thumbs ? job.thumb : undefined} />}
      title={job.title || job.filename}
      titleTip={job.filename}
      meta={
        <>
          {job.group && <Badge>{`${job.group.index + 1} of ${job.group.total}`}</Badge>}
          {meta}
          {!tight && fix}
        </>
      }
      action={
        failed ? (
          <IconButton label="Remove from the list" tone="danger" onClick={() => api.removeJob(job.id)} className="size-8">
            <IconX size={16} />
          </IconButton>
        ) : job.live ? (
          discarding ? null : (
            <IconButton label="Discard the recording" tone="danger" className="size-8" onClick={() => setDiscarding(true)}>
              <IconTrash size={16} />
            </IconButton>
          )
        ) : (
          <IconButton label={queued ? 'Remove from the queue' : 'Cancel the download'} tone="danger" className="size-8" onClick={() => api.cancel(job.id)}>
            <IconX size={16} />
          </IconButton>
        )
      }
    >
      {failed ? (tight && fix ? <div className="-mt-1.5 pl-[102px]">{fix}</div> : null) : queued ? null : progress}
    </MediaRow>
  );
}

/**
 * The files of one post, still waiting or running, as one row: one bar for the
 * whole post, how many files are saved, and one Cancel for all of them. Files
 * that are saved have left the list, and the engine says how many; a file
 * that failed is listed under Failed on its own.
 */
export function GroupRow({ jobs, thumbs, inset }: { jobs: Job[]; thumbs: boolean; inset?: boolean }) {
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
      inset={inset}
      attrs={{ 'data-testid': 'job-group', 'data-group-id': first.group?.id, 'data-jobs': ids, 'data-state': active ? 'downloading' : 'queued', 'data-saved': saved, 'data-pct': Math.floor(pct * 100) }}
      tile={<MediaTile kind="post" thumb={thumbs ? first.thumb : undefined} />}
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
        <IconButton label="Cancel the download" tone="danger" className="size-8" onClick={() => jobs.forEach((j) => void api.cancel(j.id))}>
          <IconX size={16} />
        </IconButton>
      }
    >
      <Bar pct={active ? pct : 0} tone={active ? 'shine' : 'idle'} moving={active} />
      <StatusLine
        chip={active ? running > 1 ? <Badge tone="shine">{`${running} at once`}</Badge> : null : <Badge>{first.queuePosition ? `Queued, #${first.queuePosition}` : 'Queued'}</Badge>}
        left={parts.join(' · ')}
        right={rate > 0 ? <span className="shrink-0">{fmtRate(rate)}</span> : null}
      />
    </MediaRow>
  );
}
