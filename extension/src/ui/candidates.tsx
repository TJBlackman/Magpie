import { memo, useEffect, useState } from 'react';
import { useDialogFocus } from './focus';
import type { Archived, Candidate, Inspection, Variant } from '../core/types';
import { api } from './api';
import { codecNames, describeVariant, fmtAgo, fmtBytes, fmtClock, fmtEstimate, fmtHeight, hostOf, siteOf, sourceLabel } from './format';
import { Badge, Button, Callout, IconButton, LiveBadge, MediaRow, MediaTile, ProgressRing } from './components';
import { IconCheck, IconCheckCircle, IconInfo, IconChevron, IconClock, IconDownload, IconFilm, IconFolder, IconImages, IconLock, IconRadio, IconX } from './icons';
import { postPath } from '../core/reddit';
import { buildFilename, withTimestamp } from '../core/filename';

/** The name the engine will give this download: the title, the quality when there is a choice, a time for a recording. */
function fileFor(candidate: Candidate, variant: Variant | undefined): string {
  const name = buildFilename(candidate.pageTitle, candidate.kind, variant?.audioOnly ? 'audio' : undefined, candidate.mime, candidate.url, variant?.label);
  return candidate.live ? withTimestamp(name, new Date()) : name;
}

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
  // "Gallery, 12 images" loses its count when the frame already shows it.
  const kind = ((p?.assets.length ?? 0) > 1 ? p?.summary?.replace(/, \d+ \w+$/, '') : p?.summary)?.replace(/^(Image|Video|GIF), (\w+)$/, (_, what: string, ext: string) => `${ext} ${what.toLowerCase()}`);
  return [from, kind].filter(Boolean).join(' · ');
}

/**
 * Where a stream comes from. Once the thumbnail capture read the stream, its
 * best quality and the host; before that, the host and the file name, since
 * streams on one page often share a title.
 */
/** The quality or size, then the host when it is another site, then the file name before anything is known. */
function sourceParts(candidate: Candidate, tagged: boolean): { lead: string; rest: string } {
  const file = sourceLabel(candidate.url).split(' · ')[1];
  const est = fmtEstimate(candidate.info?.bitrate, candidate.info?.duration);
  const size = est || (candidate.kind === 'file' && candidate.contentLength ? fmtBytes(candidate.contentLength) : '');
  // The count of qualities tells that the card opens a choice; the arrow takes the best.
  const choice = candidate.info?.qualities && !candidate.archived ? `${candidate.info.qualities} qualities` : '';
  const lead = [fmtHeight(candidate.info?.height), size, choice].filter(Boolean).join(' · ');
  // Before the stream is read, the file name tells apart streams that share a page title. Once a frame or the size is known, it is noise.
  const showFile = !lead && !candidate.info && !candidate.thumb && !!file && !tagged;
  // The host only fills a line that would otherwise be empty: a CDN name says nothing new.
  const host = hostOf(candidate.url);
  let rest = candidate.info?.drm && !candidate.archived ? '' : showFile ? file : '';
  if (!lead && !rest && !tagged) rest = host;
  return { lead, rest };
}

function Source({ candidate, lead, rest }: { candidate: Candidate; lead: string; rest: string }) {
  return (
    <span className="min-w-0 flex-1 truncate" title={candidate.url}>
      {lead && (
        <span className="tabular-nums">
          {lead}
          {/* The count of qualities is the card's cue that a click opens the choice. */}
          {/ qualities$/.test(lead) && <IconChevron size={11} className="-mt-px ml-0.5 inline opacity-70" />}
        </span>
      )}
      {rest && `${lead ? ' · ' : ''}${rest}`}
    </span>
  );
}

/** A status tag shows on the card: live, queued or running, saved, or protected. */
function tagged(candidate: Candidate, job?: CardJob): boolean {
  return !!job || !!candidate.live || !!candidate.archived || !!candidate.info?.drm;
}

