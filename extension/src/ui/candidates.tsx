import { memo, useEffect, useState } from 'react';
import { useDialogFocus } from './focus';
import type { Archived, Candidate, Inspection, Variant } from '../core/types';
import { api } from './api';
import { codecNames, describeVariant, fmtAgo, fmtBytes, fmtClock, fmtEstimate, fmtHeight, hostOf, siteOf, sourceLabel } from './format';
import { Badge, Button, Callout, IconButton, LiveBadge, MediaRow, MediaTile, ProgressRing } from './components';
import { IconCheck, IconCheckCircle, IconChevron, IconClock, IconDownload, IconFolder, IconImages, IconLock, IconRadio, IconX } from './icons';
import { postPath } from '../core/reddit';

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
  const kind = (p?.assets.length ?? 0) > 1 ? p?.summary?.replace(/, \d+ \w+$/, '') : p?.summary;
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
  const lead = fmtHeight(candidate.info?.height) || (candidate.contentLength ? fmtBytes(candidate.contentLength) : '');
  // Before the stream is read, the file name tells apart streams that share a page title. Once a frame or the size is known, it is noise.
  const showFile = !lead && !candidate.info && !candidate.thumb && !!file && !tagged;
  // The host only when it belongs to another site than the page, like an ad server; the page's own CDN says
  // nothing new. It also fills a line that would otherwise be empty.
  const host = hostOf(candidate.url);
  const showHost = siteOf(host) !== siteOf(hostOf(candidate.pageUrl));
  let rest = [showHost ? host : '', showFile ? file : ''].filter(Boolean).join(' · ');
  // A stream read without a resolution is a single media playlist: there is one quality.
  if (!lead && !rest && !tagged) rest = host;
  return { lead, rest };
}

