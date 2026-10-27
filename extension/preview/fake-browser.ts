/*
 * A stand in for `wxt/browser` so the real popup runs in a plain browser tab
 * against fake nature content. `pnpm preview` aliases 'wxt/browser' to this
 * file; the extension build never sees it.
 *
 * It plays the background and the engine: candidates per tab, inspect with a
 * short delay, downloads that progress and queue, a live recording, history
 * and settings in a fake storage.local. URL options:
 *   ?mode=all          the popup opened as a page of its own (every tab)
 *   ?scenario=empty    first run, nothing anywhere
 *   ?scenario=busy     many pages, many downloads, long history
 */
import type { ArchiveEntry } from '../src/core/archive';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, type Settings } from '../src/core/settings';
import { err, ok, type Candidate, type Envelope, type Inspection, type Job, type Result, type UiRequest, type Variant } from '../src/core/types';

const MB = 1024 * 1024;
const DAY = 86_400_000;
const now = Date.now();
const params = new URLSearchParams(location.search);
export type Scenario = 'default' | 'empty' | 'busy';
export const scenario: Scenario = (['default', 'empty', 'busy'] as const).find((s) => s === params.get('scenario')) ?? 'default';
export const allTabs = params.get('mode') === 'all';

/* A line for the harness to show when the popup would leave the page. */
const previewListeners = new Set<(msg: string) => void>();
export function onPreviewEvent(fn: (msg: string) => void): () => void {
  previewListeners.add(fn);
  return () => previewListeners.delete(fn);
}
const note = (msg: string) => previewListeners.forEach((fn) => fn(msg));

