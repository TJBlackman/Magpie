import { memo, useEffect, useState } from 'react';
import type { Archived, Candidate, Inspection, Variant } from '../core/types';
import { api } from './api';
import { describeVariant, fmtAgo, fmtBytes, fmtClock, fmtDateTime, fmtEstimate, fmtHeight, hostOf, sourceLabel } from './format';
import { Badge, Button, Callout, IconButton, KindBadge, LiveBadge, MediaRow, MediaTile, ProgressRing } from './components';
import { IconCheck, IconClock, IconDownload, IconFolder, IconLock, IconRadio, IconX } from './icons';

/** "yesterday at 9:19 PM as Harbor at Dusk.mp4": when media in history was saved, and under what name. */
function savedAs(a: Archived): string {
  const ago = fmtAgo(a.at);
  const time = new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = /ago$|just now/.test(ago) ? ago : `${ago} at ${time}`;
  return `${when} as ${a.file}${a.files ? ` (${a.files} files)` : ''}`;
}

/** "r/comics · Gallery, 20 images": where a post is from and what it holds. */
function postLabel(candidate: Candidate): string {
  const p = candidate.post;
  const from = p?.subreddit ? `r/${p.subreddit}` : p?.author ? `u/${p.author}` : '';
  return [from, p?.summary].filter(Boolean).join(' · ');
}

/**
 * Where a stream comes from. Once the thumbnail capture read the stream, its
 * best quality and the host; before that, the host and the file name, since
 * streams on one page often share a title.
 */
function Source({ candidate, tagged }: { candidate: Candidate; tagged: boolean }) {
  const file = sourceLabel(candidate.url).split(' · ')[1];
  const lead = fmtHeight(candidate.info?.height) || (candidate.contentLength ? fmtBytes(candidate.contentLength) : '');
  // Before the stream is read, the file name tells apart streams that share a page title. Once a frame or the size is known, it is noise.
  const showFile = !lead && !candidate.info && !candidate.thumb && !!file && !tagged;
  return (
    <span className="min-w-0 flex-1 truncate text-dim" title={candidate.url}>
      {lead && <span className="font-medium text-text/90 tabular-nums">{lead}</span>}
      {`${lead ? ' · ' : ''}${hostOf(candidate.url)}${showFile ? ` · ${file}` : ''}`}
    </span>
  );
}

/** A job on Downloads for a card: what the card shows instead of its download button. */
export interface CardJob {
  id: string;
  queued: boolean;
  /** 0..1, or null when the size is unknown (a live recording). */
  pct: number | null;
  /** Seconds recorded so far, for a live recording. */
  elapsed?: number;
}

/** The tags of a card: status only (live, queued, downloading, saved, protected). The format lives in the sheet. */
function StatusTags({ candidate, job, inSheet }: { candidate: Candidate; job?: CardJob; inSheet?: boolean }) {
  return (
    <>
      {job && !candidate.archived && (
        <span data-testid="queued-badge" title="On the Downloads tab" className="shrink-0">
          {candidate.live && !job.queued ? (
            <Badge tone="bad">
              <span className="pulse size-1.5 rounded-full bg-live" />
              REC <span className="font-medium tracking-normal tabular-nums">{fmtClock(job.elapsed ?? 0)}</span>
            </Badge>
          ) : (
            <Badge tone="shine">{job.queued ? 'QUEUED' : job.pct === null ? 'DOWNLOADING' : `${Math.floor(job.pct * 100)}%`}</Badge>
          )}
        </span>
      )}
      {candidate.live && !job && (
        <span data-testid="live-badge" className="shrink-0">
          <LiveBadge />
        </span>
      )}
      {candidate.info?.drm && !candidate.archived && (
        <span className="shrink-0" title="Copy protected (DRM). Magpie can't save it">
          <Badge>
            <IconLock size={10} />
            PROTECTED
          </Badge>
        </span>
      )}
      {candidate.archived && !inSheet && (
        <span data-testid="archived-badge" className="shrink-0" title={`Downloaded ${savedAs(candidate.archived)}`}>
          <Badge tone="saved">
            <IconCheck size={11} className="-ml-px" />
            DOWNLOADED <span className="font-medium tracking-normal text-[#fde68a]/80">{fmtAgo(candidate.archived.at)}</span>
          </Badge>
        </span>
      )}
    </>
  );
}

function Meta({ candidate, job }: { candidate: Candidate; job?: CardJob }) {
  return (
    <>
      <StatusTags candidate={candidate} job={job} />
      {candidate.kind === 'post' ? (
        <span className="min-w-0 flex-1 truncate" title={candidate.url}>
          {postLabel(candidate)}
        </span>
      ) : (
        <Source candidate={candidate} tagged={!!job || !!candidate.live || !!candidate.archived || !!candidate.info?.drm} />
      )}
    </>
  );
}