/** The corner of a post's frame: how many files it holds. */
function FileCount({ n }: { n: number }) {
  return (
    <span className="flex items-center gap-0.5">
      <IconImages size={9} />
      {n}
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
            <>
              <Badge tone="bad">
                <span className="pulse size-1.5 rounded-full bg-live" />
                Recording
              </Badge>
              <span className="ml-1.5 font-semibold text-live-soft tabular-nums">{fmtClock(job.elapsed ?? 0)}</span>
            </>
          ) : (
            <Badge tone="shine">{job.queued ? 'Queued' : job.pct === null ? 'Downloading' : `${Math.floor(job.pct * 100)}%`}</Badge>
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
            Protected
          </Badge>
        </span>
      )}
      {candidate.archived && !inSheet && (
        <span data-testid="archived-badge" className="shrink-0" title={`Downloaded ${savedAs(candidate.archived)}`}>
          <Badge tone="saved">
            <IconCheck size={11} className="-ml-px" />
            Saved
          </Badge>
        </span>
      )}
      {candidate.archived && !inSheet && <span className="shrink-0 text-mute">{fmtAgo(candidate.archived.at).replace(/^./, (ch) => ch.toUpperCase())}</span>}
    </>
  );
}

function Meta({ candidate, job }: { candidate: Candidate; job?: CardJob }) {
  const src = sourceParts(candidate, tagged(candidate, job));
  return (
    <>
      <StatusTags candidate={candidate} job={job} />
      {candidate.archived && (candidate.kind === 'post' || src.lead || src.rest) && <span className="shrink-0 text-dim" aria-hidden="true">·</span>}
      {candidate.kind === 'post' ? (
        <span className="min-w-0 flex-1 truncate" title={candidate.url}>
          {postLabel(candidate)}
        </span>
      ) : (
        <Source candidate={candidate} {...src} />
      )}
    </>
  );
}

/** The glyph at the right of a card. It says what opening the card leads to; a running job shows its progress instead. */
/** Fresh media Magpie can save: one click on its arrow saves it at the best quality. Media already saved goes through the sheet, which says so. */
function quickable(candidate: Candidate): boolean {
  return !candidate.archived && !candidate.info?.drm && (candidate.kind !== 'post' || (candidate.post?.assets.length ?? 0) > 0);
}

/** The first media one click can save, with a frame to show, leads the page in its own card. */
export function leads(candidate: Candidate, thumbs: boolean, job?: CardJob): boolean {
  return thumbs && !!candidate.thumb && !job && quickable(candidate);
}

/** What one click on the arrow does, shown in place of the meta line while the arrow is hovered or focused. */
function quickText(candidate: Candidate): { what: string; size: string } {
  const files = candidate.post?.assets.length ?? 0;
  if (candidate.live) return { what: `Record${fmtHeight(candidate.info?.height) ? ` ${fmtHeight(candidate.info?.height)}` : ''}`, size: '' };
  if (candidate.kind === 'post') return { what: `Download ${files} ${files === 1 ? 'file' : 'files'}`, size: '' };
  const quality = fmtHeight(candidate.info?.height);
  const size = fmtEstimate(candidate.info?.bitrate, candidate.info?.duration) || (candidate.kind === 'file' && candidate.contentLength ? fmtBytes(candidate.contentLength) : '');
  return { what: `Download${quality ? ` ${quality}` : ''}`, size };
}

