import { useEffect, useState } from 'react';
import { openManager, useSettings } from '../../src/ui/api';
import { Button } from '../../src/ui/components';
import { ARCHIVE_LIMIT, MAX_CONCURRENT_LIMIT, type Settings } from '../../src/core/settings';

export function Options() {
  const [settings, save] = useSettings();
  const [saved, setSaved] = useState(false);
  /** The archive size being typed. Saved on Enter or leaving the field, so typing "50" never saves a 5 that trims the archive. */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  if (!settings) return null;

  const update = async (patch: Partial<Settings>) => {
    await save({ ...settings, ...patch });
    setSaved(true);
  };
  const setMax = (n: number) => update({ maxConcurrent: n });
  const setArchiveSize = (n: number) => update({ archiveSize: n });
  const commitSize = () => {
    if (sizeDraft === null) return;
    const n = Math.round(Number(sizeDraft));
    setSizeDraft(null);
    if (sizeDraft.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= ARCHIVE_LIMIT && n !== settings.archiveSize) void setArchiveSize(n);
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 p-6">
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Magpie settings</h1>
        <span className={`text-[12px] text-emerald-300 transition ${saved ? 'opacity-100' : 'opacity-0'}`} data-testid="saved">
          Saved
        </span>
        <span className="flex-1" />
        <Button tone="ghost" onClick={openManager}>
          Downloads
        </Button>
      </header>

      <section className="rounded border border-edge bg-panel p-4">
        <label htmlFor="max-concurrent" className="block text-[13px] font-medium text-zinc-100">
          Maximum concurrent downloads
        </label>
        <p className="mt-1 text-[12px] text-mute">
          Downloads past this number wait in a queue and start in the order you clicked them as soon as a running one finishes. Live recordings do not count, since they run until you stop them.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={() => setMax(settings.maxConcurrent - 1)} disabled={settings.maxConcurrent <= 1} title="One fewer">
            {'−'}
          </Button>
          <input
            id="max-concurrent"
            data-testid="max-concurrent"
            type="number"
            min={1}
            max={MAX_CONCURRENT_LIMIT}
            value={settings.maxConcurrent}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= MAX_CONCURRENT_LIMIT) void setMax(n);
            }}
            className="w-16 rounded border border-edge bg-ink px-2 py-1 text-center text-[13px] text-zinc-100 outline-none focus:border-shine"
          />
          <Button onClick={() => setMax(settings.maxConcurrent + 1)} disabled={settings.maxConcurrent >= MAX_CONCURRENT_LIMIT} title="One more">
            +
          </Button>
          <span className="text-[12px] text-mute">1 to {MAX_CONCURRENT_LIMIT}</span>
        </div>
        <p className="mt-3 text-[12px] text-mute">
          Each download already fetches several segments in parallel, so 2 or 3 is usually enough to fill a fast connection.
        </p>
      </section>

      <section className="rounded border border-edge bg-panel p-4">
        <label htmlFor="archive-size" className="block text-[13px] font-medium text-zinc-100">
          Archive size
        </label>
        <p className="mt-1 text-[12px] text-mute">
          How many finished downloads Magpie remembers: title, date, length and the page they came from. Media already in the archive is hidden from the list of media on a page. 0 turns the archive off. Lowering the number deletes the oldest entries right away.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={() => setArchiveSize(settings.archiveSize - 1)} disabled={settings.archiveSize <= 0} title="Keep one entry less">
            {'−'}
          </Button>
          <input
            id="archive-size"
            data-testid="archive-size"
            type="number"
            min={0}
            max={ARCHIVE_LIMIT}
            value={sizeDraft ?? settings.archiveSize}
            onChange={(e) => setSizeDraft(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSize();
              if (e.key === 'Escape') setSizeDraft(null);
            }}
            className="w-20 rounded border border-edge bg-ink px-2 py-1 text-center text-[13px] text-zinc-100 outline-none focus:border-shine"
          />
          <Button onClick={() => setArchiveSize(settings.archiveSize + 1)} disabled={settings.archiveSize >= ARCHIVE_LIMIT} title="Keep one entry more">
            +
          </Button>
          <span className="text-[12px] text-mute">0 to {ARCHIVE_LIMIT}</span>
        </div>
        <label className="mt-4 flex items-start gap-2 text-[12px] text-zinc-200">
          <input
            type="checkbox"
            data-testid="archive-private"
            checked={settings.archivePrivate}
            onChange={(e) => void update({ archivePrivate: e.target.checked })}
            className="mt-0.5 accent-cyan-400"
          />
          <span>
            Remember downloads from private windows
            <span className="mt-0.5 block text-mute">When this is off, they stay in the archive until you close the last private window, and Magpie then forgets them, like the rest of private browsing.</span>
          </span>
        </label>
      </section>
    </div>
  );
}
