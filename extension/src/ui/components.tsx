import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { MediaKind } from '../core/types';
import { kindLabel } from './format';
import { IconAlert, IconCheck, IconClock, IconError, IconExternal, IconEye, IconEyeOff, IconFilm, IconImages, IconInfo, IconLock, IconRadio, IconUpdate, IconX, Logo } from './icons';

export type Tone = 'default' | 'shine' | 'warn' | 'saved' | 'bad' | 'good' | 'post';

/** A small all caps tag. Tinted, with a hairline ring in its own color, so every tag reads as one family. */
export function Badge({ children, tone = 'default', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  const cls = {
    default: 'bg-[#2a2d31] text-fg2 ring-white/[0.06]',
    shine: 'bg-shine/10 text-[#83f3e5] ring-shine/25',
    // Already saved: a neutral tag with a teal check. It is done, not a warning.
    saved: 'bg-[#2a2d31] text-fg2 [&>svg]:text-shine',
    warn: 'bg-amber-400/10 text-amber-200 ring-amber-400/25',
    bad: 'bg-live/[0.13] text-live-soft ring-live/30',
    good: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/25',
    post: 'bg-orange-500/[0.12] text-orange-200 ring-orange-400/25',
  }[tone];
  return <span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] leading-none font-semibold ${cls} ${className}`}>{children}</span>;
}

export type ButtonTone = 'default' | 'shine' | 'ghost' | 'danger' | 'live' | 'accent' | 'stop' | 'destroy';

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
    default: 'bg-[#2c2f33] text-text hover:bg-[#363a3f] active:bg-[#2c2f33]',
    shine: 'bg-shine text-shine-ink font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.35),inset_0_-1px_0_rgba(0,0,0,.18),0_1px_2px_rgba(0,0,0,.5)] hover:bg-[#4ee2da] active:bg-[#19bfb7]',
    ghost: 'text-mute hover:bg-btn-hover hover:text-text active:bg-btn',
    danger: 'text-err hover:bg-err/10 active:bg-err/[0.06]',
    accent: 'bg-[#2c2f33] text-text hover:bg-[#363a3f] active:bg-[#2c2f33]',
    stop: 'bg-[#2c2f33] text-text hover:bg-[#363a3f] active:bg-[#2c2f33] [&>svg]:text-live',
    destroy: 'bg-[#c4373c] text-white font-semibold hover:bg-[#d13c41] active:bg-[#b02f34]',
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
        ? '!rounded-full text-mute hover:bg-white/[0.08] hover:text-text'
        : active
          ? '!bg-sel-fill text-shine ring-1 !ring-sel-edge ring-inset'
          : framed
            ? 'text-text'
            : 'text-mute ring-inset hover:bg-btn hover:text-text hover:ring-1 hover:ring-btn-edge active:bg-btn';
  return (
    <button ref={ref} type="button" aria-label={label} title={label} onClick={onClick} className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${framed ? '!rounded-full ring-1 ring-ctl-edge ring-inset group-hover:ring-hover-edge group-has-[:focus-visible]:ring-hover-edge hover:!bg-[#282b2e] hover:!ring-[#90959b]' : ''} ${color} ${className}`}>
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
      Live
    </Badge>
  );
}

/**
 * The 16:9 slot at the left of every row: a frame of the stream once one is
 * captured, else an icon on a quiet gradient. Live streams pulse either way.
 * `corner` is drawn over the bottom right, like a length on a video player.
 */