function Source({ candidate, lead, rest }: { candidate: Candidate; lead: string; rest: string }) {
  return (
    <span className="min-w-0 flex-1 truncate text-dim" title={candidate.url}>
      {lead && <span className="text-[#c3ccd7] tabular-nums">{lead}</span>}
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
            <Badge tone="bad">
              <span className="pulse size-1.5 rounded-full bg-live" />
              RECORDING <span className="font-medium tracking-normal tabular-nums">{fmtClock(job.elapsed ?? 0)}</span>
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
      {candidate.info?.drm && !candidate.archived && !inSheet && (
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
  const src = sourceParts(candidate, tagged(candidate, job));
  return (
    <>
      <StatusTags candidate={candidate} job={job} />
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
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-live/[0.12] text-live ring-1 ring-live/25 ring-inset" aria-hidden="true">
          <IconRadio size={17} className="pulse" />
        </span>
      );
    return <ProgressRing pct={job.pct} />;
  }
  const blocked = candidate.info?.drm && !candidate.archived;
  const cls = blocked
    ? 'bg-transparent text-dim ring-transparent group-hover:text-mute'
    : candidate.archived
      ? 'bg-white/[0.05] text-mute ring-white/[0.08] group-hover:bg-white/[0.09] group-hover:text-text'
      : candidate.live
        ? 'bg-live/[0.12] text-live ring-live/25 group-hover:bg-live/[0.22]'
        : 'bg-accent-fill text-shine ring-accent-edge group-hover:bg-[#163845] group-hover:text-[#7ff0ff] group-hover:ring-shine/60';
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
  const full = candidate.pageTitle || sourceLabel(candidate.url);
  const title = candidate.kind === 'post' ? full.replace(/(\s*\[[^\]]*\])+\s*$/, '') || full : full;
  const duration = candidate.info?.duration ?? candidate.archived?.secs;
  const files = candidate.post?.assets.length ?? 0;
  return (
    <MediaRow
      attrs={{ 'data-testid': 'candidate', 'data-url': candidate.url, 'data-state': candidate.archived ? 'archived' : job ? 'queued' : 'fresh' }}
      tile={<MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} muted={!!candidate.archived} corner={duration ? fmtClock(duration) : files > 1 ? <FileCount n={files} /> : undefined} />}
      title={title}
      titleTip={full}
      titleTestId="candidate-title"
      meta={candidate.kind === 'post' || tagged(candidate, job) || Object.values(sourceParts(candidate, false)).some(Boolean) ? <Meta candidate={candidate} job={job} /> : undefined}
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
function VariantRow({ variant, on, single, duration, showAudio, hideCodecs, onPick }: { variant: Variant; on: boolean; single: boolean; duration?: number; showAudio: boolean; hideCodecs: boolean; onPick: () => void }) {
  const d = describeVariant(variant);
  if (hideCodecs) d.detail = d.detail.replace(` · ${codecNames(variant.codecs)}`, '');
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
    <button type="button" data-testid="variant" aria-pressed={on} onClick={onPick} title={[d.detail, variant.uri].filter(Boolean).join('\n')} className={`flex min-h-12 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors ${shell}`}>
      {!single && (
        <span className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${on ? 'border-shine' : 'border-[#66768a]'}`}>
          <span className={`size-2 rounded-full bg-shine transition-transform ${on ? 'scale-100' : 'scale-0'}`} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[14px] leading-5 font-semibold tabular-nums">{d.name}</span>
          {d.tag && <Badge>{d.tag.toUpperCase()}</Badge>}
        </span>
        {!size && (d.detail || (showAudio && d.audio)) && <span className="block truncate text-[11.5px] leading-4 text-mute tabular-nums">{[d.detail, showAudio && d.audio ? `+ ${d.audio}` : ''].filter(Boolean).join(' · ')}</span>}
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
    <Callout tone="warn" icon={<IconCheckCircle size={15} />} title={`Downloaded ${when}`} testId="archived-note">
      <span className="block truncate" title={archived.file}>{`as ${archived.file}${archived.files ? ` (${archived.files} files)` : ''}`}</span>
      <Button tone="default" size="md" className="mt-2.5 -mb-0.5 !bg-white/[0.06] !ring-white/[0.12] hover:!bg-white/[0.1]" onClick={() => void api.showFile(archived.file, !!archived.files).then((r) => r.ok && !r.value && onMissing())}>
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
function PostFiles({ candidate, variants }: { candidate: Candidate; variants: Variant[] }) {
  const n = variants.length;
  const where = candidate.post?.subreddit ? `Reddit/${candidate.post.subreddit}` : 'Reddit';
  const folder = candidate.post ? postPath(candidate.post) : where;
  return (
    <div className="divide-y divide-edge overflow-hidden rounded-[10px] ring-1 ring-edge ring-inset">
      {/* Where it goes: the folder this post gets, and under it the place that folder lives. */}
      <div className="flex items-center gap-3 px-3 py-2 text-[12.5px]" title={folder}>
        <IconFolder size={16} className="shrink-0 text-mute" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-text/90">{folder.slice(folder.lastIndexOf('/') + 1)}</span>
          <span className="block truncate text-[11.5px] text-dim">{`Saves to ${folder.slice(0, folder.lastIndexOf('/'))}`}</span>
        </span>
      </div>
      <details className="group/files text-[12px] text-mute">
        <summary className="flex h-11 cursor-pointer list-none items-center gap-3 px-3 text-[12.5px] text-text transition-colors hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
          <IconImages size={16} className="shrink-0 text-mute" />
          <span className="flex-1">Files</span>
          <span className="text-mute tabular-nums">{n}</span>
          <IconChevron size={15} className="text-mute transition-transform group-open/files:rotate-90" />
        </summary>
        <ol className="flex flex-col gap-px px-1.5 pb-1.5" data-testid="post-files">
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
    else onStarted();
  };

  const fullTitle = candidate.pageTitle || sourceLabel(candidate.url);
  // Reddit's trailing tags ([OC], [4000x6000]) stay in the tooltip and the file name.
  const title = post ? fullTitle.replace(/(\s*\[[^\]]*\])+\s*$/, '') || fullTitle : fullTitle;
  const chosen = variants.find((v) => v.id === variantId);
  const short = chosen ? shortName(chosen) : '';
  const again = candidate.archived ? ' again' : '';
  const single = files === 1;
  const duration = inspection?.duration ?? candidate.info?.duration;
  // One audio track for every rendition is said once, under the list, not on each row.
  const audios = new Set(variants.map((v) => v.audioLabel ?? ''));
  const sharedAudio = !post && audios.size === 1 ? [...audios][0]! : '';
  const drm = !!error && /DRM|copy protected/i.test(error);
  // Codecs every quality shares are said once, under the list.
  const codecSet = new Set(variants.map((v) => codecNames(v.codecs)));
  const sharedCodecs = !post && variants.length > 1 && codecSet.size === 1 ? [...codecSet][0]! : '';
  const otherLanguages = !!inspection?.notes.some((n) => n.startsWith('Audio:'));
  const footnote = [sharedCodecs, sharedAudio ? `${sharedAudio} audio${otherLanguages ? ' only' : ''}` : ''].filter(Boolean).join(' · ');

  return (
    <>
      <div className="veil-in absolute inset-0 z-10 bg-[#03050a]/70 backdrop-blur-[3px]" onClick={onClose} data-testid="veil" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Download ${title}`}
        data-testid="sheet"
        {...dialog}
        className="sheet-in outline-none absolute inset-x-0 bottom-0 z-20 flex max-h-[528px] flex-col rounded-t-[18px] border-t border-white/[0.09] bg-panel px-3.5 pt-2 pb-3.5 shadow-[0_-20px_50px_rgba(0,0,0,.6)]"
      >
        <div className="mx-auto mb-2.5 h-1 w-9 shrink-0 rounded-full bg-edge3" />
        <div className="mb-3 flex items-start gap-3">
          <MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} className="h-[50px] w-[88px]" corner={duration ? fmtClock(duration) : (candidate.post?.assets.length ?? 0) > 1 ? <FileCount n={candidate.post!.assets.length} /> : undefined} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="line-clamp-2 text-[13.5px] leading-[18px] font-semibold text-balance" title={fullTitle}>{title.replace(/(\d) (?=\p{L})/gu, '$1\u00a0')}</div>
            <div className="mt-1.5 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">
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
        <div className="-m-1 flex min-h-0 flex-col gap-2 overflow-y-auto p-1 scroll-thin">
          {error &&
            (drm ? (
              <p className="flex gap-2.5 text-[12.5px] leading-relaxed text-[#c9d2dd]" data-testid="inspect-error">
                <IconLock size={15} className="mt-0.5 shrink-0 text-mute" />
                {error}
              </p>
            ) : (
              <Callout tone="error" title="Magpie can’t save this one" testId="inspect-error">
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
          {candidate.archived && <ArchivedNote archived={candidate.archived} onMissing={onMissing} />}
          {inspection?.notes.filter((n) => !n.startsWith('Audio:')).map((n) => (
            <Callout key={n} tone={/fail|cannot|can't|DRM|not hosted|nothing to save/i.test(n) ? 'warn' : 'info'}>
              {n}
            </Callout>
          ))}
          {inspection && post && <PostFiles candidate={candidate} variants={variants} />}
          {inspection && !post && !(candidate.live && single) && (
            <ul className="flex flex-col gap-2">
              {variants.map((v) => (
                <li key={v.id}>
                  <VariantRow variant={v} on={v.id === variantId} single={single} duration={duration} showAudio={!sharedAudio} hideCodecs={!!sharedCodecs} onPick={() => setVariantId(v.id)} />
                </li>
              ))}
            </ul>
          )}
          {footnote && <p className="text-[11.5px] text-pretty text-mute">{`${single ? '' : 'Every quality: '}${footnote}.`.replace(/^./, (c) => c.toUpperCase())}</p>}
        </div>
        {error && (
          <Button size="lg" onClick={onClose} className="mt-3 w-full">
            Close
          </Button>
        )}
        {inspection && !error && (!post || files > 0) && (
          <Button tone={candidate.live ? 'live' : candidate.archived ? 'default' : 'shine'} size="lg" onClick={() => void start()} disabled={(!variantId && !post) || busy} className="mt-3 w-full" testId="start">
            {candidate.live ? <IconRadio size={17} /> : <IconDownload size={17} />}
            {candidate.live ? 'Start recording' : post ? `Download ${files} ${fileWord(variants, files)}${again}` : `Download${short ? ` ${short}` : ''}${again}`}
          </Button>
        )}

      </div>
    </>
  );
}
