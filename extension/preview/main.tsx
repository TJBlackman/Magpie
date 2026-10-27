import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './harness.css';
import { Popup } from '../entrypoints/popup/Popup';
import { allTabs, onPreviewEvent, scenario, type Scenario } from './fake-browser';

const SCENARIOS: Record<Scenario, string> = { default: 'Default: a page with six videos', empty: 'Empty: first run', busy: 'Busy: many pages, long history' };

function go(patch: Record<string, string>) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  location.search = p.toString();
}

const select = 'h-8 rounded-lg border border-edge bg-panel px-2 text-[12px] text-text outline-none focus:border-shine';

function Harness() {
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => onPreviewEvent((m) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 6))), []);
  return (
    <div className="flex min-h-screen flex-col items-center gap-5 bg-[#05070a] px-6 py-8 text-text">
      <div className="flex w-[400px] flex-wrap items-center gap-2 text-[12px] text-mute">
        <span className="mr-auto text-[13px] font-semibold text-text">Magpie popup preview</span>
        <select className={select} value={allTabs ? 'all' : 'tab'} onChange={(e) => go({ mode: e.target.value === 'all' ? 'all' : '' })} title="Toolbar popup shows the active tab; opened as a page it shows every tab">
          <option value="tab">Toolbar popup</option>
          <option value="all">Opened as a page</option>
        </select>
        <select className={select} value={scenario} onChange={(e) => go({ scenario: e.target.value === 'default' ? '' : e.target.value })}>
          {Object.entries(SCENARIOS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="button" className={`${select} hover:bg-panel2`} onClick={() => location.reload()} title="Fresh fake data">
          Reset
        </button>
      </div>
      <div className="w-[400px] overflow-hidden rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,.08),0_30px_60px_-20px_rgba(0,0,0,.8)]">
        <Popup />
      </div>
      <div className="w-[400px] text-[11.5px] leading-relaxed text-dim">
        <p>
          The real popup, rendered against a fake background with simulated downloads. Edit anything under <code className="text-mute">extension/src/ui</code> or <code className="text-mute">entrypoints/popup</code> and it hot reloads. Reset returns the fake data to its starting
          point.
        </p>
        {log.length > 0 && (
          <ul className="mt-2 font-mono text-[11px] text-mute">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