/** The quick action over a frame: download now at the best quality, record now, or save every file of a post. */
function QuickAction({ candidate, onQuick, variant = 'row' }: { candidate: Candidate; onQuick: (candidate: Candidate) => void; variant?: 'row' | 'lead' | 'tile' }) {
  const files = candidate.post?.assets.length ?? 0;
  const quality = fmtHeight(candidate.info?.height);
  const size = fmtEstimate(candidate.info?.bitrate, candidate.info?.duration);
  const label = candidate.live ? 'Record now' : candidate.kind === 'post' ? `Download ${files} ${files === 1 ? 'file' : 'files'} now` : `Download${quality ? ` ${quality}` : ''} now`;
  const look = {
    lead: `bottom-4 right-4 size-11 ${'bg-shine text-shine-ink hover:bg-[#4ee2da] active:bg-[#19bfb7]'} shadow-[0_6px_18px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.35)]`,
    tile: 'top-3.5 right-3.5 size-8 bg-[#16181b]/90 text-white shadow-[0_2px_8px_rgba(0,0,0,.45)] ring-1 ring-white/[0.14] ring-inset hover:bg-[#16181b] hover:text-[#83f3e5] hover:ring-white/30 active:bg-[#0b0c0d]',
    row: 'top-1/2 right-[7px] size-8 -translate-y-1/2 text-mute ring-1 ring-transparent ring-inset group-hover:text-text group-hover:ring-hover-edge hover:!text-shine hover:!ring-shine/80 hover:bg-shine/10',
  }[variant];
  return (
    <button
      type="button"
      aria-label={[label, size && `about ${size.replace(/^~/, '')}`].filter(Boolean).join(', ')}
      data-testid="quick"
      onClick={() => onQuick(candidate)}
      className={`quick absolute z-10 flex items-center justify-center rounded-full transition-colors ${look}`}
    >
      {candidate.live ? <span className={`rounded-full ${variant === 'lead' ? 'size-3 bg-shine-ink' : 'size-2.5 bg-live'}`} /> : <IconDownload size={variant === 'lead' ? 20 : 16} />}
    </button>
  );
}

/** A running recording's own Stop button on This page: stops it and saves the file. */
function StopAction({ job }: { job: CardJob }) {
  return (
    <button type="button" onClick={() => void api.stop(job.id)} aria-label={`Stop and save, ${fmtClock(job.elapsed ?? 0)} recorded`} title="Stop recording and save the file" className="absolute top-3.5 right-3.5 z-10 flex size-8 items-center justify-center rounded-full bg-[#16181b]/90 text-live shadow-[0_2px_8px_rgba(0,0,0,.45)] ring-1 ring-white/[0.14] transition-colors ring-inset hover:bg-[#16181b] hover:ring-white/30">
      <span className="size-2.5 rounded-[2px] bg-current" />
    </button>
  );
}

