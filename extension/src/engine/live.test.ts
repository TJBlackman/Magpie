import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHls, type HlsSegment, type MediaPlaylist } from '../core/hls';
import type { Candidate, Job } from '../core/types';
import { Engine, resumeAt, sameVariant } from './engine';
import { fetchIdle } from './fetcher';
import type { Platform } from './platform';

const mediaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'testsite', 'public', 'media', 'hls-ts');
const noFixture = !existsSync(join(mediaDir, 'seg000.ts'));

const CAM = 'https://live.example/cam/';
const MASTER = `${CAM}master.m3u8`;
const FIRST = 100;
/** Segments the stream has before EXT-X-ENDLIST. */
const LENGTH = 12;

/**
 * A live MPEG-TS stream replayed from the hls-ts fixture (segment n is
 * seg00(n % 5).ts, with a discontinuity at each wrap), whose clock moves one
 * segment per playlist load. The playlist answers at index.m3u8?token=<t>
 * while that token is the current one; `expireAt` loads in, the token turns
 * over and the old one answers 403, as an expired one does. With `freezeAt`
 * the token turns over too, but the old address keeps answering with the
 * window it had then, as a CDN edge the page has left may.
 */
function stream(opts: { expireAt?: number; goneAt?: number; hangOnce?: number; freezeAt?: number } = {}) {
  let token = 't1';
  let loads = 0;
  const fetched = new Map<number, number>();
  let hung = false;
  let frozen = '';
  const playlist = () => {
    loads++;
    if ((opts.expireAt ?? opts.freezeAt) === loads) token = 't2';
    const newest = Math.min(FIRST + LENGTH, FIRST + 1 + loads);
    const from = Math.max(FIRST, newest - 4);
    let body = `#EXTM3U\n#EXT-X-TARGETDURATION:0.05\n#EXT-X-MEDIA-SEQUENCE:${from}\n`;
    for (let s = from; s < newest; s++) body += `${s > FIRST && (s - FIRST) % 5 === 0 ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:4.000,\nseg/${s}.ts\n`;
    if (newest === FIRST + LENGTH) body += '#EXT-X-ENDLIST\n';
    return body;
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (opts.goneAt !== undefined && loads >= opts.goneAt && !u.pathname.includes('/seg/')) return new Response('gone', { status: 404 });
    if (url === MASTER) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nindex.m3u8?token=${token}\n`);
    if (u.pathname === '/cam/index.m3u8') {
      if (u.searchParams.get('token') !== token) return opts.freezeAt !== undefined ? new Response(frozen) : new Response('expired', { status: 403 });
      const body = playlist();
      if (token === 't1') frozen = body;
      return new Response(body);
    }
    const seg = /\/seg\/(\d+)\.ts$/.exec(u.pathname);
    if (seg) {
      const n = Number(seg[1]);
      if (n === opts.hangOnce && !hung) {
        hung = true;
        // A connection that never sends anything, until the request is given up.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      fetched.set(n, (fetched.get(n) ?? 0) + 1);
      return new Response(readFileSync(join(mediaDir, `seg00${(n - FIRST) % 5}.ts`)));
    }
    return new Response('not found', { status: 404 });
  });
  return { fetch, fetched, url: (t: string) => `${CAM}index.m3u8?token=${t}` };
}

function candidate(url: string): Candidate {
  return { id: 'c1', tabId: 1, url, kind: 'hls', mime: '', contentLength: null, pageUrl: 'https://site.example/cam', pageTitle: 'Cam', referer: '', seenAt: 0, live: true };
}

/** Record `url` held in memory, as in a Firefox private window, until the job is saved or fails. */
async function record(url: string, freshUrl?: Platform['freshUrl']) {
  const saved: { filename: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const u = `blob:test/${blobs.size}`;
    blobs.set(u, blob as Blob);
    return u;
  };
  URL.revokeObjectURL = () => {};
  const notes = new Set<string>();
  let last: Job | undefined;
  let finish!: (failed?: Job) => void;
  const over = new Promise<Job | undefined>((resolve) => (finish = resolve));
  const host: Platform = {
    setHeaderRule: async () => {},
    saveBlob: async (u, filename) => void saved.push({ filename, blob: blobs.get(u)! }),
    jobsChanged: (jobs) => {
      for (const job of jobs) {
        last = job;
        if (job.note) notes.add(job.note);
        if (job.state === 'error') finish(job);
      }
    },
    archive: async () => {
      finish();
      return true;
    },
    freshUrl,
  };
  const engine = new Engine(host, undefined, { silentMs: 1500, relocateMs: 100, staleMs: 300 });
  const started = await engine.start(candidate(url), 'v0');
  expect(started.ok).toBe(true);
  const failed = await over;
  return { failed, saved, notes: [...notes], job: last! };
}

describe('a live HLS recording that loses its playlist', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist: async () => false, getDirectory: async () => Promise.reject(new Error('no OPFS here')) } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchIdle.ms = 15_000;
  });

  it.skipIf(noFixture)('follows an expired token to the new address the master gives, without missing or repeating a segment', async () => {
    const s = stream({ expireAt: 5 });
    vi.stubGlobal('fetch', s.fetch);
    const { failed, saved, notes, job } = await record(MASTER);
    expect(failed?.error).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(notes.some((n) => n.startsWith('The stream moved to a new address'))).toBe(true);
    expect(notes.some((n) => n.includes('stopped answering'))).toBe(false);
    // Every segment of the stream once: the new address numbers them the same way, so the recording carries on.
    expect([...s.fetched.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: LENGTH }, (_, i) => FIRST + i));
    expect([...s.fetched.values()].every((n) => n === 1)).toBe(true);
    expect(job.segmentsDone).toBe(LENGTH);
  });

  it.skipIf(noFixture)('leaves a playlist that answers but stopped growing for the address the master gives now', async () => {
    const s = stream({ freezeAt: 5 });
    vi.stubGlobal('fetch', s.fetch);
    const { failed, notes, job } = await record(MASTER);
    expect(failed?.error).toBeUndefined();
    expect(notes.some((n) => n.startsWith('The stream moved to a new address'))).toBe(true);
    expect([...s.fetched.values()].every((n) => n === 1)).toBe(true);
    expect(job.segmentsDone).toBe(LENGTH);
  });

  it.skipIf(noFixture)("follows the page's own newer URL for a stream without a master", async () => {
    const s = stream({ expireAt: 5 });
    vi.stubGlobal('fetch', s.fetch);
    let asked = 0;
    const { failed, notes, job } = await record(s.url('t1'), async () => {
      asked++;
      return s.url('t2');
    });
    expect(failed?.error).toBeUndefined();
    expect(asked).toBeGreaterThan(0);
    expect(notes.some((n) => n.startsWith('The stream moved to a new address'))).toBe(true);
    expect(job.segmentsDone).toBe(LENGTH);
  });

  it.skipIf(noFixture)('gives up a segment request that hangs and goes on, instead of waiting forever', async () => {
    fetchIdle.ms = 100;
    const s = stream({ hangOnce: FIRST + 4 });
    vi.stubGlobal('fetch', s.fetch);
    const { failed, job } = await record(MASTER);
    expect(failed?.error).toBeUndefined();
    // The hung request was given up and asked again, so nothing is missing.
    expect(s.fetched.get(FIRST + 4)).toBe(1);
    expect(job.segmentsDone).toBe(LENGTH);
  });

  it.skipIf(noFixture)('ends and saves what it has once the playlist has not answered for silentMs', async () => {
    const s = stream({ goneAt: 6 });
    vi.stubGlobal('fetch', s.fetch);
    const t0 = Date.now();
    const { failed, saved, job } = await record(MASTER);
    expect(failed?.error).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(job.note).toMatch(/stopped answering, so the recording ended there/);
    // Not after six quick failures, as before: it rode out silentMs (1.5 s here) first.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
  });
});

describe('resumeAt', () => {
  const at = Date.parse('2026-11-23T20:00:00Z');
  /** A live window of 2 s segments numbered from `first`, dated from `date` when given. */
  const window = (first: number, count: number, date?: number): MediaPlaylist => {
    let body = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    if (date !== undefined) body += `#EXT-X-PROGRAM-DATE-TIME:${new Date(date).toISOString()}\n`;
    for (let i = 0; i < count; i++) body += `#EXTINF:2.000,\n${first + i}.ts\n`;
    const p = parseHls(body, 'https://live.example/index.m3u8');
    if (p.kind !== 'media') throw new Error('not media');
    return p;
  };
  const seg = (sequence: number, date?: number): HlsSegment => ({ ...window(sequence, 1, date).segments[0]! });

  it('lines up by wall clock where both playlists date their segments, whatever the numbering', () => {
    // The last segment written was numbered 500 and ended at +10 s; the new address numbers from 7 and starts at +4 s.
    expect(resumeAt(window(7, 8, at + 4000), 501, seg(500, at + 8000), 5)).toEqual({ next: 10, cut: true, sure: true });
    // Same numbering and the same clock: no cut.
    expect(resumeAt(window(498, 8, at + 4000), 501, seg(500, at + 8000), 5)).toEqual({ next: 501, cut: false, sure: true });
    // Everything listed is already recorded: wait for the next one.
    expect(resumeAt(window(7, 3, at), 501, seg(500, at + 8000), 5)).toEqual({ next: 10, cut: true, sure: true });
  });

  it('carries on by number when the old next segment is in the new window', () => {
    expect(resumeAt(window(98, 6), 101, seg(100), 3)).toEqual({ next: 101, cut: false, sure: true });
    expect(resumeAt(window(98, 6), 104, seg(103), 3)).toEqual({ next: 104, cut: false, sure: true });
  });

  it('goes back about as long as nothing came, at most 30 s, after a cut, when the numbering is another', () => {
    // 4 s without news: the two newest segments of the new window (7 to 26).
    expect(resumeAt(window(7, 20), 501, seg(500), 4)).toEqual({ next: 25, cut: true, sure: false });
    // A minute without news: 30 s back (the 15 newest, of 7 to 46), no more.
    expect(resumeAt(window(7, 40), 501, seg(500), 60)).toEqual({ next: 32, cut: true, sure: false });
  });
});

describe('sameVariant', () => {
  const v = (uri: string, bandwidth: number, resolution?: string) => ({ uri, bandwidth, resolution });
  it('takes the same URL, else the same resolution at the nearest bandwidth, else the nearest bandwidth', () => {
    const ladder = [v('a/1080.m3u8?t=2', 6_000_000, '1920x1080'), v('a/720.m3u8?t=2', 3_100_000, '1280x720'), v('a/480.m3u8?t=2', 1_400_000, '854x480')];
    expect(sameVariant(ladder, v('a/480.m3u8?t=2', 0))?.uri).toBe('a/480.m3u8?t=2');
    expect(sameVariant(ladder, v('a/720.m3u8?t=1', 3_000_000, '1280x720'))?.uri).toBe('a/720.m3u8?t=2');
    expect(sameVariant(ladder, v('a/900.m3u8?t=1', 5_000_000, '1600x900'))?.uri).toBe('a/1080.m3u8?t=2');
    expect(sameVariant([], v('a', 1))).toBeUndefined();
  });
});