/* ---------- painted frames, since there is no real stream to decode ---------- */

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
const PALETTES: [string, string, string][] = [
  ['#9fd0ff', '#f5e2c8', '#4b6b8a'],
  ['#78c3f5', '#f8d9a8', '#1f6ea8'],
  ['#ff9b6a', '#ffe0b3', '#d98a4a'],
  ['#071633', '#12314f', '#0b1d2b'],
  ['#bfe3c9', '#f1f7e8', '#2f6b3e'],
  ['#ffb44f', '#ffe3a3', '#b58b3a'],
  ['#cfe3f5', '#ffffff', '#9fb6c9'],
  ['#4c5968', '#9aa6b2', '#5b6b3a'],
];
/** A 128 by 72 JPEG data URL of a sky, a horizon and sometimes a sun, the same for the same seed. */
export function paintThumb(seed: string): string {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 72;
  const ctx = c.getContext('2d')!;
  const h = hash(seed);
  const [top, bottom, ground] = PALETTES[h % PALETTES.length]!;
  const g = ctx.createLinearGradient(0, 0, 0, 72);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 72);
  if (h & 1) {
    ctx.fillStyle = 'rgba(255,230,160,.9)';
    ctx.beginPath();
    ctx.arc(90 + (h % 24), 22, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.moveTo(0, 72);
  const shape = (h >> 4) % 3;
  if (shape === 0) {
    ctx.lineTo(0, 50);
    ctx.lineTo(38, 24);
    ctx.lineTo(64, 44);
    ctx.lineTo(90, 18);
    ctx.lineTo(128, 48);
  } else if (shape === 1) {
    ctx.lineTo(0, 46);
    ctx.quadraticCurveTo(40, 30, 70, 46);
    ctx.quadraticCurveTo(100, 60, 128, 42);
  } else {
    ctx.lineTo(0, 44);
    for (let x = 0; x <= 128; x += 8) ctx.lineTo(x, 44 + ((x / 8) % 2 ? 3 : -3));
  }
  ctx.lineTo(128, 72);
  ctx.closePath();
  ctx.fill();
  return c.toDataURL('image/jpeg', 0.7);
}

/* ---------- fake tabs and content ---------- */

interface Tab {
  id: number;
  title: string;
  url: string;
}
const tabs: Tab[] = [
  { id: 7, title: 'Wildframe: Dolomites, whales, foxes and a live geyser', url: 'https://wildframe.tv/collections/autumn-2026' },
  { id: 8, title: 'Old Faithful Geyser Live Cam', url: 'https://wildframe.tv/live/old-faithful' },
  { id: 9, title: 'Nature Docs: the long cuts', url: 'https://naturedocs.org/films' },
];
/** In the toolbar popup everything is on the active tab; opened as a page, media spreads over three tabs. */
const tab = (i: number): Tab => (allTabs ? tabs[i] : tabs[0]) ?? tabs[0]!;

const MIME: Record<Candidate['kind'], string> = { hls: 'application/vnd.apple.mpegurl', dash: 'application/dash+xml', file: 'video/mp4' };
let seenAt = now;
/** Listed in seed order: the sniffer sorts newest first, so each seed is a little older than the last. */
function cand(id: string, t: Tab, title: string, url: string, kind: Candidate['kind'], extra: Partial<Candidate> = {}): Candidate {
  seenAt -= 10_000;
  return { id, tabId: t.id, url, kind, mime: MIME[kind], contentLength: null, pageUrl: t.url, pageTitle: title, referer: t.url, seenAt, ...extra };
}

function seedCandidates(): Candidate[] {
  if (scenario === 'empty') return [];
  const list = [
    cand('c1', tab(0), 'Alpine Lake at Dawn, Dolomites 4K', 'https://cdn.wildframe.tv/v/alpine-lake-dawn/master.m3u8', 'hls'),
    cand('c2', tab(0), 'Humpback Whales Breaching off Maui', 'https://stream.wildframe.tv/v/humpback-maui/playlist.m3u8', 'hls'),
    cand('c3', tab(0), 'Red Fox Hunting in Fresh Snow', 'https://media.wildframe.tv/v/red-fox-snow-1080p.mp4', 'file', { contentLength: 412 * MB }),
    cand('c4', tab(1), 'Old Faithful Geyser Live Cam', 'https://live.wildframe.tv/cams/old-faithful/chunklist.m3u8', 'hls', { live: true, reloads: 14 }),
    cand('c5', tab(2), 'Monsoon Storm over the Sonoran Desert', 'https://dash.wildframe.tv/v/sonoran-monsoon/manifest.mpd', 'dash'),
    cand('c6', tab(2), 'Aurora Borealis Timelapse, Tromso', 'https://cdn.wildframe.tv/v/aurora-tromso/master.m3u8', 'hls'),
  ];
  if (scenario === 'busy') {
    list.push(
      cand('c7', tab(2), 'Snow Leopard, Hemis National Park', 'https://cdn.naturedocs.org/snow-leopard/master.m3u8', 'hls'),
      cand('c8', tab(2), 'Puffins on the Cliffs of Latrabjarg', 'https://cdn.naturedocs.org/puffins/master.m3u8', 'hls'),
      cand('c9', tab(2), 'Elephant Herd at the Waterhole, Etosha', 'https://files.naturedocs.org/etosha-elephants-1080p.mp4', 'file', { contentLength: 1.3 * 1024 * MB }),
      cand('c10', tab(1), 'Iceland Waterfalls by Drone', 'https://cdn.dronescapes.io/iceland/master.m3u8', 'hls'),
      cand('c11', tab(1), 'Thunderstorm Rolling over the Great Plains', 'https://cdn.stormchase.tv/plains-2026/master.m3u8', 'hls'),
      cand('c12', tab(0), 'Coral Reef Drift, Great Barrier Reef', 'https://reefcam.au/drift/playlist.m3u8', 'hls'),
    );
  }
  return list;
}

let seq = 100;
function job(id: string, title: string, kind: Job['kind'], variantLabel: string, state: Job['state'], patch: Partial<Job>): Job {
  const short = variantLabel.split('x')[1]?.split(' ')[0];
  return {
    id,
    candidateId: '',
    title,
    filename: `${title}${short ? ` [${short}p]` : ''}.mp4`,
    url: '',
    kind,
    variantLabel,
    state,
    segmentsTotal: 0,
    segmentsDone: 0,
    bytes: 0,
    startedAt: now - 120_000,
    thumb: paintThumb(title),
    ...patch,
  };
}

function seedJobs(): Job[] {
  if (scenario === 'empty') return [];
  const list = [
    job('j1', 'Serengeti Wildebeest Migration', 'hls', '1920x1080 · 6000 kbps', 'downloading', { segmentsTotal: 412, segmentsDone: 256, bytes: 598 * MB, startedAt: now - 140_000 }),
    job('j2', 'Glacier Calving, Perito Moreno', 'hls', '3840x2160 · 15200 kbps', 'downloading', { segmentsTotal: 198, segmentsDone: 31, bytes: 240 * MB, startedAt: now - 40_000 }),
    job('j3', 'Coral Reef Drift, Great Barrier Reef', 'file', 'video/mp4 · 980.0 MB', 'queued', { bytesTotal: 980 * MB, queuePosition: 1, startedAt: now - 20_000 }),
    job('j4', 'Monarch Butterfly Migration, Michoacan', 'hls', '1920x1080 · 6000 kbps', 'error', {
      segmentsTotal: 300,
      segmentsDone: 118,
      bytes: 214 * MB,
      error: 'Server returned 403 for segment 119. The link probably expired. Reload the page and try again.',
      startedAt: now - 900_000,
      finishedAt: now - 870_000,
    }),
  ];
  if (scenario === 'busy') {
    list.splice(
      2,
      0,
      job('j6', 'Bioluminescent Bay at Night, Vieques', 'hls', '1920x1080 · 6000 kbps', 'downloading', { segmentsTotal: 65, segmentsDone: 12, bytes: 70 * MB, startedAt: now - 15_000 }),
      job('j7', 'Grand Canyon Sunset Timelapse', 'file', 'video/mp4 · 640.0 MB', 'queued', { bytesTotal: 640 * MB, queuePosition: 2, startedAt: now - 10_000 }),
    );
  }
  return list;
}

function entry(id: string, title: string, file: string, page: string, src: string, at: number, secs: number): ArchiveEntry {
  return { id, title, file, page, src, at, secs, kind: src.endsWith('.m3u8') ? 'hls' : 'file', thumb: paintThumb(title) };
}

function seedArchive(): ArchiveEntry[] {
  if (scenario === 'empty') return [];
  const list = [
    entry('a1', 'Sandhill Cranes at Sunrise, Platte River', 'Sandhill Cranes at Sunrise, Platte River [1080p].mp4', 'https://wildframe.tv/watch/sandhill-cranes', 'https://cdn.wildframe.tv/v/sandhill-cranes/master.m3u8', now - 1_400_000, 840),
    entry('a2', 'Aurora Borealis Timelapse, Tromso', 'Aurora Borealis Timelapse, Tromso [2160p].mp4', 'https://wildframe.tv/watch/aurora-tromso', 'https://cdn.wildframe.tv/v/aurora-tromso/master.m3u8', now - 1 * DAY, 274),
    entry('a3', 'Elephant Herd at the Waterhole, Etosha', 'Elephant Herd at the Waterhole, Etosha.mp4', 'https://naturedocs.org/films/etosha', 'https://files.naturedocs.org/etosha-elephants-1080p.mp4', now - 2 * DAY, 1510),
    entry('a4', 'Redwood Canopy in Morning Fog', 'Redwood Canopy in Morning Fog [1080p].mp4', 'https://wildframe.tv/watch/redwood-fog', 'https://cdn.wildframe.tv/v/redwood-fog/master.m3u8', now - 3 * DAY, 632),
    entry('a5', 'Snow Leopard, Hemis National Park', 'Snow Leopard, Hemis National Park [2160p].mp4', 'https://naturedocs.org/films/snow-leopard', 'https://cdn.naturedocs.org/snow-leopard/master.m3u8', now - 5 * DAY, 2890),
    entry('a6', 'Iceland Waterfalls by Drone', 'Iceland Waterfalls by Drone [2160p].mp4', 'https://dronescapes.io/iceland', 'https://cdn.dronescapes.io/iceland/master.m3u8', now - 6 * DAY, 745),
    entry('a7', 'Bioluminescent Bay at Night, Vieques', 'Bioluminescent Bay at Night, Vieques [1080p].mp4', 'https://wildframe.tv/watch/bio-bay', 'https://cdn.wildframe.tv/v/bio-bay/master.m3u8', now - 9 * DAY, 388),
    entry('a8', 'Grand Canyon Sunset Timelapse', 'Grand Canyon Sunset Timelapse [2160p].mp4', 'https://dronescapes.io/grand-canyon', 'https://cdn.dronescapes.io/grand-canyon/master.m3u8', now - 12 * DAY, 301),
    entry('a9', 'Puffins on the Cliffs of Latrabjarg', 'Puffins on the Cliffs of Latrabjarg [1080p].mp4', 'https://wildframe.tv/watch/puffins', 'https://cdn.naturedocs.org/puffins/master.m3u8', now - 14 * DAY, 955),
    entry('a10', 'Thunderstorm Rolling over the Great Plains', 'Thunderstorm Rolling over the Great Plains [1080p].mp4', 'https://stormchase.tv/plains-2026', 'https://cdn.stormchase.tv/plains-2026/master.m3u8', now - 20 * DAY, 1120),
  ];
  if (scenario === 'busy') {
    const more = ['Kelp Forest off Monterey', 'Wolves of Yellowstone, Lamar Valley', 'Sahara Dunes at Blue Hour', 'Hummingbirds in Slow Motion', 'Cherry Blossoms, Kyoto Timelapse', 'Penguins of South Georgia', 'Namib Desert Fog Beetles', 'Fireflies in the Smoky Mountains', 'Alaskan Brown Bears Fishing', 'Monsoon Frogs of Kerala'];
    more.forEach((title, i) => list.push(entry(`a${11 + i}`, title, `${title} [1080p].mp4`, `https://naturedocs.org/films/${i}`, `https://cdn.naturedocs.org/x${i}/master.m3u8`, now - (22 + i * 3) * DAY, 300 + i * 90)));
  }
  return list;
}

/* ---------- fake storage.local ---------- */

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
const store: Record<string, unknown> = { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } };
const storageListeners = new Set<(changes: Changes, area: string) => void>();
const settings = (): Settings => normalizeSettings(store[SETTINGS_KEY]);