function CardAction({ candidate, job }: { candidate: Candidate; job?: CardJob }) {
  const box = 'flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors duration-150';
  if (job) {
    if (job.queued)
      return (
        <span className={`${box} text-mute ring-transparent`} aria-hidden="true">
          <IconClock size={17} />
        </span>
      );
    // A running recording draws its Stop button over this slot (StopAction).
    if (candidate.live) return <span className="size-9 shrink-0" aria-hidden="true" />;
    return <ProgressRing pct={job.pct} />;
  }
  // A card that can be saved in one click draws its own button over this slot (QuickAction); the slot keeps the room.
  if (quickable(candidate)) return <span className="size-9 shrink-0" aria-hidden="true" />;
  const blocked = candidate.info?.drm && !candidate.archived;
  return (
    <span className={`${box} text-mute ring-transparent`} aria-hidden="true">
      {blocked ? <IconLock size={15} /> : <IconChevron size={16} />}
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
export const CandidateCard = memo(function CandidateCard({ candidate, thumbs, job, onOpen, onQuick, hero, tile }: { candidate: Candidate; thumbs: boolean; job?: CardJob; onOpen: (candidate: Candidate, queuedJobId?: string) => void; onQuick: (candidate: Candidate) => void; hero?: boolean; tile?: boolean }) {
  const full = candidate.pageTitle || sourceLabel(candidate.url);
  const title = candidate.kind === 'post' ? full.replace(/(\s*\[[^\]]*\])+\s*$/, '') || full : full;
  const duration = candidate.info?.duration ?? candidate.archived?.secs;
  const files = candidate.post?.assets.length ?? 0;
  const attrs = { 'data-testid': 'candidate', 'data-url': candidate.url, 'data-state': candidate.archived ? 'archived' : job ? 'queued' : 'fresh' };
  const meta =
    candidate.kind === 'post' || tagged(candidate, job) || Object.values(sourceParts(candidate, false)).some(Boolean) ? (
      <>
        <span className="contents group-has-[.quick:focus-visible]:hidden group-has-[.quick:hover]:hidden">
          <Meta candidate={candidate} job={job} />
        </span>
        {!job && quickable(candidate) && (
          <span className="hidden min-w-0 flex-1 truncate font-medium text-text group-has-[.quick:focus-visible]:inline group-has-[.quick:hover]:inline" aria-hidden="true">
            {quickText(candidate).what}
            {quickText(candidate).size && <span className="quick-size font-normal text-mute">{` · ${quickText(candidate).size}`}</span>}
          </span>
        )}
      </>
    ) : undefined;
  const openTip = candidate.archived
    ? 'Already downloaded. Download it again'
    : job
      ? 'Already downloading. Show it in Downloads'
      : candidate.info?.drm
        ? "Copy protected (DRM). Magpie can't save it"
        : candidate.live
          ? 'Record this stream'
          : candidate.kind === 'post'
            ? 'Download every file of this post'
            : 'Choose a quality, or use the arrow to download the best one now';
  // The first media one click can save leads the page: its frame fills the card, its title sits on it.
  if (hero && leads(candidate, thumbs, job))
    return (
      <div {...attrs} className="group relative isolate overflow-hidden rounded-[18px] bg-[#1b1e21] shadow-[0_14px_34px_rgba(0,0,0,.5)] outline-offset-2 outline-text transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[0_18px_40px_rgba(0,0,0,.6)] has-[.row-main:focus-visible]:outline-2">
        <span className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit] ring-1 ring-white/10 transition-shadow ring-inset group-hover:ring-white/30" />
        <button type="button" onClick={() => onOpen(candidate)} title={openTip} className="row-main relative block h-[200px] w-full text-left focus-visible:outline-none">
          <img src={candidate.thumb} alt="" data-testid="thumb" draggable={false} className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] max-w-none object-cover transition-transform duration-700 ease-out group-hover:scale-[1.035]" />
          <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(11,12,13,0)_28%,rgba(11,12,13,.5)_56%,rgba(11,12,13,.93)_100%)]" />
          <span className="absolute inset-x-0 bottom-0 block p-4 pr-[76px]">
            <span className="font-display line-clamp-2 block text-[20px] leading-[23px] font-semibold text-pretty text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]" data-testid="candidate-title" title={full}>
              {title}
            </span>
            {meta && (
              <span className="mt-1.5 flex h-[18px] items-center gap-1.5 text-[12px] text-[#d6d8db]">
                {/* The length joins the line with the same separator as the rest: "17:17 · 2160p". */}
                {duration ? <span className="-mr-1.5 shrink-0 tabular-nums">{`${fmtClock(duration)} ·`}&nbsp;</span> : null}
                {meta}
              </span>
            )}
          </span>
        </button>
        <QuickAction candidate={candidate} onQuick={onQuick} variant="lead" />
      </div>
    );
  if (tile) {
    const pct = job && !job.queued && !candidate.live ? job.pct : null;
    return (
      <div {...attrs} className="group relative -m-1.5 min-w-0 rounded-[16px] p-1.5 transition-colors hover:bg-white/[0.045]">
        <button type="button" onClick={() => onOpen(candidate, job?.id)} title={openTip} className="row-main block w-full rounded-[12px] text-left outline-offset-[5px] outline-text focus-visible:outline-2">
          <span className="relative block aspect-video w-full overflow-hidden rounded-[12px] bg-[linear-gradient(135deg,#202326,#17191c)]">
            {thumbs && candidate.thumb ? (
              <img src={candidate.thumb} alt="" data-testid="thumb" draggable={false} className={`size-full object-cover transition-[transform,filter] duration-500 ease-out group-hover:scale-[1.045] ${candidate.archived ? 'brightness-[.72] saturate-[.75]' : ''}`} />
            ) : (
              <span className={`flex size-full items-center justify-center ${candidate.live ? 'text-live' : 'text-dim'}`}>
                {candidate.info?.drm ? <IconLock size={20} /> : candidate.live ? <IconRadio size={20} className="pulse" /> : candidate.kind === 'post' ? <IconImages size={20} /> : <IconFilm size={20} />}
              </span>
            )}
            <span className="pointer-events-none absolute inset-0 rounded-[12px] ring-1 ring-white/[0.08] ring-inset transition-shadow group-hover:ring-white/20" />
            {(duration || files > 1) && (
              <span className="absolute right-1.5 bottom-1.5 rounded-[5px] bg-[#0b0c0d]/60 px-1 text-[10.5px] leading-[15px] font-medium text-white tabular-nums backdrop-blur-sm">{duration ? fmtClock(duration) : <FileCount n={files} />}</span>
            )}
            {pct !== null && (
              <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-[#0b0c0d]/60">
                <span className="block h-full rounded-full bg-shine transition-[width] duration-300" style={{ width: `${Math.max(pct * 100, 3)}%` }} />
              </span>
            )}
          </span>
          <span className="mt-2 block px-0.5">
            <span className={`line-clamp-2 block text-[12.5px] leading-[16px] font-medium text-pretty ${candidate.archived || (candidate.info?.drm && !job) ? 'text-fg2' : 'text-text'}`} data-testid="candidate-title" title={full}>
              {title}
            </span>
            {meta && <span className="mt-1 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">{meta}</span>}
          </span>
        </button>
        {!job && quickable(candidate) ? <QuickAction candidate={candidate} onQuick={onQuick} variant="tile" /> : job && candidate.live && !job.queued ? <StopAction job={job} /> : null}
      </div>
    );
  }
  return (
    <MediaRow
      attrs={attrs}
      tile={<MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} muted={!!candidate.archived} corner={duration ? fmtClock(duration) : files > 1 ? <FileCount n={files} /> : undefined} />}
      title={title}
      titleTip={full}
      titleTestId="candidate-title"
      meta={meta}
      onOpen={() => onOpen(candidate, job?.id)}
      openTip={openTip}
      dim={!!candidate.archived || (!!candidate.info?.drm && !job)}
      action={<CardAction candidate={candidate} job={job} />}
      overlay={!job && quickable(candidate) ? <QuickAction candidate={candidate} onQuick={onQuick} /> : job && candidate.live && !job.queued ? <StopAction job={job} /> : undefined}
      inset
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
function VariantRow({ variant, on, single, duration, showAudio, hideCodecs, onPick }: { variant: Variant; on: boolean; single: boolean; duration?: number; showAudio: boolean; hideCodecs: boolean; onPick: () => void }) {
  const d = describeVariant(variant);
  if (hideCodecs) d.detail = d.detail.replace(new RegExp(` · ${codecNames(variant.codecs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
  const size = fmtEstimate(variant.bandwidth, duration);
  if (single)
    return (
      <button type="button" data-testid="variant" aria-pressed={on} onClick={onPick} title={variant.uri} className="flex w-full cursor-default items-baseline gap-2 px-1 py-0.5 text-left text-[12px] text-mute">
        <span className="font-semibold text-text">{d.name}</span>
        <span className="min-w-0 flex-1 truncate tabular-nums">{[d.detail, showAudio && d.audio ? `+ ${d.audio}` : '', size].filter(Boolean).join(' · ')}</span>
      </button>
    );
  const shell = on ? 'bg-[#0f2f2e] ring-1 ring-inset ring-shine/45' : 'hover:bg-panel2';
  return (
    <button type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-testid="variant" onClick={onPick} title={[d.detail, variant.uri].filter(Boolean).join('\n')} className={`flex min-h-10 w-full items-center gap-3 rounded-[7px] px-2 py-1 text-left transition-colors ${shell}`}>
      {!single && (
        <span className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${on ? 'border-shine' : 'border-[#70757b]'}`}>
          <span className={`size-2 rounded-full bg-shine transition-transform ${on ? 'scale-100' : 'scale-0'}`} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`text-[13.5px] leading-5 tabular-nums ${on ? 'font-medium text-text' : 'font-medium text-fg2'}`}>{d.name}</span>
          {d.tag && <Badge>{d.tag.toUpperCase()}</Badge>}
        </span>
        {!size && (d.detail || (showAudio && d.audio)) && <span className="block truncate text-[11.5px] leading-4 text-mute tabular-nums">{[d.detail, showAudio && d.audio ? `+ ${d.audio}` : ''].filter(Boolean).join(' · ')}</span>}
      </span>
      {size && <span className="shrink-0 text-[12px] text-mute tabular-nums">{size}</span>}
    </button>
  );
}

