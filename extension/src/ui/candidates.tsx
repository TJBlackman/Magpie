import { useEffect, useState } from 'react';
import type { Candidate, Inspection, Variant } from '../core/types';
import { api } from './api';
import { fmtBytes, sourceLabel } from './format';
import { Badge, Button, IconButton, KindBadge, MediaRow, MediaTile } from './components';
import { IconDownload, IconRadio, IconX } from './icons';

function Meta({ candidate, queued }: { candidate: Candidate; queued?: boolean }) {
  return (
    <>
      <KindBadge kind={candidate.kind} />
      {queued && !candidate.archived && (
        <span data-testid="queued-badge" title="On the Downloads tab">
          <Badge>IN DOWNLOADS</Badge>
        </span>
      )}
      {candidate.live && (
        <span data-testid="live-badge">
          <Badge tone="bad">LIVE</Badge>
        </span>
      )}
      {candidate.archived && (
        <span data-testid="archived-badge" title="Already in your history">
          <Badge tone="good">DOWNLOADED</Badge>
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={candidate.url}>
        {sourceLabel(candidate.url)}
      </span>
      {candidate.contentLength ? <span className="shrink-0">{fmtBytes(candidate.contentLength)}</span> : null}
    </>
  );
}

/**
 * One piece of media on a page. The whole card opens the quality sheet.
 * `queued` means a job for it is on the Downloads tab: the card goes gray
 * and opening it shows that job instead of starting another.
 */
export function CandidateCard({ candidate, thumbs, queued, onOpen }: { candidate: Candidate; thumbs: boolean; queued?: boolean; onOpen: () => void }) {
  const title = candidate.pageTitle || sourceLabel(candidate.url);
  const done = candidate.archived || queued;
  const action = done ? 'bg-edge text-mute' : candidate.live ? 'bg-live text-white shadow-[0_2px_8px_rgba(244,63,94,.35)]' : 'bg-shine text-shine-ink shadow-[0_2px_8px_rgba(34,211,238,.3)]';
  return (
    <MediaRow
      attrs={{ 'data-testid': 'candidate', 'data-url': candidate.url, 'data-state': candidate.archived ? 'archived' : queued ? 'queued' : 'fresh' }}
      tile={<MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} muted={done} />}
      title={title}
      titleTip={title}
      titleTestId="candidate-title"
      meta={<Meta candidate={candidate} queued={queued} />}
      onOpen={onOpen}
      openTip={candidate.archived ? 'Download this again' : queued ? 'Already downloading. Show it in Downloads' : candidate.live ? 'Record this stream' : 'Download this video'}
      dim={done}
      action={
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${action}`} aria-hidden="true">
          {candidate.live ? <IconRadio /> : <IconDownload />}
        </span>
      }
    />
  );
}

/** "1080p" from a variant's resolution, for the sheet's main button. */
function shortName(v: Variant): string {
  const h = v.resolution?.split('x')[1];
  return h ? `${h}p` : '';
}

/**
 * Slides up over the list: inspects the candidate, lists its renditions, and
 * starts the download of the chosen one.
 */
export function QualitySheet({ candidate, thumbs, onClose, onStarted }: { candidate: Candidate; thumbs: boolean; onClose: () => void; onStarted: () => void }) {
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

  const start = async () => {
    if (!variantId || busy) return;
    setBusy(true);
    const r = await api.start(candidate.id, variantId);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else onStarted();
  };

  const title = candidate.pageTitle || sourceLabel(candidate.url);
  const chosen = inspection?.variants.find((v) => v.id === variantId);
  const short = chosen ? shortName(chosen) : '';

  return (
    <>
      <div className="veil-in absolute inset-0 z-10 bg-ink/60 backdrop-blur-[2px]" onClick={onClose} data-testid="veil" />
      <div
        role="dialog"
        aria-label={`Download ${title}`}
        data-testid="sheet"
        className="sheet-in absolute inset-x-0 bottom-0 z-20 flex max-h-[520px] flex-col rounded-t-2xl border-t border-edge2 bg-panel px-3.5 pt-2.5 pb-4 shadow-[0_-12px_40px_rgba(0,0,0,.5)]"
      >
        <div className="mx-auto mb-2.5 h-1 w-9 rounded bg-edge2" />
        <div className="mb-3 flex items-center gap-2.5">
          <MediaTile kind={candidate.kind} live={candidate.live} thumb={thumbs ? candidate.thumb : undefined} className="h-[45px] w-20" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[12.5px] leading-snug font-semibold">{title}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-mute">
              <Meta candidate={candidate} />
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <IconX />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto scroll-thin">
          {error && (
            <div className="mb-2 rounded-lg bg-live/10 px-2.5 py-2 text-[11.5px] text-rose-300" data-testid="inspect-error">
              {error}
            </div>
          )}
          {!inspection && !error && (
            <div aria-busy="true">
              <div className="skeleton mb-1.5 h-11 rounded-lg" />
              <div className="skeleton mb-1.5 h-11 w-4/5 rounded-lg" />
              <div className="mt-1 text-center text-[11.5px] text-mute">Reading the playlist...</div>
            </div>
          )}
          {inspection?.notes.map((n) => (
            <div key={n} className="mb-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-200">
              {n}
            </div>
          ))}
          {inspection && (
            <ul className="flex flex-col gap-1.5">
              {inspection.variants.map((v) => {
                const on = v.id === variantId;
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      data-testid="variant"
                      aria-pressed={on}
                      onClick={() => setVariantId(v.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${on ? 'border-shine bg-shine/6' : 'border-edge bg-ink hover:border-edge2'}`}
                      title={v.uri}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{v.label}</span>
                      <span className={`size-4 shrink-0 rounded-full border-2 ${on ? 'border-shine bg-[radial-gradient(circle,var(--color-shine)_45%,transparent_50%)]' : 'border-edge2'}`} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {inspection && !error && (
          <Button tone={candidate.live ? 'live' : 'shine'} onClick={() => void start()} disabled={!variantId || busy} className="mt-3 h-10 w-full justify-center text-[13px]" testId="start">
            {candidate.live ? <IconRadio /> : <IconDownload />}
            {candidate.live ? 'Start recording' : `Download${short ? ` ${short}` : ''}`}
          </Button>
        )}
        {error && (
          <Button onClick={onClose} className="mt-3 h-10 w-full justify-center text-[13px]">
            Close
          </Button>
        )}
      </div>
    </>
  );
}
