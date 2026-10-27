import { useEffect, useState, type ReactNode } from 'react';
import type { MediaKind } from '../core/types';
import { kindLabel } from './format';
import { IconFilm, IconRadio } from './icons';

export type Tone = 'default' | 'shine' | 'warn' | 'bad' | 'good' | 'file';

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  const cls = {
    default: 'bg-edge text-mute',
    shine: 'bg-shine/12 text-shine',
    warn: 'bg-amber-500/15 text-amber-300',
    bad: 'bg-live/15 text-rose-300',
    good: 'bg-emerald-500/15 text-emerald-300',
    file: 'bg-violet-500/15 text-violet-300',
  }[tone];
  return <span className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${cls}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  title,
  className = '',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'shine' | 'ghost' | 'danger' | 'live';
  title?: string;
  className?: string;
  testId?: string;
}) {
  const cls = {
    default: 'bg-edge text-text hover:bg-edge2',
    shine: 'bg-shine text-shine-ink font-bold hover:bg-cyan-300 shadow-[0_2px_8px_rgba(34,211,238,.3)]',
    ghost: 'text-mute hover:bg-panel2 hover:text-text',
    danger: 'text-rose-300 hover:bg-live/10',
    live: 'bg-live text-white font-bold hover:bg-rose-400',
  }[tone];
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition disabled:opacity-40 ${cls} ${className}`}>
      {children}
    </button>
  );
}

/** A square button holding one icon. `label` is what screen readers and tests see. */
export function IconButton({ label, onClick, children, active, tone = 'default', className = '' }: { label: string; onClick?: () => void; children: ReactNode; active?: boolean; tone?: 'default' | 'live' | 'danger'; className?: string }) {
  const color = tone === 'live' ? 'text-live hover:bg-live/10' : tone === 'danger' ? 'text-mute hover:bg-live/10 hover:text-rose-300' : active ? 'bg-shine/10 text-shine' : 'text-mute hover:bg-panel2 hover:text-text';
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition ${color} ${className}`}>
      {children}
    </button>
  );
}

const KIND_TONE: Record<MediaKind, Tone> = { hls: 'shine', dash: 'warn', file: 'file' };

/** HLS, DASH or FILE, in the kind's color. The same badge on every tab, so an item is easy to follow. */
export function KindBadge({ kind }: { kind: MediaKind }) {
  return <Badge tone={KIND_TONE[kind]}>{kindLabel(kind)}</Badge>;
}

/**
 * The 16:9 slot at the left of every row: a frame of the stream once one is
 * captured, else an icon in the kind's color. Live streams pulse either way.
 */
export function MediaTile({ kind, live, thumb, muted, className = 'h-9 w-16' }: { kind: MediaKind; live?: boolean; thumb?: string; muted?: boolean; className?: string }) {
  const tone = live ? 'bg-live/15 text-live' : { hls: 'bg-shine/12 text-shine', dash: 'bg-amber-500/15 text-amber-300', file: 'bg-violet-500/15 text-violet-300' }[kind];
  return (
    <div className={`relative ${className} shrink-0 overflow-hidden rounded-lg ${thumb ? 'bg-ink' : tone} ${muted ? 'grayscale' : ''}`}>
      {thumb ? (
        <img src={thumb} alt="" data-testid="thumb" draggable={false} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center">{live ? <IconRadio size={18} className="pulse" /> : <IconFilm size={18} />}</div>
      )}
      {thumb && live && <span className="pulse absolute top-1 left-1 size-1.5 rounded-full bg-live shadow-[0_0_4px_var(--color-live)]" />}
    </div>
  );
}

/**
 * One row, the same on This page, Downloads and History: kind tile, title,
 * meta line, action on the right, and anything extra (a progress bar) below.
 * With `onOpen` the whole row is one button and `action` is drawn inside it.
 */
export function MediaRow({
  tile,
  title,
  titleTip,
  titleTestId,
  meta,
  action,
  onOpen,
  openTip,
  dim,
  attrs,
  children,
}: {
  tile: ReactNode;
  title: ReactNode;
  titleTip?: string;
  titleTestId?: string;
  meta: ReactNode;
  action?: ReactNode;
  onOpen?: () => void;
  openTip?: string;
  /** Already downloaded or in the queue: drawn in grayscale and faded. */
  dim?: boolean;
  attrs?: Record<string, string | number | undefined>;
  children?: ReactNode;
}) {
  const body = (
    <>
      {tile}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold" data-testid={titleTestId} title={titleTip}>
          {title}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-mute">{meta}</div>
      </div>
    </>
  );
  return (
    <div {...attrs} className={`rounded-xl border border-edge bg-panel transition ${onOpen ? 'hover:border-edge2 hover:bg-panel2' : ''} ${dim ? 'opacity-50 grayscale hover:opacity-80' : ''}`}>
      {onOpen ? (
        <button type="button" onClick={onOpen} title={openTip} className="flex w-full items-center gap-2.5 p-2 text-left">
          {body}
          {action}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 p-2">
          {body}
          <div className="flex shrink-0 items-center gap-0.5">{action}</div>
        </div>
      )}
      {children && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

/** Section heading inside a panel: small caps label on the left, actions on the right. */
export function Section({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mt-2.5 mb-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wider text-dim uppercase">
      <span className="min-w-0 truncate">{title}</span>
      {children && <div className="flex shrink-0 items-center gap-0.5 tracking-normal normal-case">{children}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge2 px-4 py-7 text-center text-mute">
      <div className="mx-auto mb-2 w-fit text-dim">{icon}</div>
      <div className="mb-1 text-[13px] font-semibold text-text">{title}</div>
      {children}
    </div>
  );
}

/** A ghost button that asks for a second click within 3 seconds, for clears that cannot be undone. */
export function ConfirmButton({ children, confirm, onConfirm, title }: { children: ReactNode; confirm: string; onConfirm: () => void; title?: string }) {
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

/** Shows or hides media the history already has. Nothing when there is none. */
export function DownloadedToggle({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <Button tone="ghost" onClick={onToggle} title={shown ? 'Hide media already in your history' : 'Show media already in your history'}>
      {shown ? 'Hide downloaded' : `${count} downloaded`}
    </Button>
  );
}

/** A short message at the bottom of the popup that fades after two seconds. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="status" className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="veil-in rounded-lg bg-text px-3.5 py-2 text-xs font-semibold text-ink shadow-[0_6px_20px_rgba(0,0,0,.4)]">{message}</div>
    </div>
  );
}