/** When this media was downloaded and as what, with a button that shows the file before another copy is saved. */
function ArchivedNote({ archived }: { archived: Archived }) {
  const ago = fmtAgo(archived.at);
  const time = new Date(archived.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = /ago$|just now/.test(ago) ? ago : `${ago} at ${time}`;
  return (
    <Callout tone="info" icon={<IconCheckCircle size={15} className="text-shine" />} title={`Saved ${when}`} testId="archived-note">
      <span className="block truncate" title={archived.file}>{`as ${archived.file}${archived.files ? ` (${archived.files} files)` : ''}`}</span>
      <span className="block text-mute">Downloading again saves a second copy beside it.</span>
    </Callout>
  );
}

/** "Downloads / Reddit / EarthPorn / name": folders quiet, the last part a step brighter, cut in the middle when long. */
function SavePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  const folders = cut >= 0 ? path.slice(0, cut).split('/').join(' / ') : '';
  const name = path.slice(cut + 1);
  const suffix = /(?:\s\d{4}-\d{2}-\d{2} \d{2}\.\d{2})?(?:\s*\[[^\]]*\])*(?:\.\w+)?$/.exec(name)?.[0] ?? '';
  const stem = name.slice(0, name.length - suffix.length);
  return (
    <span className="block min-w-0 flex-1">
      <span className="block truncate">Saves to {folders}</span>
      {/\.\w+$/.test(name) ? (
        <span className="mt-0.5 line-clamp-2 break-words">
          {stem}
          <span className="whitespace-nowrap">{suffix}</span>
        </span>
      ) : (
        <span className="mt-0.5 block truncate">{`Folder ${name}`}</span>
      )}
    </span>
  );
}

