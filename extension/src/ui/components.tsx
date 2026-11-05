import { useEffect, useState, type ReactNode } from 'react';
import type { MediaKind } from '../core/types';
import { kindLabel } from './format';
import { IconAlert, IconCheck, IconError, IconFilm, IconImages, IconInfo, IconRadio, IconUpdate, IconX } from './icons';

export type Tone = 'default' | 'shine' | 'warn' | 'saved' | 'bad' | 'good' | 'post';

/** A small all caps tag. Tinted, with a hairline ring in its own color, so every tag reads as one family. */
export function Badge({ children, tone = 'default', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  const cls = {
    default: 'bg-white/[0.06] text-[#b4bfcc] ring-white/[0.07]',
    shine: 'bg-shine/10 text-[#67e8f9] ring-shine/25',
    warn: 'bg-amber-400/10 text-amber-200 ring-amber-400/25',
    // Already downloaded: the only yellow in the popup, so it reads as a caution without shouting.
    saved: 'bg-saved/[0.14] text-[#fde68a] ring-saved/40',
    bad: 'bg-live/[0.13] text-[#ff9fb1] ring-live/30',
    good: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/25',
    post: 'bg-orange-500/[0.12] text-orange-200 ring-orange-400/25',
  }[tone];
  return <span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10px] leading-none font-semibold tracking-[0.04em] ring-1 ring-inset ${cls} ${className}`}>{children}</span>;
}

export type ButtonTone = 'default' | 'shine' | 'ghost' | 'danger' | 'live';

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  size = 'sm',
  title,
  className = '',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  className?: string;
  testId?: string;
}) {
  const cls = {
    default: 'bg-white/[0.07] text-text ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.11] active:bg-white/[0.05]',
    shine: 'bg-shine text-shine-ink font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_1px_2px_rgba(0,0,0,.5)] hover:bg-[#4fe0f4] active:bg-[#14bdd6]',
    ghost: 'text-mute hover:bg-white/[0.06] hover:text-text active:bg-white/[0.04]',
    danger: 'text-[#ff9fb1] hover:bg-live/10 active:bg-live/[0.06]',
    live: 'bg-live-solid text-white font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.2),0_1px_2px_rgba(0,0,0,.5)] hover:bg-[#f0335a] active:bg-[#c8133c]',
  }[tone];
  const sz = { sm: 'h-7 px-2.5 text-[12px]', md: 'h-8 px-3 text-[12.5px]', lg: 'h-10 px-4 text-[13.5px]' }[size];
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} data-testid={testId} className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 ${sz} ${cls} ${className}`}>
      {children}
    </button>
  );
}

/** A square button holding one icon. `label` is what screen readers, tooltips and tests see. */
export function IconButton({ label, onClick, children, active, tone = 'default', framed, className = '' }: { label: string; onClick?: () => void; children: ReactNode; active?: boolean; tone?: 'default' | 'live' | 'danger'; framed?: boolean; className?: string }) {
  const color =
    tone === 'live'
      ? 'text-live hover:bg-live/10'
      : tone === 'danger'
        ? 'text-mute hover:bg-live/10 hover:text-[#ff9fb1]'
        : active
          ? 'bg-shine/10 text-shine'
          : 'text-mute hover:bg-white/[0.07] hover:text-text active:bg-white/[0.04]';
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${framed ? 'bg-white/[0.03] ring-1 ring-white/[0.08] ring-inset' : ''} ${color} ${className}`}>
      {children}
    </button>
  );
}

/** HLS, DASH, FILE or REDDIT, neutral: the format is a detail, so colour stays free for status. */
export function KindBadge({ kind }: { kind: MediaKind }) {
  return <Badge>{kindLabel(kind)}</Badge>;
}

/** LIVE with a beating dot. */
export function LiveBadge() {
  return (
    <Badge tone="bad">
      <span className="pulse size-1.5 rounded-full bg-live" />
      LIVE
    </Badge>
  );
}

/**
 * The 16:9 slot at the left of every row: a frame of the stream once one is
 * captured, else an icon on a quiet gradient. Live streams pulse either way.
 * `corner` is drawn over the bottom right, like a length on a video player.
 */
export function MediaTile({ kind, live, thumb, muted, corner, className = 'h-9 w-16' }: { kind: MediaKind; live?: boolean; thumb?: string; muted?: boolean; corner?: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className} shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-panel3 to-panel2 ring-1 ring-white/[0.06] ring-inset ${live && !thumb ? 'text-live' : 'text-dim'}`}>
      {thumb ? (
        <img src={thumb} alt="" data-testid="thumb" draggable={false} className={`size-full object-cover transition ${muted ? 'opacity-50 saturate-[.3]' : ''}`} />
      ) : (
        <div className={`flex size-full items-center justify-center ${muted ? 'opacity-50' : ''}`}>{live ? <IconRadio size={17} className="pulse" /> : kind === 'post' ? <IconImages size={17} /> : <IconFilm size={17} />}</div>
      )}
      {thumb && <span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-white/[0.06] ring-inset" />}
      {thumb && live && <span className="pulse absolute top-1 left-1 size-1.5 rounded-full bg-live shadow-[0_0_4px_var(--color-live)]" />}
      {corner && <span className="absolute right-0.5 bottom-0.5 rounded-[4px] bg-black/75 px-1 py-px text-[9.5px] leading-[13px] font-semibold text-white tabular-nums">{corner}</span>}
    </div>
  );
}

