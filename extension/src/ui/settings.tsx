import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { ARCHIVE_LIMIT, MAX_CONCURRENT_LIMIT, type Settings } from '../core/settings';
import { SITE_URL } from '../core/update';
import { openPage, useSettings } from './api';
import { IconButton } from './components';
import { IconBack, IconMinus, IconPlus } from './icons';

function Stepper({ id, value, min, max, onChange, draft, onDraft, onCommit, lessTitle, moreTitle, testId }: { id: string; value: number; min: number; max: number; onChange: (n: number) => void; draft?: string | null; onDraft?: (v: string | null) => void; onCommit?: () => void; lessTitle: string; moreTitle: string; testId: string }) {
  const btn = 'flex size-8 items-center justify-center text-mute transition hover:bg-panel2 hover:text-text disabled:opacity-30';
  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-edge2 bg-ink">
      <button type="button" className={btn} onClick={() => onChange(value - 1)} disabled={value <= min} title={lessTitle} aria-label={lessTitle}>
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
        className="plain w-11 bg-transparent text-center text-[13px] font-semibold text-text tabular-nums outline-none"
      />
      <button type="button" className={btn} onClick={() => onChange(value + 1)} disabled={value >= max} title={moreTitle} aria-label={moreTitle}>
        <IconPlus size={14} />
      </button>
    </div>
  );
}

function Switch({ id, testId, checked, onChange }: { id: string; testId: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="relative inline-flex shrink-0">
      <input id={id} data-testid={testId} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer absolute inset-0 cursor-pointer opacity-0" />
      <span className="block h-[22px] w-[38px] rounded-full bg-edge2 transition peer-checked:bg-shine peer-focus-visible:ring-2 peer-focus-visible:ring-shine/50" />
      <span className="pointer-events-none absolute top-[3px] left-[3px] size-4 rounded-full bg-white transition peer-checked:translate-x-4" />
    </span>
  );
}

function Card({ label, htmlFor, control, children }: { label: string; htmlFor?: string; control: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-panel p-3.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[13px] font-semibold">
          {label}
        </label>
        {control}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-mute">{children}</p>
    </section>
  );
}

/** Settings, sliding in over the popup. Changes save as you make them. `latest` is a newer version on the website, if any. */
export function SettingsPanel({ latest, onClose }: { latest: string | null; onClose: () => void }) {
  const [settings, save] = useSettings();
  const [saved, setSaved] = useState(false);
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
    <div className="panel-in absolute inset-0 z-20 flex flex-col bg-ink" role="dialog" aria-label="Settings">
      <header className="flex items-center gap-2 border-b border-edge px-3.5 pt-3 pb-2.5">
        <IconButton label="Back" onClick={onClose}>
          <IconBack size={18} />
        </IconButton>
        <h1 className="flex-1 text-[15px] font-semibold">Settings</h1>
        <span className={`text-[12px] text-emerald-300 transition ${saved ? 'opacity-100' : 'opacity-0'}`} data-testid="saved">
          Saved
        </span>
      </header>
      {settings && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3 scroll-thin">
          <Card
            label="Parallel downloads"
            htmlFor="max-concurrent"
            control={<Stepper id="max-concurrent" testId="max-concurrent" value={settings.maxConcurrent} min={1} max={MAX_CONCURRENT_LIMIT} onChange={(n) => void update({ maxConcurrent: n })} lessTitle="One fewer" moreTitle="One more" />}
          >
            Downloads past this number wait in a queue and start in the order you clicked them. Live recordings do not count. Each download already fetches several segments at once, so 2 or 3 fills a fast connection.
          </Card>
          <Card
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
            How many finished downloads Magpie remembers: title, date, length and the page they came from. Downloaded media is hidden from the page list so you never grab it twice. 0 turns history off. Lowering the number deletes the oldest entries right away.
          </Card>
          <Card label="Show thumbnails" htmlFor="thumbnails" control={<Switch id="thumbnails" testId="thumbnails" checked={settings.thumbnails} onChange={(on) => void update({ thumbnails: on })} />}>
            A frame of each video on its row. Magpie fetches one segment of the stream's lowest quality rendition, a few hundred kilobytes, once per stream and only while the popup is open. Off fetches nothing and shows an icon instead.
          </Card>
          <Card label="Remember private window downloads" htmlFor="archive-private" control={<Switch id="archive-private" testId="archive-private" checked={settings.archivePrivate} onChange={(on) => void update({ archivePrivate: on })} />}>
            When off, downloads from private windows leave history when you close the last private window, like the rest of private browsing.
          </Card>
          <Card label="Tell me about new versions" htmlFor="update-check" control={<Switch id="update-check" testId="update-check" checked={settings.updateCheck} onChange={(on) => void update({ updateCheck: on })} />}>
            At most every 12 hours Magpie reads magpie.trevorblackman.dev/version.json, a file holding one version number, and shows a line at the top when there is a newer one. The request carries nothing about you or your downloads. Off sends nothing.
          </Card>
          <div className="mt-auto pt-2 text-center text-[11px] text-dim">
            Magpie {browser.runtime.getManifest().version}
            {latest && (
              <>
                {' · '}
                <button type="button" className="text-shine hover:underline" onClick={() => openPage(SITE_URL)} data-testid="update-link">
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
