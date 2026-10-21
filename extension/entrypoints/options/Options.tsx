import { useEffect, useState } from 'react';
import { openManager, useSettings } from '../../src/ui/api';
import { Button } from '../../src/ui/components';
import { MAX_CONCURRENT_LIMIT } from '../../src/core/settings';

export function Options() {
  const [settings, save] = useSettings();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  if (!settings) return null;

  const setMax = async (n: number) => {
    await save({ ...settings, maxConcurrent: n });
    setSaved(true);
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
          Downloads past this number wait in a queue and start in the order you clicked them as soon as a running one finishes.
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
    </div>
  );
}
