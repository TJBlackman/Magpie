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
 *   ?update=1          the website has a newer version
 */
import type { ArchiveEntry } from '../src/core/archive';
import { pickThumbs, withoutThumb } from '../src/core/thumbs';
import { paintScene } from './paint';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, type Settings } from '../src/core/settings';
import { UPDATE_KEY } from '../src/core/update';
import { err, ok, type Candidate, type Envelope, type Inspection, type Job, type MediaInfo, type Result, type UiRequest, type Variant } from '../src/core/types';

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
/** A frame for a title, painted like the footage it names (see paint.ts). */
export function paintThumb(seed: string): string {
  return paintScene(seed);
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
  { id: 10, title: 'r/EarthPorn', url: 'https://www.reddit.com/r/EarthPorn/' },
];

/** A Reddit post row: a gallery of a few originals, as the page collector would read it. */
function redditPost(id: string, t: Tab, title: string, count: number): Candidate {
  const assets = Array.from({ length: count }, (_, i) => ({ url: `https://i.redd.it/${id}${i}.jpg`, kind: 'file' as const, mime: 'image/jpeg', label: `${i + 1} of ${count} · JPG` }));
  const permalink = `https://www.reddit.com/r/EarthPorn/comments/${id}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}/`;
  return cand(`p${id}`, t, title, permalink, 'post', {
    post: { id, permalink, title, subreddit: 'EarthPorn', author: 'wanderer', created: '2026-10-21T14:03:00Z', type: count > 1 ? 'gallery' : 'image', assets, preview: '', summary: count > 1 ? `Gallery, ${count} images` : 'Image, JPG' },
    thumb: paintThumb(title),
  });
}
/** In the toolbar popup everything is on the active tab; opened as a page, media spreads over three tabs. */
const tab = (i: number): Tab => (allTabs ? tabs[i] : tabs[0]) ?? tabs[0]!;

const MIME: Record<Candidate['kind'], string> = { hls: 'application/vnd.apple.mpegurl', dash: 'application/dash+xml', file: 'video/mp4', post: '' };
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
    cand('c13', tab(2), 'The Living Coast, official trailer', 'https://drm.streamhouse.example/living-coast/manifest.mpd', 'dash'),
    redditPost('1xr7a2', allTabs ? tabs[3]! : tabs[0]!, 'Dawn over the Dolomites, 12 shots from a week of hiking [OC]', 12),
    redditPost('1xq9zz', allTabs ? tabs[3]! : tabs[0]!, 'Fog in the valley this morning [OC] [4000x6000]', 1),
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
    url: `https://cdn.wildframe.tv/v/${title.toLowerCase().replace(/[^a-z]+/g, '-')}/${short ? `${short}p/index.m3u8` : 'video.mp4'}`,
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
    job('j3', 'Coral Reef Drift, Great Barrier Reef', 'file', 'video/mp4 · 980.0 MB', 'queued', { height: 1080, bytesTotal: 980 * MB, queuePosition: scenario === 'busy' ? 2 : 1, startedAt: now - 20_000 }),
    job('j4', 'Monarch Butterfly Migration, Michoacan', 'hls', '1920x1080 · 6000 kbps', 'error', {
      segmentsTotal: 300,
      segmentsDone: 118,
      bytes: 214 * MB,
      error: 'HTTP 403 for https://cdn.wildframe.tv/v/monarch-migration/1080p/seg-119.ts',
      pageUrl: 'https://wildframe.tv/watch/monarch-migration',
      startedAt: now - 900_000,
      finishedAt: now - 870_000,
    }),
  ];
  if (scenario === 'busy') {
    list.splice(
      2,
      0,
      job('j6', 'Bioluminescent Bay at Night, Vieques', 'hls', '1920x1080 · 6000 kbps', 'queued', { sizeEstimate: 290 * MB, segmentsTotal: 65, queuePosition: 1, startedAt: now - 15_000 }),
      job('j8', 'Humpback Whales Breaching off Maui', 'hls', '1280x720 · 3100 kbps', 'error', { candidateId: 'c2', segmentsTotal: 102, segmentsDone: 40, bytes: 92 * MB, error: 'HTTP 404 for https://stream.wildframe.tv/v/humpback-maui/seg-41.ts', pageUrl: 'https://wildframe.tv/watch/humpback-maui', startedAt: now - 600_000, finishedAt: now - 590_000 }),
      job('j7', 'Grand Canyon Sunset Timelapse', 'file', 'video/mp4 · 640.0 MB', 'queued', { height: 2160, bytesTotal: 640 * MB, queuePosition: 3, startedAt: now - 10_000 }),
    );
  }
  return list;
}

