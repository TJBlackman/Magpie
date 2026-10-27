// @vitest-environment jsdom
// jsdom for DOMParser, which parseMpd needs; see dash.test.ts for why not happy-dom.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, Inspection, Job } from '../core/types';
import { Engine } from './engine';
import { boxes, startOf, trackTimescales } from './mux';
import type { Platform } from './platform';

const BASE = 'https://cdn.example/show/';
const MPD_URL = `${BASE}manifest.mpd`;

/** A version 0 sidx with two 4 s references of 1000 bytes, timescale 1000: 56 bytes. */
function sidx(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(56);
  const v = new DataView(out.buffer);
  v.setUint32(0, 56);
  out.set([0x73, 0x69, 0x64, 0x78], 4);
  v.setUint32(12, 1);
  v.setUint32(16, 1000);
  v.setUint16(30, 2);
  for (let i = 0; i < 2; i++) {
    v.setUint32(32 + i * 12, 1000);
    v.setUint32(36 + i * 12, 4000);
    v.setUint32(40 + i * 12, 0x90000000);
  }
  return out;
}

type Route = () => Response;
/** Bodies a test hands out as streams, to see whether the engine cancelled them. */
const cancelled = new Set<string>();

/** Answer fetches from `routes`; anything else is a 404. */
function serve(routes: Record<string, Route>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const route = routes[url];
      return route ? route() : new Response('not found', { status: 404 });
    }),
  );
}
const text = (body: string) => () => new Response(body, { status: 200 });
const partial = (bytes: Uint8Array<ArrayBuffer>) => () => new Response(bytes, { status: 206 });
/** A server that ignores Range: 200 with the whole 50 MB file, as a stream that records a cancel. */
const wholeFile = (name: string) => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(64 * 1024)),
      cancel: () => void cancelled.add(name),
    }),
    { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } },
  );

const platform: Platform = { setHeaderRule: async () => {}, saveBlob: async () => undefined, jobsChanged: () => {}, archive: async () => true };

function candidate(url: string, extra: Partial<Candidate> = {}): Candidate {
  return { id: 'c1', tabId: 1, url, kind: 'dash', mime: '', contentLength: null, pageUrl: 'https://site.example/watch', pageTitle: 'Show', referer: '', seenAt: 0, ...extra };
}

