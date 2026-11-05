import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { ARCHIVE_LIMIT, MAX_CONCURRENT_LIMIT, type Settings } from '../core/settings';
import { SITE_URL } from '../core/update';
import { openPage, useSettings } from './api';
import { IconButton } from './components';
import { useDialogFocus } from './focus';
import { IconBack, IconCheck, IconMinus, IconPlus, Logo } from './icons';

export function Stepper({ id, value, min, max, onChange, draft, onDraft, onCommit, lessTitle, moreTitle, testId, compact }: { compact?: boolean; id: string; value: number; min: number; max: number; onChange: (n: number) => void; draft?: string | null; onDraft?: (v: string | null) => void; onCommit?: () => void; lessTitle: string; moreTitle: string; testId: string }) {
  const btn = `flex size-7 items-center justify-center text-mute transition-colors hover:bg-white/[0.07] hover:text-text active:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-30`;
  return (
    <div className={`flex shrink-0 items-center overflow-hidden rounded-lg bg-btn ring-1 ring-inset outline-offset-2 outline-text has-[input:focus-visible]:outline-2 ring-ctl-edge`}>
      <button type="button" tabIndex={-1} className={btn} onClick={() => onChange(value - 1)} disabled={value <= min} title={lessTitle} aria-label={lessTitle}>
        <IconMinus size={14} />
      </button>
      <input
        id={id}
        data-testid={testId}
        type="number"
        min={min}
        max={max}
        value={draft ?? value}
        onChange={(e) => {
          if (onDraft) return onDraft(e.target.value);
          const n = Number(e.target.value);
          if (n >= min && n <= max) onChange(n);
        }}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (!onCommit) return;
          if (e.key === 'Enter') onCommit();
          if (e.key === 'Escape') onDraft?.(null);
        }}
        className={`plain h-7 w-8 bg-transparent p-0 text-center text-[13px] leading-7 font-semibold text-text tabular-nums outline-none`}
      />
      <button type="button" tabIndex={-1} className={btn} onClick={() => onChange(value + 1)} disabled={value >= max} title={moreTitle} aria-label={moreTitle}>
        <IconPlus size={14} />
      </button>
    </div>
  );
}

function Switch({ id, testId, checked, onChange }: { id: string; testId: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="relative -m-2 inline-flex shrink-0 p-2">
      <input id={id} data-testid={testId} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer absolute inset-0 z-10 cursor-pointer opacity-0" />
      <span className="block h-[18px] w-8 rounded-full bg-[#6e737a] transition-colors peer-checked:bg-shine peer-checked:ring-transparent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-text" />
      <span className="pointer-events-none absolute top-[11px] left-[11px] size-3 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_1px_2px_rgba(0,0,0,.4)] transition-transform peer-checked:translate-x-3.5" />
    </span>
  );
}

/** One setting: label and a line or two of explanation on the left, its control on the right. */
function Row({ label, htmlFor, control, children, whole }: { label: string; htmlFor: string; control: ReactNode; children: ReactNode; whole?: boolean }) {
  const text = (
    <>
      <span className="block text-[13px] leading-5 font-semibold text-text">{label}</span>
      <span className="mt-0.5 block text-[11.5px] leading-[1.45] text-pretty text-mute">{children}</span>
    </>
  );
  // A switch row is one label: anywhere on it flips the switch.
  if (whole)
    return (
      <label htmlFor={htmlFor} className="flex cursor-pointer items-center gap-4 px-3.5 py-3 transition-colors hover:bg-white/[0.02]">
        <span className="min-w-0 flex-1">{text}</span>
        {control}
      </label>
    );
  return (
    <div className="flex items-center gap-4 px-3.5 py-3">
      <label htmlFor={htmlFor} className="min-w-0 flex-1 cursor-pointer">
        {text}
      </label>
      {control}
    </div>
  );
}