/**
 * One row, the same on This page, Downloads and History: tile, title, meta
 * line, action on the right, and anything extra (a progress bar) below.
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
  /** Already downloaded or in the queue: the frame and title step back, the meta line stays readable. */
  dim?: boolean;
  attrs?: Record<string, string | number | undefined>;
  children?: ReactNode;
}) {
  const body = (
    <>
      {tile}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[13px] leading-[18px] font-semibold transition-colors ${dim ? 'text-mute' : 'text-text group-hover:text-white'}`} data-testid={titleTestId} title={titleTip}>
          {title}
        </div>
        <div className="mt-1 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">{meta}</div>
      </div>
    </>
  );
  return (
    <div {...attrs} className={`group relative rounded-xl border border-edge bg-panel transition-colors duration-150 ${onOpen ? 'hover:border-edge3 hover:bg-[#18202b] active:bg-panel2' : ''}`}>
      {onOpen ? (
        <button type="button" onClick={onOpen} title={openTip} className="flex w-full cursor-pointer items-center gap-3 rounded-xl p-2 pr-2.5 text-left focus-visible:outline-offset-[3px]">
          {body}
          {action}
        </button>
      ) : (
        <div className="flex items-center gap-3 p-2 pr-2">
          {body}
          <div className="flex shrink-0 items-center gap-1">{action}</div>
        </div>
      )}
      {children && <div className="px-2.5 pt-0.5 pb-2.5">{children}</div>}
    </div>
  );
}

/** Section heading inside a panel: small caps label and count on the left, actions on the right. */
export function Section({ title, count, children }: { title: ReactNode; count?: number; children?: ReactNode }) {
  return (
    <div className="mt-3 mb-2 flex h-7 items-center justify-between gap-2 first:mt-1.5">
      <h2 className="min-w-0 truncate text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
        {title}
        {count !== undefined && <span className="ml-1.5 font-medium text-dim/80 tabular-nums">{count}</span>}
      </h2>
      {children && <div className="-mr-2 flex shrink-0 items-center gap-0.5 [&_button]:h-7 [&_button]:px-2 [&_button]:text-[12px]">{children}</div>}
    </div>
  );
}

/** The one empty state: centered in what is left of the panel, an icon in a soft disc, a title, a line, an optional action. */
export function Empty({ icon, title, children, action, below }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; below?: ReactNode }) {
  return (
    <div className="rise-in flex flex-col items-center px-6 pt-[18%] pb-8 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,.07),rgba(255,255,255,.02))] text-mute">{icon}</div>
      <div className="text-[14.5px] font-semibold text-text">{title}</div>
      {children && <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-mute">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
      {below && <div className="mt-5">{below}</div>}
    </div>
  );
}

/** A boxed note with an icon: info (blue), warn (amber), error (rose). */
export function Callout({ tone, title, children, testId, icon }: { tone: 'info' | 'warn' | 'error' | 'neutral'; title?: string; children: ReactNode; testId?: string; icon?: ReactNode }) {
  const cls = {
    info: 'bg-sky-400/[0.07] ring-sky-300/20 text-sky-100/90 [&_svg]:text-sky-300',
    warn: 'bg-amber-400/[0.09] ring-amber-300/30 text-amber-100/90 [&_svg]:text-amber-300',
    error: 'bg-rose-500/[0.09] ring-rose-300/25 text-rose-100/90 [&_svg]:text-rose-300',
    neutral: 'bg-white/[0.04] ring-white/[0.09] text-[#c9d2dd] [&_svg]:text-mute',
  }[tone];
  const Icon = tone === 'warn' ? IconAlert : tone === 'error' ? IconError : IconInfo;
  return (
    <div data-testid={testId} className={`flex gap-2.5 rounded-lg px-3 py-2.5 text-[12px] leading-[1.5] ring-1 ring-inset ${cls}`}>
      <span className="mt-px shrink-0">{icon ?? <Icon size={15} />}</span>
      <div className="min-w-0">
        {title && <div className="mb-0.5 font-semibold text-white">{title}</div>}
        {children}
      </div>
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
      className={armed ? 'bg-live/10' : ''}
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

/** A short message at the bottom of the popup that fades after a few seconds, with an optional action. */
export function Toast({ message, action }: { message: string | null; action?: { label: string; onClick: () => void } }) {
  if (!message) return null;
  return (
    <div role="status" className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="rise-in pointer-events-auto flex h-10 items-center gap-2.5 rounded-xl bg-panel3 pr-1.5 pl-3 text-[12.5px] font-medium text-text shadow-[0_12px_32px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.06)] ring-1 ring-edge3 ring-inset">
        <span className="flex size-[18px] items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <IconCheck size={12} />
        </span>
        {message}
        {action && (
          <button type="button" onClick={action.onClick} className="ml-1 h-7 rounded-lg px-2.5 text-[12.5px] font-semibold text-shine transition-colors hover:bg-shine/10">
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** A line under the header when the website has a newer Magpie. Get it opens the download page; X hides it until the next version. */
export function UpdateBanner({ version, onGet, onDismiss }: { version: string; onGet: () => void; onDismiss: () => void }) {
  return (
    <div role="status" data-testid="update" className="mx-3.5 mb-2.5 flex h-11 items-center gap-2.5 rounded-xl bg-gradient-to-r from-shine/[0.13] to-indigo-400/[0.08] pr-1.5 pl-3 text-[12.5px] ring-1 ring-shine/25 ring-inset">
      <IconUpdate size={16} className="shrink-0 text-shine" />
      <span className="min-w-0 flex-1 truncate text-mute">
        <b className="font-semibold text-text">Magpie {version}</b> is out
      </span>
      <Button tone="shine" onClick={onGet} title="Open magpie.trevorblackman.dev in a new tab">
        Get it
      </Button>
      <IconButton label="Hide until the next version" onClick={onDismiss}>
        <IconX size={15} />
      </IconButton>
    </div>
  );
}

/** A ring that fills with a job's progress, for a card whose download is running. `pct` null spins. */
export function ProgressRing({ pct, live }: { pct: number | null; live?: boolean }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const color = live ? 'var(--color-live)' : 'var(--color-shine)';
  return (
    <svg viewBox="0 0 36 36" className={`size-9 shrink-0 ${pct === null ? 'animate-spin [animation-duration:1.4s]' : ''}`} aria-hidden="true">
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--color-edge2)" strokeWidth="3" />
      <circle cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={pct === null ? c * 0.72 : c * (1 - pct)} transform="rotate(-90 18 18)" className="transition-[stroke-dashoffset] duration-300" />
      {pct !== null && (
        <text x="18" y="18" textAnchor="middle" dominantBaseline="central" fill="var(--color-text)" fontSize="9.5" fontWeight="650" className="tabular-nums">
          {Math.floor(pct * 100)}
        </text>
      )}
    </svg>
  );
}