async function inspect(c: Candidate): Promise<Inspection> {
  const r = await new Engine(platform).inspect(c);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const TEMPLATE = '<SegmentTemplate timescale="1" duration="4" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>';
const BARE_TEMPLATE = '<SegmentTemplate timescale="1" duration="4" media="$RepresentationID$/$Number$.m4s"/>';
const DRM = '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>';
const mpd = (sets: string) =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S"><Period>${sets}</Period></MPD>`;
const videoSet = (reps: string, template = TEMPLATE) => `<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">${template}${reps}</AdaptationSet>`;
const audioSet = (reps: string, template = TEMPLATE) =>
  `<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">${template}${reps}</AdaptationSet>`;
const HD = '<Representation id="hd" bandwidth="6000000" width="1920" height="1080">';
const SD = '<Representation id="sd" bandwidth="1000000" width="640" height="360"/>';
const AUDIO = '<Representation id="a" bandwidth="128000"/>';

beforeEach(() => cancelled.clear());
afterEach(() => vi.unstubAllGlobals());

describe('inspect: DASH DRM per representation', () => {
  it('lists the clear representations, leaves the protected ones out with a note, and prefers clear audio', async () => {
    serve({ [MPD_URL]: text(mpd(videoSet(`${HD}${DRM}</Representation>${SD}`) + audioSet(`<Representation id="a-drm" bandwidth="256000">${DRM}</Representation>${AUDIO}`))) });
    const i = await inspect(candidate(MPD_URL));
    expect(i.variants.map((v) => v.label)).toEqual(['640x360 · 1000 kbps · avc1.64001f + English']);
    expect(i.variants[0]!.audioUri).toBe(`${BASE}a/init.mp4`);
    expect(i.notes).toContain('Left out 1920x1080 6000 kbps, audio English 256 kbps: DRM protected, which Magpie does not download.');
    // Fold rules cover every representation, the protected ones too: the player fetches those.
    expect(i.children).toContain(`${BASE}hd/*.m4s`);
  });

  it('refuses the MPD when every video, or every audio, is protected', async () => {
    serve({ [MPD_URL]: text(mpd(videoSet(`${HD}${DRM}</Representation>`) + audioSet(AUDIO))) });
    await expect(inspect(candidate(MPD_URL))).rejects.toThrow(/DRM/);
    serve({ [MPD_URL]: text(mpd(videoSet(SD) + audioSet(`<Representation id="a" bandwidth="128000">${DRM}</Representation>`))) });
    await expect(inspect(candidate(MPD_URL))).rejects.toThrow(/DRM/);
  });

  it('treats a CA_descriptor EssentialProperty like ContentProtection', async () => {
    const ca = '<EssentialProperty schemeIdUri="urn:mpeg:dash:13818:1:CA_descriptor:2011" value="0x4AE0"/>';
    serve({ [MPD_URL]: text(mpd(videoSet(`${HD}${ca}</Representation>${SD}`) + audioSet(AUDIO))) });
    const i = await inspect(candidate(MPD_URL));
    expect(i.variants).toHaveLength(1);
    expect(i.notes.join(' ')).toMatch(/1920x1080 6000 kbps: DRM protected/);
  });
});

describe('inspect: DASH representations without an init segment', () => {
  it('saves video only, saying why, when the audio template names no init', async () => {
    serve({ [MPD_URL]: text(mpd(videoSet(SD) + audioSet(AUDIO, BARE_TEMPLATE))) });
    const i = await inspect(candidate(MPD_URL));
    expect(i.variants.map((v) => v.label)).toEqual(['640x360 · 1000 kbps · avc1.64001f']);
    expect(i.variants[0]!.audioUri).toBeUndefined();
    expect(i.notes.join(' ')).toMatch(/Left out audio English 128 kbps: no initialization segment.*video only/);
  });

  it('refuses an MPD whose video names no init', async () => {
    serve({ [MPD_URL]: text(mpd(videoSet(SD, BARE_TEMPLATE) + audioSet(AUDIO))) });
    await expect(inspect(candidate(MPD_URL))).rejects.toThrow(/no initialization segment/);
  });
});

describe('inspect: DASH SegmentBase indexes', () => {
  const file = (id: string, attrs: string) =>
    `<Representation id="${id}" ${attrs}><BaseURL>${id}.mp4</BaseURL><SegmentBase indexRange="100-155"><Initialization range="0-99"/></SegmentBase></Representation>`;
  const video = (id: string, bw: number, w: number, h: number) => file(id, `bandwidth="${bw}" width="${w}" height="${h}"`);
  const videoSets = (reps: string) => `<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">${reps}</AdaptationSet>`;
  const audioSets = (id: string) => `<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">${file(id, 'bandwidth="128000"')}</AdaptationSet>`;

  it('drops a representation whose file is gone or whose server ignores Range, and keeps the rest', async () => {
    serve({
      [MPD_URL]: text(mpd(videoSets(video('v1', 3000000, 1280, 720) + video('v2', 2000000, 960, 540) + video('v3', 1000000, 640, 360)) + audioSets('a'))),
      [`${BASE}v1.mp4`]: partial(sidx()),
      [`${BASE}v3.mp4`]: wholeFile('v3'),
      [`${BASE}a.mp4`]: partial(sidx()),
    });
    const i = await inspect(candidate(MPD_URL));
    expect(i.variants.map((v) => v.label)).toEqual(['1280x720 · 3000 kbps · avc1.64001f + audio']);
    expect(i.notes).toContain('Left out 960x540 2000 kbps: its segment index could not be read (HTTP 404).');
    expect(i.notes).toContain('Left out 640x360 1000 kbps: the server ignores Range requests, so reading its index would download the whole file.');
    expect(cancelled.has('v3')).toBe(true);
    expect(i.children).toEqual([`${BASE}v1.mp4`, `${BASE}v2.mp4`, `${BASE}v3.mp4`, `${BASE}a.mp4`]);
  });

  it('words the note for several representations that failed the same way', async () => {
    serve({
      [MPD_URL]: text(mpd(videoSets(video('v1', 3000000, 1280, 720) + video('v2', 2000000, 960, 540) + video('v3', 1000000, 640, 360)) + audioSets('a'))),
      [`${BASE}v1.mp4`]: partial(sidx()),
      [`${BASE}a.mp4`]: partial(sidx()),
    });
    const i = await inspect(candidate(MPD_URL));
    expect(i.notes).toContain('Left out 960x540 2000 kbps, 640x360 1000 kbps: their segment indexes could not be read (HTTP 404).');
  });

  it('merges the next audio when the chosen one fails, and fails only when no video is left', async () => {
    serve({
      [MPD_URL]: text(mpd(videoSets(video('v1', 3000000, 1280, 720)) + audioSets('main') + audioSets('dub'))),
      [`${BASE}v1.mp4`]: partial(sidx()),
      [`${BASE}dub.mp4`]: partial(sidx()),
    });
    const i = await inspect(candidate(MPD_URL));
    expect(i.variants[0]!.audioUri).toBe(`${BASE}dub.mp4`);
    expect(i.notes).toContain('Left out audio 128 kbps: its segment index could not be read (HTTP 404).');
    serve({ [MPD_URL]: text(mpd(videoSets(video('v1', 3000000, 1280, 720)) + audioSets('a'))), [`${BASE}a.mp4`]: partial(sidx()) });
    await expect(inspect(candidate(MPD_URL))).rejects.toThrow(/1280x720 3000 kbps: its segment index could not be read \(HTTP 404\)/);
  });
});

describe('inspect: HLS separate audio', () => {
  const MASTER = 'https://cdn.example/hls/master.m3u8';
  const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na1.m4s\n#EXT-X-ENDLIST\n';

  it('reads the audio playlist even when the candidate looks live, and names a language that has no NAME', async () => {
    serve({
      [MASTER]: text('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"\nvideo.m3u8\n'),
      'https://cdn.example/hls/audio.m3u8': text(PLAYLIST),
    });
    // Reloads marked the candidate live, but the playlists are on demand: the pair still merges.
    const i = await inspect(candidate(MASTER, { kind: 'hls', live: true }));
    expect(i.variants[0]!.label).toBe('1280x720 · 2000 kbps + English');
    expect(i.variants[0]!.audioUri).toBe('https://cdn.example/hls/audio.m3u8');
  });
});

// The dash fixture's 720p video and its audio, served from https://live.example/s1/ as a live MPD.
const mediaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'testsite', 'public', 'media', 'dash');
const noFixture = !existsSync(join(mediaDir, 'init-0.m4s'));
const LIVE_URL = 'https://live.example/s1/manifest.mpd';
const sets = `
  <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f"><Representation id="0" bandwidth="2014352" width="1280" height="720">
    <SegmentTemplate timescale="1000000" duration="4000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
  </Representation></AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2"><Representation id="2" bandwidth="58266" audioSamplingRate="48000">
    <SegmentTemplate timescale="1000000" duration="4000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
  </Representation></AdaptationSet>`;