/** The square at the right of a card. It says what opening the card leads to; a running job shows its progress instead. */
function CardAction({ candidate, job }: { candidate: Candidate; job?: CardJob }) {
  if (job) {
    if (job.queued)
      return (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-mute ring-1 ring-white/[0.08] ring-inset" aria-hidden="true">
          <IconClock size={17} />
        </span>
      );
    if (candidate.live)
      return (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-live/[0.12] ring-1 ring-live/25 ring-inset" aria-hidden="true">
          <span className="relative flex size-2.5">
            <span className="ping absolute inline-flex size-full rounded-full bg-live/70" />
            <span className="relative inline-flex size-2.5 rounded-full bg-live" />
          </span>
        </span>
      );
    return <ProgressRing pct={job.pct} />;
  }
  const blocked = candidate.info?.drm && !candidate.archived;
  const cls = blocked
    ? 'bg-transparent text-dim ring-white/[0.07] group-hover:text-mute'
    : candidate.archived
      ? 'bg-white/[0.05] text-mute ring-white/[0.08] group-hover:bg-white/[0.09] group-hover:text-text'
      : candidate.live
        ? 'bg-live/[0.12] text-live ring-live/25 group-hover:bg-live/[0.22]'
        : 'bg-shine/[0.1] text-shine ring-shine/25 group-hover:bg-shine/[0.22] group-hover:text-[#7ff0ff] group-hover:ring-shine/50';
  return (
    <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors duration-150 ${cls}`} aria-hidden="true">
      {blocked ? <IconLock size={16} /> : candidate.live ? <IconRadio size={17} /> : <IconDownload size={17} />}
    </span>
  );
}

/**
 * One piece of media on a page. The whole card opens the quality sheet.
 * `job` is its download on the Downloads tab, if any: the card shows the
 * progress, and opening it shows that job instead of starting another. Only
 * media already downloaded steps back. Memoized, since the list re-renders
 * with every progress event; `onOpen` must be a stable function for that to pay off.
 */
export const CandidateCard = memo(function CandidateCard({ candidate, thumbs, job, onOpen }: { candidate: Candidate; thumbs: boolean; job?: CardJob; onOpen: (candidate: Candidate, queuedJobId?: string) => void }) {
  const title = candidate.pageTitle || sourceLabel(candidate.url);
  const duration = candidate.info?.duration;
  return (
    <MediaRow
      attrs={{ 'data-testid': 'candidate', 'data-url': candidate.url, 'data-state': candidate.archived ? 'archived' : job ? 'queued' : 'fresh' }}
      tile={<MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} muted={!!candidate.archived} corner={duration ? fmtClock(duration) : undefined} />}
      title={title}
      titleTip={title}
      titleTestId="candidate-title"
      meta={<Meta candidate={candidate} job={job} />}
      onOpen={() => onOpen(candidate, job?.id)}
      openTip={
        candidate.archived
          ? 'Already downloaded. Download it again'
          : job
            ? 'Already downloading. Show it in Downloads'
            : candidate.info?.drm
              ? 'Copy protected (DRM). Magpie can’t save it'
              : candidate.live
                ? 'Record this stream'
                : candidate.kind === 'post'
                  ? 'Download every file of this post'
                  : 'Choose a quality and download'
      }
      dim={!!candidate.archived}
      action={<CardAction candidate={candidate} job={job} />}
    />
  );
});

/** "1080p" from a variant's resolution, for the sheet's main button. */
function shortName(v: Variant): string {
  const h = v.resolution?.split('x')[1];
  return h ? `${h}p` : '';
}

/**
 * One rendition in the sheet: name and tag on top, the technical line under
 * it, the estimated size on the right. With one rendition there is nothing to
 * pick, so it is a plain line, not an option.
 */
function VariantRow({ variant, on, single, duration, showAudio, onPick }: { variant: Variant; on: boolean; single: boolean; duration?: number; showAudio: boolean; onPick: () => void }) {
  const d = describeVariant(variant);
  const size = fmtEstimate(variant.bandwidth, duration);
  if (single)
    return (
      <button type="button" data-testid="variant" aria-pressed={on} onClick={onPick} title={variant.uri} className="flex w-full cursor-default items-baseline gap-2 px-1 py-0.5 text-left text-[12px] text-mute">
        <span className="font-semibold text-text">{d.name}</span>
        <span className="min-w-0 flex-1 truncate tabular-nums">{[d.detail, showAudio && d.audio ? `+ ${d.audio}` : '', size].filter(Boolean).join(' · ')}</span>
      </button>
    );
  const shell = on ? 'border-shine/70 bg-shine/[0.07] shadow-[inset_0_0_0_1px_rgba(34,211,238,.25)]' : 'border-edge bg-ink/40 hover:border-edge3 hover:bg-panel2';
  return (
    <button type="button" data-testid="variant" aria-pressed={on} onClick={onPick} title={variant.uri} className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors ${shell}`}>
      {!single && (
        <span className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${on ? 'border-shine' : 'border-[#66768a]'}`}>
          <span className={`size-2 rounded-full bg-shine transition-transform ${on ? 'scale-100' : 'scale-0'}`} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[14px] leading-5 font-semibold tabular-nums">{d.name}</span>
          {d.tag && <Badge tone={on && !single ? 'shine' : 'default'}>{d.tag.toUpperCase()}</Badge>}
        </span>
        {(d.detail || (showAudio && d.audio)) && <span className="block truncate text-[11.5px] leading-4 text-mute tabular-nums">{[d.detail, showAudio && d.audio ? `+ ${d.audio}` : ''].filter(Boolean).join(' · ')}</span>}
      </span>
      {size && <span className="shrink-0 text-[12px] font-medium text-mute tabular-nums">{size}</span>}
    </button>
  );
}

/** When this media was downloaded and as what, with a button that shows the file before another copy is saved. */
function ArchivedNote({ archived, onMissing }: { archived: Archived; onMissing: () => void }) {
  const ago = fmtAgo(archived.at);
  const time = new Date(archived.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = /ago$|just now/.test(ago) ? ago : `${ago} at ${time}`;
  return (
    <Callout tone="warn" title={`Downloaded ${when}`} testId="archived-note">
      <span className="block truncate" title={archived.file}>{`as ${archived.file}${archived.files ? ` (${archived.files} files)` : ''}`}</span>
      <Button tone="default" className="mt-2 -mb-0.5" onClick={() => void api.showFile(archived.file, !!archived.files).then((r) => r.ok && !r.value && onMissing())}>
        <IconFolder size={14} />
        Show in folder
      </Button>
    </Callout>
  );
}

/** "images" when every file of a post is a picture, else "files". */
function fileWord(variants: Variant[], n: number): string {
  const images = variants.length > 0 && variants.every((v) => /\b(JPE?G|PNG|WEBP|GIF|AVIF)$/i.test(v.label));
  return images ? (n === 1 ? 'image' : 'images') : n === 1 ? 'file' : 'files';
}

/**
 * What a post saves: its preview with a count, where the files land, and the
 * list of files folded away under a disclosure.
 */
function PostFiles({ candidate, variants, thumbs }: { candidate: Candidate; variants: Variant[]; thumbs: boolean }) {
  const n = variants.length;
  const where = candidate.post?.subreddit ? `Reddit/${candidate.post.subreddit}` : 'Reddit';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 rounded-[10px] bg-white/[0.035] p-2.5">
        <div className="relative flex h-[42px] w-[56px] shrink-0 items-center justify-center">
          <span className="absolute inset-0 translate-x-1.5 -translate-y-1 rounded-md bg-panel3 ring-1 ring-white/[0.06] ring-inset" />
          <span className="absolute inset-0 translate-x-0.5 -translate-y-px rounded-md bg-edge2 ring-1 ring-white/[0.06] ring-inset" />
          <MediaTile kind="post" thumb={thumbs ? candidate.thumb : undefined} className="relative h-full w-full shadow-[0_2px_6px_rgba(0,0,0,.4)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{n > 1 ? 'Saved together in one folder' : 'Saved as one file'}</div>
          <div className="truncate text-[11.5px] text-mute">{`${where}, with the post's title, author and date`}</div>
        </div>
      </div>
      <details className="group/files rounded-[10px] px-1 text-[12px] text-mute">
        <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 font-medium hover:text-text [&::-webkit-details-marker]:hidden">
          <span className="transition-transform group-open/files:rotate-90">›</span>
          {`See the ${n} ${fileWord(variants, n)}`}
        </summary>
        <ol className="mt-1 flex flex-col gap-px pb-1" data-testid="post-files">
          {variants.map((v, i) => (
            <li key={v.id} className="flex h-7 items-center gap-2.5 rounded-md px-1.5 hover:bg-white/[0.03]" title={v.uri}>
              <span className="w-5 shrink-0 text-right text-dim tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-text/90">{v.label.replace(/^\d+ of \d+ · /, '')}</span>
              <span className="shrink-0 truncate text-[11px] text-dim">{sourceLabel(v.uri).split(' · ')[1] ?? ''}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/**
 * Slides up over the list: inspects the candidate, lists its renditions, and
 * starts the download of the chosen one.
 */
export function QualitySheet({ candidate, thumbs, onClose, onStarted, onMissing }: { candidate: Candidate; thumbs: boolean; onClose: () => void; onStarted: () => void; onMissing: () => void }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.inspect(candidate.id).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setInspection(r.value);
        setVariantId(r.value.variants[0]?.id ?? null);
      } else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [candidate.id]);

  // A post has no quality to pick: every file of it is saved.
  const post = candidate.kind === 'post';
  const variants = inspection?.variants ?? [];
  const files = variants.length;

  const start = async () => {
    if ((!variantId && !post) || busy) return;
    setBusy(true);
    const r = await api.start(candidate.id, post ? 'all' : variantId!);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else onStarted();
  };

  const title = candidate.pageTitle || sourceLabel(candidate.url);
  const chosen = variants.find((v) => v.id === variantId);
  const short = chosen ? shortName(chosen) : '';
  const again = candidate.archived ? ' again' : '';
  const single = files === 1;
  const duration = inspection?.duration ?? candidate.info?.duration;
  // One audio track for every rendition is said once, under the list, not on each row.
  const audios = new Set(variants.map((v) => v.audioLabel ?? ''));
  const sharedAudio = !post && audios.size === 1 ? [...audios][0]! : '';
  const drm = !!error && /DRM|copy protected/i.test(error);

  return (
    <>
      <div className="veil-in absolute inset-0 z-10 bg-[#03050a]/70 backdrop-blur-[3px]" onClick={onClose} data-testid="veil" />
      <div
        role="dialog"
        aria-label={`Download ${title}`}
        data-testid="sheet"
        className="sheet-in absolute inset-x-0 bottom-0 z-20 flex max-h-[528px] flex-col rounded-t-[18px] border-t border-white/[0.09] bg-panel px-3.5 pt-2 pb-3.5 shadow-[0_-20px_50px_rgba(0,0,0,.6)]"
      >
        <div className="mx-auto mb-2.5 h-1 w-9 shrink-0 rounded-full bg-edge3" />
        <div className="mb-3 flex items-start gap-3">
          <MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} className="h-[50px] w-[88px]" corner={duration ? fmtClock(duration) : undefined} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="line-clamp-2 text-[13.5px] leading-[18px] font-semibold">{title}</div>
            <div className="mt-1.5 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">
              <KindBadge kind={candidate.kind} />
              <StatusTags candidate={candidate} inSheet />
              <span className="min-w-0 flex-1 truncate text-dim" title={candidate.url}>
                {post ? postLabel(candidate) : hostOf(candidate.url)}
              </span>
            </div>
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-0.5 -mr-1">
            <IconX size={17} />
          </IconButton>
        </div>
        <div className={`flex min-h-0 flex-col gap-2 overflow-y-auto scroll-thin`}>
          {error && (
            <Callout tone={drm ? 'neutral' : 'error'} icon={drm ? <IconLock size={15} /> : undefined} title={drm ? 'Copy protected' : 'Magpie can’t save this one'} testId="inspect-error">
              {error}
            </Callout>
          )}
          {!inspection && !error && (
            <div aria-busy="true" className="flex flex-col gap-1.5">
              <div className="skeleton h-[50px] rounded-[10px]" />
              <div className="skeleton h-[50px] w-4/5 rounded-[10px]" />
              <div className="mt-1 text-center text-[12px] text-mute">{post ? 'Reading the post...' : 'Reading the playlist...'}</div>
            </div>
          )}
          {candidate.archived && <ArchivedNote archived={candidate.archived} onMissing={onMissing} />}
          {inspection?.notes.map((n) => (
            <Callout key={n} tone={/fail|cannot|can't|DRM|not hosted|nothing to save/i.test(n) ? 'warn' : 'info'}>
              {n}
            </Callout>
          ))}
          {inspection && post && <PostFiles candidate={candidate} variants={variants} thumbs={thumbs} />}
          {inspection && !post && (
            <ul className="flex flex-col gap-1.5">
              {variants.map((v) => (
                <li key={v.id}>
                  <VariantRow variant={v} on={v.id === variantId} single={single} duration={duration} showAudio={!sharedAudio} onPick={() => setVariantId(v.id)} />
                </li>
              ))}
            </ul>
          )}
          {sharedAudio && !inspection?.notes.some((n) => n.startsWith('Audio:')) && <p className="px-1 text-[11.5px] text-mute">{`${single ? 'Includes' : 'Every quality includes'} ${sharedAudio} audio, merged into one file.`}</p>}
        </div>
        {inspection && !error && (!post || files > 0) && (
          <Button tone={candidate.live ? 'live' : 'shine'} size="lg" onClick={() => void start()} disabled={(!variantId && !post) || busy} className="mt-3 w-full" testId="start">
            {candidate.live ? <IconRadio size={17} /> : <IconDownload size={17} />}
            {candidate.live ? 'Start recording' : post ? `Download ${files} ${fileWord(variants, files)}${again}` : `Download${short ? ` ${short}` : ''}${again}`}
          </Button>
        )}

      </div>
    </>
  );
}