/** "images" when every file of a post is a picture, else "files". */
function fileWord(variants: Variant[], n: number): string {
  const images = variants.length > 0 && variants.every((v) => /\b(JPE?G|PNG|WEBP|GIF|AVIF)$/i.test(v.label));
  return images ? (n === 1 ? 'image' : 'images') : n === 1 ? 'file' : 'files';
}

/**
 * What a post saves: the list of its files, folded away under a disclosure.
 */
function PostFiles({ variants }: { variants: Variant[] }) {
  const n = variants.length;
  return (
    <div className="rounded-[10px] bg-[#1d1f22] transition-colors hover:bg-[#232629]">
      <details className="group/files text-[12px] text-mute">
        <summary className="flex h-12 cursor-pointer list-none items-center gap-2.5 rounded-[10px] pr-1.5 pl-3.5 text-[12.5px] text-fg2 [&::-webkit-details-marker]:hidden">
          <IconImages size={16} className="shrink-0 text-mute" />
          <span className="flex-1">{`${n} ${fileWord(variants, n)}`}</span>
          <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-fg2 transition-colors hover:bg-panel3 hover:text-text">
            <span className="group-open/files:hidden">See files</span>
            <span className="hidden group-open/files:inline">Hide files</span>
            <IconChevron size={13} className="transition-transform group-open/files:rotate-90" />
          </span>
        </summary>
        <ol className="flex flex-col gap-px border-t border-edge2 p-1.5" data-testid="post-files">
          {variants.map((v, i) => (
            <li key={v.id} className="flex h-7 items-center gap-2.5 rounded-md px-1.5 hover:bg-white/[0.03]" title={v.uri}>
              <span className="w-5 shrink-0 text-right text-dim tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-fg2">{v.label.replace(/^\d+ of \d+ · /, '')}</span>
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
export function QualitySheet({ candidate, thumbs, onClose, onStarted, onMissing }: { candidate: Candidate; thumbs: boolean; onClose: () => void; onStarted: (jobId: string) => void; onMissing: () => void }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Media already saved opens folded: the file first, the qualities only for a second copy.
  const [expanded, setExpanded] = useState(false);
  const dialog = useDialogFocus();

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
    else onStarted(r.value.id);
  };

  const fullTitle = candidate.pageTitle || sourceLabel(candidate.url);
  // Reddit's trailing tags ([OC], [4000x6000]) stay in the tooltip and the file name.
  const title = post ? fullTitle.replace(/(\s*\[[^\]]*\])+\s*$/, '') || fullTitle : fullTitle;
  const chosen = variants.find((v) => v.id === variantId);
  const short = chosen ? shortName(chosen) : '';
  const again = candidate.archived ? ' again' : '';
  const folded = !!candidate.archived && !post && !expanded;
  const single = files === 1;
  const duration = inspection?.duration ?? candidate.info?.duration;
  // One audio track for every rendition is said once, under the list, not on each row.
  const audios = new Set(variants.map((v) => v.audioLabel ?? ''));
  const sharedAudio = !post && audios.size === 1 ? [...audios][0]! : '';
  const drm = !!error && /DRM|copy protected/i.test(error);
  // Codecs every quality shares are said once, under the list.
  const codecSet = new Set(variants.map((v) => codecNames(v.codecs)));
  const shared = !post && variants.length > 1 && codecSet.size === 1 ? [...codecSet][0]! : '';
  const sharedCodecs = shared && !/^H\.264( · AAC)?$/.test(shared) ? shared : '';
  const otherLanguages = !!inspection?.notes.some((n) => n.startsWith('Audio:'));
  const footnote = [
    sharedCodecs ? `${single ? '' : 'Every quality: '}${sharedCodecs}.` : '',
    sharedAudio ? `Includes ${sharedAudio} audio${otherLanguages ? ', the stream\'s default track' : ''}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const saveAs = post ? (candidate.post?.assets.length ? postPath(candidate.post) : '') : chosen || candidate.live ? fileFor(candidate, chosen) : '';

  return (
    <>
      <div className="veil-in absolute inset-0 z-10 bg-[#040506]/70 backdrop-blur-[3px]" onClick={onClose} data-testid="veil" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Download ${title}`}
        data-testid="sheet"
        {...dialog}
        className="sheet-in outline-none absolute inset-x-0 bottom-0 z-20 flex max-h-[528px] flex-col rounded-t-[18px] border-t border-white/[0.09] bg-panel px-3.5 pt-3.5 pb-3.5 shadow-[0_-20px_50px_rgba(0,0,0,.6)]"
      >
        <div className="mb-3 flex items-start gap-3">
          <MediaTile kind={candidate.kind} live={candidate.live} locked={!!candidate.info?.drm && !candidate.archived} thumb={thumbs ? candidate.thumb : undefined} muted={!!candidate.archived} className="h-[50px] w-[88px]" corner={duration ? fmtClock(duration) : (candidate.post?.assets.length ?? 0) > 1 ? <FileCount n={candidate.post!.assets.length} /> : undefined} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="font-display line-clamp-3 text-[18px] leading-[22px] font-semibold text-pretty" title={fullTitle}>{title.replace(/(\d) (?=\p{L})/gu, '$1\u00a0')}</div>
            <div className="mt-1.5 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">
              <StatusTags candidate={candidate} inSheet />
              <span className="min-w-0 flex-1 truncate text-mute" title={candidate.url}>
                {post ? postLabel(candidate) : siteOf(hostOf(candidate.pageUrl)) || hostOf(candidate.url)}
              </span>
            </div>
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-0.5 -mr-1">
            <IconX size={17} />
          </IconButton>
        </div>
        <div className="-m-1 flex min-h-0 flex-col gap-2 overflow-y-auto p-1 scroll-thin">
          {error &&
            (drm ? (
              <Callout tone="neutral" testId="inspect-error">
                {error}
              </Callout>
            ) : (
              <Callout tone="error" title="Magpie can't save this one" testId="inspect-error">
                {error}
              </Callout>
            ))}
          {!inspection && !error && (
            <div aria-busy="true" className="flex flex-col gap-1.5">
              <div className="skeleton h-[50px] rounded-[10px]" />
              <div className="skeleton h-[50px] w-4/5 rounded-[10px]" />
              <div className="mt-1 text-center text-[12px] text-mute">{post ? 'Reading the post...' : 'Reading the playlist...'}</div>
            </div>
          )}
          {candidate.archived && <ArchivedNote archived={candidate.archived} />}
          {inspection?.notes.filter((n) => !n.startsWith('Audio:')).map((n) => (
            <Callout key={n} tone={/fail|cannot|can't|DRM|not hosted|nothing to save/i.test(n) ? 'warn' : 'info'} title={candidate.live && n.startsWith('Starts about') ? 'Records until you stop' : undefined}>
              {n}
            </Callout>
          ))}
          {inspection && post && files > 0 && <PostFiles variants={variants} />}
          {inspection && !post && !(candidate.live && single) && !folded && (
            <ul
              role="radiogroup"
              aria-label="Quality"
              className="flex flex-col gap-1 rounded-[12px] bg-[#1b1e21] p-1.5"
              onKeyDown={(e) => {
                // Arrow keys move the choice and the focus together, like any radio group.
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const at = variants.findIndex((v) => v.id === variantId);
                const next = variants[(at + (e.key === 'ArrowDown' ? 1 : variants.length - 1)) % variants.length];
                if (!next) return;
                const list = e.currentTarget;
                setVariantId(next.id);
                requestAnimationFrame(() => list.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
              }}
            >
              {variants.map((v) => (
                <li key={v.id}>
                  <VariantRow variant={v} on={v.id === variantId} single={single} duration={duration} showAudio={!sharedAudio} hideCodecs={codecSet.size === 1} onPick={() => setVariantId(v.id)} />
                </li>
              ))}
            </ul>
          )}
          {!post && inspection && footnote && !folded && <Callout tone="info">{footnote}</Callout>}
        </div>
        {inspection && !error && saveAs && !candidate.archived && (
          <div className="mt-3 flex items-start gap-2 px-0.5 text-[11.5px] leading-4 text-mute" title={`Downloads/${saveAs}`} data-testid="save-as">
            <SavePath path={`Downloads/${post ? saveAs.replace(/(\s*\[[^\]]*\])+(?=\.\w+$|$)/, '') : saveAs}`} />
          </div>
        )}
        {inspection && !error && folded && (
          <div className="mt-3 flex gap-2">
            <Button size="lg" className="flex-1" testId="start" onClick={() => setExpanded(true)} title="Pick a quality for a second copy">
              <IconDownload size={17} />
              Download again
            </Button>
            <Button tone="shine" size="lg" className="flex-1" onClick={() => void api.showFile(candidate.archived!.file, !!candidate.archived!.files).then((r) => r.ok && !r.value && onMissing())}>
              <IconFolder size={16} />
              Show in folder
            </Button>
          </div>
        )}
        {inspection && !error && (!post || files > 0) && !folded && (
          <Button tone={candidate.archived ? 'default' : 'shine'} size="lg" onClick={() => void start()} disabled={(!variantId && !post) || busy} className={`${saveAs && !candidate.archived ? 'mt-2.5' : 'mt-3'} w-full`} testId="start">
            {candidate.live ? (
              <span className="size-2.5 rounded-full bg-shine-ink" aria-hidden="true" />
            ) : (
              <IconDownload size={17} />
            )}
            {candidate.live ? (short || fmtHeight(candidate.info?.height) ? `Record ${short || fmtHeight(candidate.info?.height)}` : 'Start recording') : post ? `Download ${files} ${fileWord(variants, files)}${again}` : `Download${short ? ` ${short}` : ''}${again}`}
          </Button>
        )}
      </div>
    </>
  );
}