/* ---------- fake background + engine ---------- */

const state = {
  candidates: seedCandidates(),
  jobs: seedJobs(),
  archive: seedArchive(),
  inspections: new Map<string, Inspection>(),
  rate: new Map<string, number>(),
};
const uiListeners = new Set<(raw: unknown) => void>();
function emit(event: Extract<Envelope, { magpie: 'ui' }>['event']) {
  const env: Envelope = { magpie: 'ui', event };
  uiListeners.forEach((fn) => fn(env));
}
const emitJobs = () => emit({ type: 'jobs', jobs: state.jobs });
const emitArchive = () => emit({ type: 'archive', entries: state.archive });

const inHistory = (c: Candidate) => !c.live && state.archive.some((e) => e.src === c.url);

/* Frames arrive one at a time a moment after the popup asks, like the real capture. */
const capturing = new Set<string>();
function captureThumbs(list: Candidate[]) {
  if (!settings().thumbnails) return;
  let delay = 500;
  for (const c of list) {
    if (c.thumb || c.kind === 'dash' || capturing.has(c.id)) continue;
    capturing.add(c.id);
    setTimeout(() => {
      c.thumb = paintThumb(c.pageTitle);
      capturing.delete(c.id);
      emit({ type: 'candidates', tabId: c.tabId });
    }, delay);
    delay += 700;
  }
}
const LIVE_NOTE = 'Live stream. Download records from about 30 seconds back until you press Stop or the stream ends.';
const fmtBytes = (n: number) => (n < 1024 ** 3 ? `${(n / MB).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

function variantsFor(c: Candidate): Variant[] {
  if (c.kind === 'file') return [{ id: 'file', label: `${c.mime}${c.contentLength ? ` · ${fmtBytes(c.contentLength)}` : ''}`, uri: c.url }];
  if (c.url.endsWith('chunklist.m3u8') || c.url.endsWith('playlist.m3u8')) {
    return [{ id: 'v0', label: c.live ? 'Live · ts' : '102 segments · 10m 12s · fmp4', uri: c.url }];
  }
  const defs: [string, number][] = [
    ['3840x2160', 15_200_000],
    ['1920x1080', 6_000_000],
    ['1280x720', 3_100_000],
    ['854x480', 1_400_000],
  ];
  if (c.id === 'c7' || c.id === 'c12') defs.shift();
  return defs.map(([resolution, bandwidth], i) => ({
    id: `v${i}`,
    label: `${resolution} · ${(bandwidth / 1000).toFixed(0)} kbps · avc1.640028,mp4a.40.2`,
    uri: c.url.replace('master.m3u8', `${resolution.split('x')[1]}p/index.m3u8`),
    bandwidth,
    resolution,
    codecs: 'avc1.640028,mp4a.40.2',
  }));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inspect(c: Candidate): Promise<Result<Inspection>> {
  const cached = state.inspections.get(c.id);
  if (cached) return ok(cached);
  await delay(550);
  if (c.kind === 'dash') return err('DASH manifests are detected but not downloadable yet (phase 2).');
  const notes: string[] = [];
  if (c.live) notes.push(LIVE_NOTE);
  if (c.id === 'c2') notes.push('Some renditions carry audio in a separate track. v1 saves video only for those; merging comes in phase 2.');
  const ins: Inspection = { candidateId: c.id, kind: c.kind, variants: variantsFor(c), notes, live: c.live };
  state.inspections.set(c.id, ins);
  return ok(ins);
}

function runningCount(): number {
  return state.jobs.filter((j) => !j.live && ['inspecting', 'downloading', 'muxing', 'saving'].includes(j.state)).length;
}

/** Start queued jobs while there are free slots, then renumber the queue. */
function promote() {
  let free = settings().maxConcurrent - runningCount();
  const queued = state.jobs.filter((j) => j.state === 'queued').sort((a, b) => a.startedAt - b.startedAt);
  for (const j of queued) {
    if (free <= 0) break;
    j.state = 'downloading';
    j.queuePosition = undefined;
    free--;
  }
  let pos = 1;
  for (const j of state.jobs.filter((j) => j.state === 'queued').sort((a, b) => a.startedAt - b.startedAt)) j.queuePosition = pos++;
}

function start(c: Candidate, variantId: string): Result<Job> {
  const ins = state.inspections.get(c.id);
  const v = ins?.variants.find((x) => x.id === variantId);
  if (!v) return err('Inspect the stream first.');
  const short = v.resolution?.split('x')[1];
  const live = !!c.live;
  const willRun = live || runningCount() < settings().maxConcurrent;
  const j: Job = {
    id: `j${seq++}`,
    candidateId: c.id,
    title: c.pageTitle,
    filename: `${c.pageTitle}${short ? ` [${short}p]` : ''}${live ? ` ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}` : ''}.mp4`,
    url: v.uri,
    kind: c.kind,
    variantLabel: v.label,
    state: willRun ? 'inspecting' : 'queued',
    segmentsTotal: c.kind === 'file' ? 0 : live ? 0 : 90 + Math.round(Math.random() * 300),
    segmentsDone: 0,
    bytes: 0,
    bytesTotal: c.kind === 'file' ? (c.contentLength ?? undefined) : undefined,
    thumb: c.thumb,
    live,
    duration: live ? 0 : undefined,
    startedAt: Date.now(),
  };
  state.jobs.unshift(j);
  promote();
  if (j.state === 'inspecting') {
    setTimeout(() => {
      if (j.state === 'inspecting') j.state = 'downloading';
      emitJobs();
    }, 700);
  }
  emitJobs();
  return ok(j);
}

function finish(j: Job) {
  j.state = 'muxing';
  emitJobs();
  setTimeout(() => {
    j.state = 'saving';
    emitJobs();
  }, 900);
  setTimeout(() => {
    const c = state.candidates.find((x) => x.id === j.candidateId);
    const size = settings().archiveSize;
    if (size > 0) {
      const total = j.live ? j.duration : j.segmentsTotal ? j.segmentsTotal * 6 : 418;
      state.archive.unshift({ id: j.id, title: j.title, file: j.filename, page: c?.pageUrl ?? '', src: c?.url ?? j.url, at: Date.now(), kind: j.kind, secs: total, thumb: j.thumb });
      state.archive = state.archive.slice(0, size);
      emitArchive();
    }
    // A finished job leaves the list the moment it is saved, whether or not history keeps a record.
    state.jobs = state.jobs.filter((x) => x.id !== j.id);
    promote();
    emitJobs();
  }, 1700);
}

setInterval(() => {
  let changed = false;
  for (const j of state.jobs) {
    if (j.state !== 'downloading') continue;
    changed = true;
    const base = state.rate.get(j.id) ?? (4 + Math.random() * 6) * MB;
    state.rate.set(j.id, base);
    const step = (base * (0.85 + Math.random() * 0.3)) / 4;
    if (j.live) {
      j.bytes += step;
      j.duration = (j.duration ?? 0) + 0.25;
      continue;
    }
    if (j.kind === 'file') {
      j.bytes = Math.min(j.bytesTotal ?? Infinity, j.bytes + step);
      if (j.bytesTotal && j.bytes >= j.bytesTotal) finish(j);
      continue;
    }
    j.bytes += step;
    const total = (6_000_000 * j.segmentsTotal * 6) / 8;
    j.segmentsDone = Math.min(j.segmentsTotal, Math.floor((j.bytes / total) * j.segmentsTotal));
    if (j.segmentsDone >= j.segmentsTotal) finish(j);
  }
  if (changed) emitJobs();
}, 250);

async function handle(req: UiRequest): Promise<Result<unknown>> {
  switch (req.type) {
    case 'activeTab':
      return ok(tabs[0]);
    case 'candidates': {
      const list = state.candidates.filter((c) => req.tabId === undefined || c.tabId === req.tabId).sort((a, b) => b.seenAt - a.seenAt);
      captureThumbs(list.filter((c) => !inHistory(c)));
      return ok(list.map((c) => (inHistory(c) ? { ...c, archived: true } : c)));
    }
    case 'clearCandidates':
      state.candidates = state.candidates.filter((c) => c.tabId !== req.tabId);
      emit({ type: 'candidates', tabId: req.tabId });
      return ok(null);
    case 'inspect': {
      const c = state.candidates.find((x) => x.id === req.candidateId);
      return c ? inspect(c) : err('Candidate no longer known (tab navigated?).');
    }
    case 'start': {
      const c = state.candidates.find((x) => x.id === req.candidateId);
      return c ? start(c, req.variantId) : err('Candidate no longer known (tab navigated?).');
    }
    case 'cancel':
      state.jobs = state.jobs.filter((x) => x.id !== req.jobId);
      promote();
      emitJobs();
      return ok(null);
    case 'stop': {
      const j = state.jobs.find((x) => x.id === req.jobId);
      if (j?.live && j.state === 'downloading') finish(j);
      return ok(null);
    }
    case 'removeJob':
      state.jobs = state.jobs.filter((x) => x.id !== req.jobId);
      emitJobs();
      return ok(null);
    case 'clearFailed':
      state.jobs = state.jobs.filter((x) => x.state !== 'error');
      emitJobs();
      return ok(null);
    case 'jobs':
      return ok(state.jobs);
    case 'archive':
      return ok(state.archive);
    case 'removeArchive':
      state.archive = state.archive.filter((e) => e.id !== req.id);
      emitArchive();
      return ok(null);
    case 'clearArchive':
      state.archive = [];
      emitArchive();
      return ok(null);
  }
}

/* ---------- the browser object the popup sees ---------- */

export const browser = {
  runtime: {
    sendMessage: async (raw: unknown): Promise<unknown> => {
      const env = raw as Envelope;
      if (env && env.magpie === 'bg') return handle(env.req);
      return undefined;
    },
    onMessage: {
      addListener: (fn: (raw: unknown) => void) => void uiListeners.add(fn),
      removeListener: (fn: (raw: unknown) => void) => void uiListeners.delete(fn),
    },
    getURL: (path: string) => new URL(path, location.href).href,
    getManifest: () => ({ version: '0.3.0 preview' }),
  },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => {
        const changes: Changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        storageListeners.forEach((fn) => fn(changes, 'local'));
        if (changes[SETTINGS_KEY]) {
          const s = settings();
          if (state.archive.length > s.archiveSize) {
            state.archive = state.archive.slice(0, s.archiveSize);
            emitArchive();
          }
          promote();
          emitJobs();
        }
      },
    },
    onChanged: {
      addListener: (fn: (changes: Changes, area: string) => void) => void storageListeners.add(fn),
      removeListener: (fn: (changes: Changes, area: string) => void) => void storageListeners.delete(fn),
    },
  },
  tabs: {
    /** The tab this page lives in: undefined inside the toolbar popup, so the popup asks for the active tab. */
    getCurrent: async (): Promise<Tab | undefined> => (allTabs ? { id: 99, title: 'Magpie', url: location.href } : undefined),
    get: async (id: number): Promise<Tab> => {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error(`No tab with id ${id}`);
      return t;
    },
    create: async ({ url }: { url: string }) => note(`Would open ${url} in a new tab`),
  },
};