/** An absolute BaseURL carrying `token`, as a CDN that signs every MPD response writes it. */
const baseUrl = (token?: string) => (token ? `<BaseURL>https://live.example/s1/${token}/</BaseURL>` : '');
/** The stream 10 s after it started: segments 1 and 2 of each side are out. */
const live = (token?: string) =>
  `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${new Date(Date.now() - 10_000).toISOString()}" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT20S">${baseUrl(token)}<Period id="0" start="PT0S">${sets}</Period></MPD>`;
/** The same stream once it ended, 8 s long. */
const ended = (token?: string) =>
  `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">${baseUrl(token)}<Period id="0" start="PT0S">${sets}</Period></MPD>`;

describe('start: an inspection read again', () => {
  const MASTER = 'https://cdn.example/hls/master.m3u8';
  const hls = candidate(MASTER, { kind: 'hls' });
  const ladder = (...rungs: [number, string][]) =>
    text(`#EXTM3U\n${rungs.map(([bandwidth, resolution]) => `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution}\nv${resolution}.m3u8\n`).join('')}`);
  const started: { engine: Engine; job: Job }[] = [];

  afterEach(() => {
    // The jobs would go on to fetch their playlists; these tests are about what start() picked.
    for (const { engine, job } of started.splice(0)) engine.cancel(job.id);
    vi.useRealTimers();
  });

  /** An engine that inspected `first` as the master, with the clock moved past INSPECTION_MAX_AGE. */
  async function aged(first: Route): Promise<Engine> {
    vi.useFakeTimers({ toFake: ['Date'] });
    serve({ [MASTER]: first });
    const engine = new Engine(platform);
    const r = await engine.inspect(hls);
    if (!r.ok) throw new Error(r.error);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    return engine;
  }

  async function startJob(engine: Engine, c: Candidate, variantId: string): Promise<Job> {
    const r = await engine.start(c, variantId);
    if (!r.ok) throw new Error(r.error);
    started.push({ engine, job: r.value });
    return r.value;
  }

  it('finds the shown quality by its label in a ladder that changed', async () => {
    const engine = await aged(ladder([2000000, '1280x720'], [1000000, '640x360']));
    serve({ [MASTER]: ladder([6000000, '1920x1080'], [2000000, '1280x720'], [1000000, '640x360']) });
    // v1 was 360p on the sheet and is 720p in the new ladder.
    expect((await startJob(engine, hls, 'v1')).variantLabel).toBe('640x360 · 1000 kbps');
  });

  it('refuses, instead of taking another quality, when the shown one is gone', async () => {
    const engine = await aged(ladder([2000000, '1280x720'], [1000000, '640x360']));
    serve({ [MASTER]: ladder([6000000, '1920x1080'], [1000000, '640x360']) });
    const r = await engine.start(hls, 'v0');
    expect(r.ok ? r.value.variantLabel : r.error).toBe("The stream's qualities changed; open it again and pick one.");
  });

  it('keeps an HLS inspection that is only old when reading the master again fails', async () => {
    const engine = await aged(ladder([2000000, '1280x720'], [1000000, '640x360']));
    serve({});
    expect((await startJob(engine, hls, 'v0')).variantLabel).toBe('1280x720 · 2000 kbps');
  });

  it('fails when a live MPD cannot be read again, since its window has moved on', async () => {
    serve({ [LIVE_URL]: () => new Response(live(), { status: 200 }) });
    const engine = new Engine(platform);
    expect((await engine.inspect(candidate(LIVE_URL))).ok).toBe(true);
    serve({});
    const r = await engine.start(candidate(LIVE_URL), 'v0');
    expect(r.ok ? r.value.variantLabel : r.error).toMatch(/HTTP 404/);
  });
});