export function MediaTile({ kind, live, locked, thumb, muted, corner, className = 'h-10 w-[71px]' }: { kind: MediaKind; live?: boolean; locked?: boolean; thumb?: string; muted?: boolean; corner?: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className} shrink-0`}>
      <div className={`relative size-full overflow-hidden rounded-lg shadow-[0_2px_6px_rgba(0,0,0,.4)] bg-gradient-to-br from-panel3 to-panel2 ${live && !thumb ? 'text-live' : 'text-dim'}`}>
        {thumb ? (
          <img src={thumb} alt="" data-testid="thumb" draggable={false} className={`size-full object-cover transition ${muted ? 'brightness-[.8] saturate-[.8]' : ''}`} />
        ) : (
          <div className={`flex size-full items-center justify-center ${locked ? 'bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.035)_0_6px,transparent_6px_12px)]' : ''} ${muted ? 'opacity-50' : ''}`}>{locked ? <IconLock size={17} /> : live ? <IconRadio size={17} className="pulse" /> : kind === 'post' ? <IconImages size={17} /> : <IconFilm size={17} />}</div>
        )}
        {thumb && <span className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-white/[0.08] ring-inset" />}
        {corner && <span className={`absolute right-1 bottom-1 rounded-[4px] px-1 text-[10px] leading-[13px] font-medium tabular-nums bg-black/65 text-text`}>{corner}</span>}
      </div>
    </div>
  );
}

let measure: CanvasRenderingContext2D | null | undefined;
/** The width of `text` in the font of `style`, in CSS px. */
export function textWidth(text: string, style: CSSStyleDeclaration): number {
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return 0;
  measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  measure.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
  return measure.measureText(text).width;
}
export const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'off', 'on', 'or', 'over', 'the', 'to', 'with']);
/** How much of `text` fits `width` with an ellipsis after it, cut back past spaces and joining punctuation. */
function fitLength(text: string, width: number, style: CSSStyleDeclaration): number {
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return text.length;
  measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  measure.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
  if (measure.measureText(text).width <= width) return text.length;
  const trim = (s: string) => s.replace(/[\s,.·:;–—-]+$/, '');
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure.measureText(`${trim(text.slice(0, mid))}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  // A cut inside a word ("Platt…") steps back to the end of the word before. Only a word longer than the line is cut in the middle.
  const inWord = /[\p{L}\p{N}]/u.test(text[lo] ?? '') && /[\p{L}\p{N}]/u.test(text[lo - 1] ?? '');
  const space = inWord ? text.lastIndexOf(' ', lo) : -1;
  let out = trim(text.slice(0, space > 0 && lo - space <= 16 ? space : lo));
  // Nor does it end on a small joining word ("Breaching off…").
  for (let last = /\s(\p{L}+)$/u.exec(out); last && SMALL.has(last[1]!.toLowerCase()); last = /\s(\p{L}+)$/u.exec(out)) out = trim(out.slice(0, last.index));
  return out.length;
}

/**
 * One line of text cut to fit, with the ellipsis right after the last word or
 * letter, never after a space. The cut part stays in the page for screen
 * readers and search; CSS truncation still applies if the measure is off.
 */
export function FitText({ text, mark }: { text: string; mark?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(text.length);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const run = () => setCut(fitLength(text, box.clientWidth - 1, getComputedStyle(box)));
    run();
    const watch = new ResizeObserver(run);
    watch.observe(box);
    return () => watch.disconnect();
  }, [text]);
  const shown = marked(text.slice(0, cut), text, mark);
  if (cut >= text.length) return <span ref={ref}>{shown}</span>;
  return (
    <span ref={ref}>
      {shown}
      <span aria-hidden="true" className="after:content-['…']" />
      <span className="sr-only">{text.slice(cut)}</span>
    </span>
  );
}

/** `shown` (the start of `full`) with the part that matches `query` marked, as far as it shows. */
function marked(shown: string, full: string, query?: string): ReactNode {
  const q = query?.trim() ?? '';
  const at = q ? full.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0 || at >= shown.length) return shown;
  const end = Math.min(at + q.length, shown.length);
  return (
    <>
      {shown.slice(0, at)}
      <mark className="rounded-[3px] bg-shine/[0.2] text-[#83f3e5]">{shown.slice(at, end)}</mark>
      {shown.slice(end)}
    </>
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
  overlay,
  inset,
  hoverReserve,
  wrapTitle,
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
  /** Room for a control drawn over the row, left of its action: the text always ends 44px early, so nothing moves on hover. */
  reserve?: boolean;
  /** The same room, made only while the row is hovered or focused, when that control shows. */
  hoverReserve?: boolean;
  /** A control drawn over the row, outside its button. */
  overlay?: ReactNode;
  /** One row of a list that shares one raised surface (RowList): no surface of its own, a soft fill on hover. */
  inset?: boolean;
  /** The title may take two lines (rows whose actions take room). */
  wrapTitle?: boolean;
}) {
  const body = (
    <>
      {tile}
      <div className={`min-w-0 flex-1 ${reserve ? 'pr-11' : hoverReserve ? 'group-hover:pr-11 group-has-[:focus-visible]:pr-11' : ''}`}>
        <div className={`${wrapTitle ? 'line-clamp-2 text-pretty' : 'truncate'} text-[13px] leading-[18px] font-medium transition-colors ${dim ? 'text-fg2' : 'text-text'}`} data-testid={titleTestId} title={titleTip}>
          {typeof title === 'string' && !wrapTitle ? <FitText text={title} /> : title}
        </div>
        {meta && <div className="mt-0.5 flex h-[18px] items-center gap-1.5 text-[11.5px] text-mute tabular-nums">{meta}</div>}
      </div>
    </>
  );
  const root = inset
    ? `group relative rounded-[10px] outline-offset-2 outline-text transition-colors duration-150 hover:z-10 has-[:focus-visible]:z-10 has-[[role=menu]]:z-30 has-[>button.row-main:focus-visible]:outline-2 ${onOpen ? 'hover:bg-row-hover has-[.row-main:focus-visible]:bg-row-hover has-[.quick:hover]:bg-transparent' : hoverable ? 'hover:bg-row-hover focus-within:bg-row-hover' : ''}`
    : `card-surface group relative rounded-[14px] border border-transparent outline-offset-2 outline-text transition-[border-color,background-image] duration-150 hover:z-10 has-[:focus-visible]:z-10 has-[>button.row-main:focus-visible]:outline-2 ${onOpen ? 'hover:border-hover-edge hover:[background-image:linear-gradient(180deg,#222529,#1d2023)] has-[.row-main:focus-visible]:border-hover-edge has-[.row-main:focus-visible]:[background-image:linear-gradient(180deg,#222529,#1d2023)] has-[.quick:hover]:border-transparent' : hoverable ? 'hover:border-hover-edge focus-within:border-hover-edge' : ''}`;
  const pad = inset ? 'p-2' : 'px-2.5 py-2.5';
  return (
    <div {...attrs} className={root}>
      {onOpen ? (
        <button type="button" onClick={onOpen} title={openTip} className={`row-main flex w-full cursor-pointer items-center gap-3 text-left focus-visible:outline-none ${inset ? 'rounded-[10px]' : 'rounded-[14px]'} ${pad}`}>
          {body}
          {action}
        </button>
      ) : (
        <div className={`flex items-center gap-3 ${pad}`}>
          {body}
          <div className="flex shrink-0 items-center gap-1">{action}</div>
        </div>
      )}
      {overlay}
      {children && <div className={inset ? 'px-2 pb-2' : 'px-2.5 pb-2.5'}>{children}</div>}
    </div>
  );
}