/** A titled card of settings, rows split by hairlines. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-0.5 text-[12.5px] font-semibold text-mute">{title}</h2>
      <div className="card-surface divide-y divide-edge overflow-hidden rounded-[14px]">{children}</div>
    </section>
  );
}

/** Settings, sliding in over the popup. Changes save as you make them. `latest` is a newer version on the website, if any. */
export function SettingsPanel({ latest, onClose }: { latest: string | null; onClose: () => void }) {
  const [settings, save] = useSettings();
  const [saved, setSaved] = useState(false);
  const dialog = useDialogFocus();
  /** The history size being typed. Saved on Enter or leaving the field, so typing "50" never saves a 5 that trims the list. */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  const update = async (patch: Partial<Settings>) => {
    if (!settings) return;
    await save({ ...settings, ...patch });
    setSaved(true);
  };
  const commitSize = () => {
    if (sizeDraft === null || !settings) return;
    const n = Math.round(Number(sizeDraft));
    setSizeDraft(null);
    if (sizeDraft.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= ARCHIVE_LIMIT && n !== settings.archiveSize) void update({ archiveSize: n });
  };

  return (
    <div className="panel-in absolute inset-0 z-20 flex flex-col bg-ink outline-none" role="dialog" aria-modal="true" aria-label="Settings" {...dialog}>
      <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-edge px-2.5">
        <IconButton label="Back" onClick={onClose}>
          <IconBack size={18} />
        </IconButton>
        <h1 className="font-display flex-1 text-[17px] font-semibold">Settings</h1>
        <span className={`mr-1.5 flex items-center gap-1 text-[12px] font-medium text-emerald-300 transition-opacity ${saved ? 'opacity-100' : 'opacity-0'}`} data-testid="saved">
          <IconCheck size={13} />
          Saved
        </span>
      </header>
      {settings && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 pt-3.5 pb-8 scroll-thin [mask-image:linear-gradient(to_bottom,#000_calc(100%-14px),rgb(0_0_0/0.15))]">
          <Group title="Downloads">
            <Row
              label="Downloads at a time"
              htmlFor="max-concurrent"
              control={<Stepper id="max-concurrent" testId="max-concurrent" value={settings.maxConcurrent} min={1} max={MAX_CONCURRENT_LIMIT} onChange={(n) => void update({ maxConcurrent: n })} lessTitle="One fewer" moreTitle="One more" />}
            >
              The rest wait in line. Live recordings don't count. 2 or 3 fill a fast connection.
            </Row>
            <Row whole label="Read video details" htmlFor="thumbnails" control={<Switch id="thumbnails" testId="thumbnails" checked={settings.thumbnails} onChange={(on) => void update({ thumbnails: on })} />}>
              Shows each video's frame, quality, length and size, and whether it is protected. Reads a small piece of each video while this popup is open.
            </Row>
          </Group>
          <Group title="History">
            <Row
              label="History size"
              htmlFor="archive-size"
              control={
                <Stepper
                  id="archive-size"
                  testId="archive-size"
                  value={settings.archiveSize}
                  min={0}
                  max={ARCHIVE_LIMIT}
                  onChange={(n) => void update({ archiveSize: n })}
                  draft={sizeDraft}
                  onDraft={setSizeDraft}
                  onCommit={commitSize}
                  lessTitle="Keep one entry less"
                  moreTitle="Keep one entry more"
                />
              }
            >
              Downloads to remember and mark on the page. 0 turns it off.
            </Row>
            <Row whole label="Remember private windows" htmlFor="archive-private" control={<Switch id="archive-private" testId="archive-private" checked={settings.archivePrivate} onChange={(on) => void update({ archivePrivate: on })} />}>
              When off, downloads from private windows leave History once the last private window closes.
            </Row>
          </Group>
          <Group title="Updates">
            <Row whole label="Tell me about new versions" htmlFor="update-check" control={<Switch id="update-check" testId="update-check" checked={settings.updateCheck} onChange={(on) => void update({ updateCheck: on })} />}>
              Checks magpie.trevorblackman.dev twice a day at most. Sends nothing about you.
            </Row>
          </Group>
          <div className="mt-auto flex items-center justify-center gap-2 pt-1 text-[11.5px] text-dim">
            <span className="flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-[#6cebdd] to-shine text-[#0e1113]">
              <Logo size={13} />
            </span>
            <span>Magpie {browser.runtime.getManifest().version}</span>
            {latest && (
              <>
                <span>·</span>
                <button type="button" className="font-medium text-shine hover:underline" onClick={() => openPage(SITE_URL)} data-testid="update-link">
                  {latest} available
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