describe('record: live DASH in memory', () => {
  const blobs = new Map<string, Blob>();
  const created = URL.createObjectURL;
  const revoked = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = created;
    URL.revokeObjectURL = revoked;
  });

  /** Top level box types of a saved part, and where its first fragment starts on the file's own clock. */
  async function describePart(blob: Blob): Promise<{ types: string[]; start: number | null }> {
    const data = new Uint8Array(await blob.arrayBuffer());
    const top = [...boxes(data, 0, data.byteLength)];
    const moov = top.find((b) => b.type === 'moov')!;
    const moof = top.find((b) => b.type === 'moof')!;
    const timescale = trackTimescales(data.subarray(moov.start, moov.end)).get(1)!;
    return { types: top.map((b) => b.type), start: startOf(data.subarray(moof.start), timescale) };
  }

  /**
   * Record LIVE_URL to its end, held in memory as in a Firefox private
   * window. `manifest` answers each fetch of the MPD, the inspection's first;
   * `fileFor` names the fixture file a media URL gets.
   */
  async function record(manifest: (reload: number) => string, fileFor = (url: string) => url.slice(url.lastIndexOf('/') + 1), partBytes?: number) {
    // No OPFS: the recording is held in memory, and saved in parts past partBytes.
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist: async () => false, getDirectory: async () => Promise.reject(new Error('no OPFS here')) } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = `blob:test/${blobs.size}`;
      blobs.set(url, blob as Blob);
      return url;
    };
    URL.revokeObjectURL = () => {};
    let reloads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === LIVE_URL) return new Response(manifest(reloads++), { status: 200 });
        const file = join(mediaDir, fileFor(url));
        return url.startsWith('https://live.example/s1/') && existsSync(file) ? new Response(readFileSync(file), { status: 200 }) : new Response('', { status: 404 });
      }),
    );
    const saved: { filename: string; blob: Blob }[] = [];
    const notes = new Set<string>();
    let finish!: (failed?: Job) => void;
    const over = new Promise<Job | undefined>((resolve) => (finish = resolve));
    const host: Platform = {
      setHeaderRule: async () => {},
      saveBlob: async (url, filename) => void saved.push({ filename, blob: blobs.get(url)! }),
      jobsChanged: (jobs) => {
        for (const job of jobs) {
          if (job.note) notes.add(job.note);
          if (job.state === 'error') finish(job);
        }
      },
      archive: async () => {
        finish();
        return true;
      },
    };
    const engine = partBytes === undefined ? new Engine(host) : new Engine(host, partBytes);
    const started = await engine.start(candidate(LIVE_URL, { pageTitle: 'Cam' }), 'v0');
    expect(started.ok && started.value.live).toBe(true);
    const failed = await over;
    return { failed, saved, notes: [...notes].join(' ') };
  }

  it.skipIf(noFixture)('starts the next part with the joined init again and its own time 0 (Merger.restart)', async () => {
    // The MPD turns static on the recorder's first reload, so one pass records both segments of each side and the
    // recording ends without waiting. A part is full at 1 byte, so the second video segment starts part 2.
    const { failed, saved, notes } = await record((n) => (n === 0 ? live() : ended()), undefined, 1);
    expect(failed?.error).toBeUndefined();
    expect(saved.map((s) => s.filename)).toEqual([expect.stringMatching(/ part 1\.mp4$/), expect.stringMatching(/ part 2\.mp4$/)]);
    expect(notes).toMatch(/saved in parts of 2 GB/);
    for (const { blob } of saved) {
      const part = await describePart(blob);
      // Each part opens with the joined init and holds one video and one audio fragment.
      expect(part.types.slice(0, 2)).toEqual(['ftyp', 'moov']);
      expect(part.types.filter((t) => t === 'moof')).toHaveLength(2);
      // Part 2 is anchored again at its own first fragment, 4 s into the stream, so it plays from 0 on its own.
      expect(part.start).toBeLessThan(0.1);
    }
  });

  it.skipIf(noFixture)('goes on when a rotating BaseURL token renames the same init on every reload', async () => {
    // Inspect reads t0, the recorder's first pass t1 and records, its second t2, by then static.
    const { failed, saved, notes } = await record((n) => (n < 2 ? live(`t${n}`) : ended(`t${n}`)));
    expect(failed?.error).toBeUndefined();
    expect(notes).not.toMatch(/another init segment/);
    expect(saved).toHaveLength(1);
    const file = await describePart(saved[0]!.blob);
    expect(file.types.filter((t) => t === 'moof')).toHaveLength(4);
  });

  it.skipIf(noFixture)('ends and saves what it has when the renamed init has other bytes', async () => {
    // At t2 the video init is the audio's: another init, which the joined init written at the start cannot follow.
    const { failed, saved, notes } = await record(
      (n) => (n < 2 ? live(`t${n}`) : ended(`t${n}`)),
      (url) => (url.endsWith('/t2/init-0.m4s') ? 'init-2.m4s' : url.slice(url.lastIndexOf('/') + 1)),
    );
    expect(failed?.error).toBeUndefined();
    expect(notes).toMatch(/switched to another init segment, so the recording ended there/);
    expect(saved).toHaveLength(1);
  });
});