/** Rows that share one raised surface, each lighting up on hover: This page and History. */
export function RowList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="card-surface flex flex-col rounded-[16px] p-1.5">
      {children}
    </div>
  );
}

/** Section heading inside a panel: small caps label and count on the left, actions on the right. */
export function Section({ title, count, children }: { title: ReactNode; count?: number; children?: ReactNode }) {
  return (
    <div className="mt-5 mb-2 flex h-7 items-center justify-between gap-2 first:mt-1.5">
      <h2 className="min-w-0 translate-y-px truncate text-[13px] font-medium text-mute">
        {title}
        {count !== undefined && <span className="ml-1.5 font-medium text-dim tabular-nums">{count}</span>}
      </h2>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** The one empty state: centered in what is left of the panel, an icon in a soft disc, a title, a line, an optional action. */
export function Empty({ icon, title, children, action, below }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; below?: ReactNode }) {
  return (
    <div className="rise-in flex flex-col items-center px-6 pt-28 pb-8 text-center">
      <div className="relative mb-5 flex size-16 items-center justify-center" aria-hidden="true">
        <span className="absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgba(31,216,207,.13),rgba(31,216,207,0))]" />
        <span className="absolute -inset-2.5 rounded-[28px] ring-1 ring-white/[0.05] ring-inset" />
        <span className="relative flex size-16 items-center justify-center rounded-[22px] bg-[linear-gradient(180deg,#34383d,#1f2226)] shadow-[0_10px_24px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.07)] ring-1 ring-white/[0.07] ring-inset">
          <Logo size={42} />
          <span className="absolute -right-2 -bottom-2 flex size-7 items-center justify-center rounded-full bg-[#2a2d31] text-[#83f3e5] ring-[3px] ring-[#0b0c0d] [&>svg]:size-[14px]">{icon}</span>
        </span>
      </div>
      <div className="font-display text-[17px] font-semibold text-text">{title}</div>
      {children && <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-balance text-mute">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
      {below && <div className="mt-5">{below}</div>}
    </div>
  );
}

/** A boxed note: one neutral box for every tone, the tone carried by its icon: info (accent), warn (yellow), error (red), neutral (grey). */
export function Callout({ tone, title, children, testId, icon }: { tone: 'info' | 'warn' | 'error' | 'neutral'; title?: string; children: ReactNode; testId?: string; icon?: ReactNode }) {
  const cls = {
    info: '[&>span>svg]:text-mute',
    warn: '[&>span>svg]:text-saved',
    error: '[&>span>svg]:text-[#f2b84b]',
    neutral: '[&>span>svg]:text-mute',
  }[tone];
  const Icon = tone === 'warn' ? IconAlert : tone === 'error' ? IconError : IconInfo;
  return (
    <div data-testid={testId} className={`flex gap-3 rounded-xl bg-[#181a1c] px-3.5 py-3 text-[12px] leading-[1.5] text-fg2 ${cls}`}>
      <span className="mt-px shrink-0">{icon ?? <Icon size={15} />}</span>
      <div className="min-w-0 text-pretty">
        {title && <div className="mb-0.5 font-semibold text-text">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** The one text action in a section header: grey until hovered, 32px tall, its words saying what it acts on. */
export function TextButton({ children, onClick, title, label, armed }: { children: ReactNode; onClick: () => void; title?: string; label?: string; armed?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={label} className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] font-semibold ring-1 ring-inset transition-colors ${armed ? 'bg-err/[0.16] text-[#fecaca] ring-err/40' : '-mr-2.5 text-[#83f3e5] ring-transparent hover:bg-shine/10'}`}>
      {children}
    </button>
  );
}

/** A text action that asks for a second click within 3 seconds, for clears that cannot be undone. */
export function ConfirmButton({ children, confirm, onConfirm, title, label }: { children: ReactNode; confirm: string; onConfirm: () => void; title?: string; label?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <TextButton
      armed={armed}
      title={title}
      label={armed ? undefined : label}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirm : children}
    </TextButton>
  );
}

/** The one switch look, 32 by 18: the list filter and every setting. */
export function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-colors ${on ? 'bg-shine' : 'bg-[#6e737a]'}`}>
      <span className={`absolute top-[3px] left-[3px] size-3 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_1px_2px_rgba(0,0,0,.4)] transition-transform ${on ? 'translate-x-3.5' : ''}`} />
    </span>
  );
}

/** Shows or hides media the history already has: one line at the top of the list. Nothing when there is none. */
export function DownloadedToggle({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 text-[12px] text-mute">
      <span className="min-w-0 truncate text-[13px] font-medium text-mute">
        Already downloaded<span className="ml-1.5 font-medium text-dim tabular-nums">{count}</span>
      </span>
      <button type="button" role="switch" aria-checked={shown} aria-label="Show downloaded" onClick={onToggle} className="-mr-2.5 inline-flex h-8 shrink-0 items-center rounded-lg px-2.5 text-[12px] font-semibold text-[#83f3e5] transition-colors hover:bg-shine/10">
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** A short message at the bottom of the popup that fades after a few seconds, with up to two actions; the last is the main one. */
export function Toast({ message, detail, actions = [], live, queued, duration, held, onHold }: { message: string | null; detail?: string; actions?: { label: string; onClick: () => void }[]; live?: boolean; queued?: boolean; duration?: number; held?: boolean; onHold?: (on: boolean) => void }) {
  if (!message) return null;
  return (
    <div role="status" onMouseEnter={() => onHold?.(true)} onMouseLeave={() => onHold?.(false)} onFocus={() => onHold?.(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onHold?.(false)} className="absolute inset-x-0 bottom-0 z-[15] bg-[linear-gradient(180deg,rgba(11,12,13,0),#0b0c0d_28px)] px-3.5 pt-9 pb-3">
      <div className="rise-in relative flex min-h-11 items-center gap-2.5 overflow-hidden rounded-xl bg-panel3 py-2.5 pr-2.5 pl-3 text-[12.5px] font-medium text-text shadow-[0_12px_32px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.06)] ring-1 ring-white/[0.07] ring-inset">
        <span className={`flex size-[18px] items-center justify-center rounded-full ${live ? 'bg-[#4a2631]' : 'bg-[#0d4041] text-shine'}`}>
          {live ? <span className="size-2 rounded-full bg-live" /> : queued ? <IconClock size={12} /> : <IconCheck size={12} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{message}</span>
          {detail && <span className="block truncate text-[12px] font-normal text-mute">{detail}</span>}
        </span>
        {actions.map((a, i) => (
          <button key={a.label} type="button" onClick={a.onClick} className="h-8 rounded-lg bg-[#33363b] px-3 text-[12.5px] font-semibold text-text transition-colors hover:bg-[#3d4046]">
            {a.label}
          </button>
        ))}
        {/* How long the toast stays: a line that drains, and waits while the pointer or focus is on the toast. */}
        {/* The toast waits while pointed at or focused; no timer line. */}
      </div>
    </div>
  );
}

/** A line under the header when the website has a newer Magpie. Update opens the download page; X hides it until the next version. */
export function UpdateBanner({ version, onGet, onDismiss }: { version: string; onGet: () => void; onDismiss: () => void }) {
  return (
    <div role="status" data-testid="update" className="mx-3.5 mb-2.5 flex h-11 items-center gap-2.5 rounded-xl bg-[#181a1c] pr-0 pl-3 text-[12.5px]">
      <IconUpdate size={16} className="shrink-0 text-shine" />
      <span className="min-w-0 flex-1 truncate text-mute">
        <b className="font-semibold text-text">Magpie {version}</b> is out
      </span>
      <Button tone="accent" size="md" onClick={onGet} title="Open magpie.trevorblackman.dev in a new tab">
        Update
        <IconExternal size={13} />
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
