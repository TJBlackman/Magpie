import { useEffect, useState, type ReactNode, type Ref } from 'react';
import type { MediaKind } from '../core/types';
import { kindLabel } from './format';
import { IconAlert, IconCheck, IconError, IconEye, IconEyeOff, IconFilm, IconImages, IconInfo, IconRadio, IconUpdate, IconX } from './icons';

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

export type ButtonTone = 'default' | 'shine' | 'ghost' | 'danger' | 'live' | 'accent' | 'stop';

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  size = 'sm',
  title,
  className = '',
  testId,
  pressed,
  autoFocus,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  className?: string;
  testId?: string;
  /** A toggle: announces its state. */
  pressed?: boolean;
  autoFocus?: boolean;
}) {
  const cls = {
    default: 'bg-btn text-text ring-1 ring-inset ring-btn-edge hover:bg-btn-hover active:bg-btn',
    shine: 'bg-shine text-shine-ink font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_1px_2px_rgba(0,0,0,.5)] hover:bg-[#4fe0f4] active:bg-[#14bdd6]',
    ghost: 'text-mute hover:bg-btn-hover hover:text-text active:bg-btn',
    danger: 'text-[#ff9fb1] hover:bg-live/10 active:bg-live/[0.06]',
    accent: 'bg-accent-fill text-[#7ff0ff] ring-1 ring-inset ring-accent-edge hover:bg-[#163845]',
    stop: 'bg-live/[0.16] text-[#ffc2ce] ring-1 ring-inset ring-live/35 hover:bg-live/25',
    live: 'bg-live text-[#1a0a0f] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_1px_2px_rgba(0,0,0,.5)] hover:bg-[#ff7590] active:bg-[#f0466a]',
  }[tone];
  const sz = { sm: 'h-7 px-2.5 text-[12px]', md: 'h-8 px-3 text-[12.5px]', lg: 'h-10 px-4 text-[13.5px]' }[size];
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} data-testid={testId} aria-pressed={pressed} autoFocus={autoFocus} className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 ${sz} ${cls} ${className}`}>
      {children}
    </button>
  );
}

/** A square button holding one icon. `label` is what screen readers, tooltips and tests see. */
export function IconButton({ label, onClick, children, active, tone = 'default', framed, className = '', ref }: { label: string; onClick?: () => void; children: ReactNode; active?: boolean; tone?: 'default' | 'live' | 'danger'; framed?: boolean; className?: string; ref?: Ref<HTMLButtonElement> }) {
  const color =
    tone === 'live'
      ? 'text-live hover:bg-live/10'
      : tone === 'danger'
        ? 'text-mute hover:bg-live/10 hover:text-[#ff9fb1]'
        : active
          ? 'bg-accent-fill text-shine ring-1 ring-accent-edge ring-inset'
          : 'text-mute ring-inset hover:bg-btn hover:text-text hover:ring-1 hover:ring-btn-edge active:bg-btn';
  return (
    <button ref={ref} type="button" aria-label={label} title={label} onClick={onClick} className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${framed ? 'size-9 bg-btn ring-1 ring-btn-edge ring-inset hover:!bg-btn-hover' : ''} ${color} ${className}`}>
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
        <img src={thumb} alt="" data-testid="thumb" draggable={false} className={`size-full object-cover transition ${muted ? 'brightness-[.8] saturate-[.3]' : ''}`} />
      ) : (
        <div className={`flex size-full items-center justify-center ${muted ? 'opacity-50' : ''}`}>{live ? <IconRadio size={17} className="pulse" /> : kind === 'post' ? <IconImages size={17} /> : <IconFilm size={17} />}</div>
      )}
      {thumb && <span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-white/[0.06] ring-inset" />}
      {corner && <span className={`absolute right-0.5 bottom-0.5 rounded-[4px] px-1 py-px text-[9.5px] leading-[13px] font-semibold tabular-nums ${muted ? 'bg-black/60 text-[#c3ccd7]' : 'bg-black/75 text-white'}`}>{corner}</span>}
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
  hoverable,
  reserve,
}: {
  tile: ReactNode;
  title: ReactNode;
  titleTip?: string;
  titleTestId?: string;
  meta?: ReactNode;
  action?: ReactNode;
  onOpen?: () => void;
  openTip?: string;
  /** Already downloaded or in the queue: the frame and title step back, the meta line stays readable. */
  dim?: boolean;
  attrs?: Record<string, string | number | undefined>;
  children?: ReactNode;
  /** Not one button, but it has actions that show on hover: it lifts like a clickable row. */
  hoverable?: boolean;
  /** Its hover action floats over the end of the text: the text ends 44px early while hovered or focused. */
  reserve?: boolean;
}) {
  const body = (
    <>
      {tile}
      <div className={`min-w-0 flex-1 ${reserve ? 'group-focus-within:pr-11 group-hover:pr-11' : ''}`}>
        <div className={`truncate text-[13px] leading-[18px] font-semibold transition-colors ${dim ? 'text-mute' : 'text-text group-hover:text-white'}`} data-testid={titleTestId} title={titleTip}>
          {title}
        </div>
        {meta && <div className="mt-0.5 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute">{meta}</div>}
      </div>
    </>
  );
  return (
    <div {...attrs} className={`group relative rounded-xl border border-transparent bg-panel outline-offset-2 outline-text transition-colors duration-150 has-[>button:focus-visible]:outline-2 ${onOpen ? 'hover:border-edge3 hover:bg-[#18202b] active:bg-panel2' : hoverable ? 'hover:border-edge3 hover:bg-[#18202b] focus-within:border-edge3 focus-within:bg-[#18202b]' : ''}`}>
      {onOpen ? (
        <button type="button" onClick={onOpen} title={openTip} className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left focus-visible:outline-none">
          {body}
          {action}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          {body}
          <div className="flex shrink-0 items-center gap-1">{action}</div>
        </div>
      )}
      {children && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

/** Section heading inside a panel: small caps label and count on the left, actions on the right. */
export function Section({ title, count, children }: { title: ReactNode; count?: number; children?: ReactNode }) {
  return (
    <div className="mt-3.5 mb-2 flex h-7 items-center justify-between gap-2 first:mt-1.5">
      <h2 className="min-w-0 truncate text-[11px] font-semibold tracking-[0.07em] text-dim uppercase">
        {title}
        {count !== undefined && <span className="ml-1.5 font-medium text-dim tabular-nums">{count}</span>}
      </h2>
      {children && <div className="-mr-2 flex shrink-0 items-center gap-1 [&_button]:h-7 [&_button]:px-2 [&_button]:text-[12px] [&_button]:hover:bg-btn-hover">{children}</div>}
    </div>
  );
}

/** The one empty state: centered in what is left of the panel, an icon in a soft disc, a title, a line, an optional action. */
export function Empty({ icon, title, children, action, below }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; below?: ReactNode }) {
  return (
    <div className="rise-in flex flex-col items-center px-6 pt-16 pb-8 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,.07),rgba(255,255,255,.02))] text-mute">{icon}</div>
      <div className="text-[14.5px] font-semibold text-text">{title}</div>
      {children && <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-balance text-mute">{children}</p>}
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
    neutral: 'bg-white/[0.04] ring-transparent text-[#c9d2dd] [&_svg]:text-mute',
  }[tone];
  const Icon = tone === 'warn' ? IconAlert : tone === 'error' ? IconError : IconInfo;
  return (
    <div data-testid={testId} className={`flex gap-3 rounded-lg px-3 py-2.5 text-[12px] leading-[1.5] ring-1 ring-inset ${cls}`}>
      <span className="mt-px shrink-0">{icon ?? <Icon size={15} />}</span>
      <div className="min-w-0 text-pretty">
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
    <button type="button" role="switch" aria-checked={shown} onClick={onToggle} title={shown ? 'Media already in your history is listed' : `${count} downloaded ${count === 1 ? 'item is' : 'items are'} hidden`} className="inline-flex shrink-0 items-center gap-2 rounded-lg text-mute transition-colors hover:bg-btn-hover hover:text-text">
      <span className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${shown ? 'bg-shine' : 'bg-[#334152] ring-1 ring-[#5f6e80] ring-inset'}`}>
        <span className={`absolute top-0.5 left-0.5 size-2.5 rounded-full bg-white shadow transition-transform ${shown ? 'translate-x-2.5' : ''}`} />
      </span>
      Downloaded
    </button>
  );
}

/** A short message at the bottom of the popup that fades after a few seconds, with an optional action. */
export function Toast({ message, action }: { message: string | null; action?: { label: string; onClick: () => void } }) {
  if (!message) return null;
  return (
    <div role="status" className="shrink-0 px-3.5 pt-1 pb-3">
      <div className="rise-in flex h-11 items-center gap-2.5 rounded-xl bg-panel3 pr-1.5 pl-3 text-[12.5px] font-medium text-text shadow-[0_8px_24px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.06)] ring-1 ring-edge3 ring-inset">
        <span className="flex size-[18px] items-center justify-center rounded-full bg-shine/15 text-shine">
          <IconCheck size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate">{message}</span>
        {action && (
          <button type="button" onClick={action.onClick} className="h-8 rounded-lg bg-[#232d3a] px-3 text-[12.5px] font-semibold text-shine transition-colors hover:bg-shine/10">
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
      <Button tone="accent" size="md" onClick={onGet} title="Open magpie.trevorblackman.dev in a new tab">
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