function entry(id: string, title: string, file: string, page: string, src: string, at: number, secs: number): ArchiveEntry {
  const p = Number(/\[(\d+)p\]/.exec(file)?.[1] ?? 1080);
  return { id, title, file, page, src, at, secs, kind: src.endsWith('.m3u8') ? 'hls' : 'file', thumb: paintThumb(title), bytes: Math.round((secs * (p >= 2160 ? 15_200_000 : p >= 1080 ? 6_000_000 : 3_100_000)) / 8) };
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
if (params.get('update') === '1') store[UPDATE_KEY] = { checkedAt: now, ok: true, latest: '9.0.0' };
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
// Change events carry no thumbnails, like the real background; the popup asks `thumbs` for rows it has not seen.
const emitJobs = () => emit({ type: 'jobs', jobs: state.jobs.map(withoutThumb) });
const emitArchive = () => emit({ type: 'archive', entries: state.archive.map(withoutThumb) });

const inHistory = (c: Candidate) => (c.live ? undefined : state.archive.find((e) => e.src === c.url));

/* Frames arrive one at a time a moment after the popup asks, like the real capture. */
const capturing = new Set<string>();
function captureThumbs(list: Candidate[]) {
  if (!settings().thumbnails) return;
  let delay = 500;
  for (const c of list) {
    if (c.thumb || c.info?.drm || capturing.has(c.id)) continue;
    capturing.add(c.id);
    setTimeout(() => {
      // A new object, not the old one changed in place: memoized cards only redraw when their candidate is a new object.
      // Like the engine: a protected stream gets no frame, only the info that it is protected.
      const info = infoFor(c);
      const thumb = info.drm ? undefined : paintThumb(c.pageTitle);
      state.candidates = state.candidates.map((x) => (x.id === c.id ? { ...x, thumb, info } : x));
      capturing.delete(c.id);
      emit({ type: 'candidates', tabId: c.tabId });
    }, delay);
    delay += 700;
  }
}
/** What the engine's thumbnail capture learns about a stream: best quality, length, DRM. */
function infoFor(c: Candidate): MediaInfo {
  if (c.id === 'c13') return { drm: true };
  if (c.kind === 'file') return { height: 1080 };
  const variants = variantsFor(c);
  // A single playlist states no resolution; the capture reads it from the decoded frame.
  const best = Math.max(0, ...variants.map((v) => Number(v.resolution?.split('x')[1] ?? 0))) || (c.url.endsWith('playlist.m3u8') || c.live ? 1080 : 0);
  const duration = c.live ? undefined : c.url.endsWith('playlist.m3u8') ? 612 : 180 + (hash(c.id) % 2400);
  const bitrate = variants[0]?.bandwidth;
  const qualities = variants.filter((v) => v.resolution).length;
  return { ...(best ? { height: best } : {}), ...(duration ? { duration } : {}), ...(bitrate ? { bitrate } : {}), ...(qualities > 1 ? { qualities } : {}) };
}
const LIVE_NOTE = 'Starts about 30 seconds back. Ends when you press "Stop\u00a0and\u00a0save", or when the stream ends.';
const fmtBytes = (n: number) => (n < 1024 ** 3 ? `${(n / MB).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

function variantsFor(c: Candidate): Variant[] {
  if (c.kind === 'post') return (c.post?.assets ?? []).map((a, i) => ({ id: String(i), label: a.label, uri: a.url }));
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
    uri: c.url.replace(/(master\.m3u8|manifest\.mpd)$/, `${resolution.split('x')[1]}p/index.m3u8`),
    bandwidth,
    resolution,
    codecs: c.kind === 'dash' ? 'avc1.640028' : 'avc1.640028,mp4a.40.2',
    ...(c.kind === 'dash' ? { label: `${resolution} · ${(bandwidth / 1000).toFixed(0)} kbps · avc1.640028 + English`, audioUri: c.url, audioLabel: 'English' } : {}),
  }));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inspect(c: Candidate): Promise<Result<Inspection>> {
  const cached = state.inspections.get(c.id);
  if (cached) return ok(cached);
  await delay(550);
  if (c.id === 'c13') return err("The site locks this video with DRM, so Magpie can't save it.");
  const notes: string[] = [];
  if (c.live) notes.push(LIVE_NOTE);
  if (c.id === 'c5') notes.push("Audio: English, the stream's default track.");
  const ins: Inspection = { candidateId: c.id, kind: c.kind, variants: variantsFor(c), notes, live: c.live, duration: c.live || c.kind === 'post' ? undefined : (inHistory(c)?.secs ?? infoFor(c).duration) };
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

/** Every file of a post as one job each, in a group, like the real background does. */
function startPost(c: Candidate): Result<Job> {
  const assets = c.post?.assets ?? [];
  if (!assets.length) return err('Nothing to save for this post.');
  const group = `g${seq++}`;
  const folder = `Reddit/${c.post!.subreddit}/${c.pageTitle} [${c.post!.id}]`;
  const jobs = assets.map((a, i): Job => ({
    id: `j${seq++}`,
    candidateId: `${c.id}~${i}`,
    title: c.pageTitle,
    filename: assets.length === 1 ? `${folder}.jpg` : `${folder}/${String(i + 1).padStart(2, '0')}.jpg`,
    url: a.url,
    kind: 'file',
    variantLabel: a.label,
    state: 'queued',
    segmentsTotal: 1,
    segmentsDone: 0,
    bytes: 0,
    bytesTotal: (2 + Math.random() * 6) * MB,
    thumb: c.thumb,
    group: { id: group, index: i, total: assets.length, candidateId: c.id },
    startedAt: Date.now() + i,
  }));
  state.jobs.unshift(...jobs);
  promote();
  emitJobs();
  return ok(jobs[0]!);
}

function start(c: Candidate, variantId: string): Result<Job> {
  if (c.kind === 'post') return startPost(c);
  const ins = state.inspections.get(c.id);
  const v = variantId === 'best' ? (ins?.variants ?? variantsFor(c))[0] : ins?.variants.find((x) => x.id === variantId);
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
    // Like the engine: the rendition's height, else the one read from the decoded frame.
    height: Number(short) || infoFor(c).height,
    state: willRun ? 'inspecting' : 'queued',
    segmentsTotal: c.kind === 'file' ? 0 : live ? 0 : 90 + Math.round(Math.random() * 300),
    segmentsDone: 0,
    bytes: live ? 26 * MB : 0,
    bytesTotal: c.kind === 'file' ? (c.contentLength ?? undefined) : undefined,
    thumb: c.thumb,
    live,
    // The engine saves the playlist's window (about 30 seconds) as soon as it starts.
    duration: live ? 30 : undefined,
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
    const c = state.candidates.find((x) => x.id === (j.group?.candidateId ?? j.candidateId));
    const size = settings().archiveSize;
    // A post goes to history once, when its last file is saved.
    const last = !j.group || state.jobs.filter((x) => x.group?.id === j.group!.id).length === 1;
    if (size > 0 && last && j.group) {
      const dot = j.filename.lastIndexOf('/');
      state.archive.unshift({ id: j.group.id, title: j.title, file: j.group.total > 1 ? j.filename.slice(0, dot) : j.filename, page: c?.pageUrl ?? '', src: c?.url ?? j.url, at: Date.now(), kind: 'post', files: j.group.total > 1 ? j.group.total : undefined, thumb: j.thumb });
      state.archive = state.archive.slice(0, size);
      emitArchive();
    } else if (size > 0) {
      const total = j.live ? j.duration : j.segmentsTotal ? j.segmentsTotal * 6 : 418;
      state.archive.unshift({ id: j.id, title: j.title, file: j.filename, page: c?.pageUrl ?? '', src: c?.url ?? j.url, at: Date.now(), kind: j.kind, secs: total, thumb: j.thumb, bytes: Math.round(j.bytes) });
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
      return ok(
        list.map((c) => {
          const e = inHistory(c);
          return e ? { ...c, archived: { at: e.at, file: e.file, files: e.files, secs: e.secs }, thumb: c.thumb ?? e.thumb } : c;
        }),
      );
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
    case 'thumbs':
      return ok({ jobs: pickThumbs(state.jobs, req.jobs), archive: pickThumbs(state.archive, req.archive) });
    case 'checkUpdate':
      return ok(null);
    case 'showFile':
      note(`Would show ${req.file} in its folder`);
      return ok(true);
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
    getManifest: () => ({ version: '0.7.1' }),
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
    reload: async (id: number) => note(`Would reload tab ${id}`),
  },
};
