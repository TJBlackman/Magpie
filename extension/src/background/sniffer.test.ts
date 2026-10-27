import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inspection } from '../core/types';

/** The listener the sniffer registers on webRequest.onHeadersReceived, captured by the fake below. */
const hooks = vi.hoisted(() => ({ onHeaders: null as ((details: unknown) => void) | null }));

// Only what Sniffer touches. No storage.session, so nothing is persisted or restored.
vi.mock('wxt/browser', () => ({
  browser: {
    webRequest: { onHeadersReceived: { addListener: (fn: (details: unknown) => void) => void (hooks.onHeaders = fn) } },
    tabs: {
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      get: async (tabId: number) => ({ id: tabId, url: 'https://site.example/watch', title: 'Watch', incognito: false }),
    },
    runtime: { getURL: (path: string) => `chrome-extension://magpie/${path}`, sendMessage: async () => undefined },
    storage: {},
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  },
}));

const { Sniffer } = await import('./sniffer');
const { matchesFoldRule } = await import('../core/detect');

const TAB = 7;
const MPD = 'https://cdn.example/show/manifest.mpd';
const MASTER = 'https://cdn.example/hls/master.m3u8';

/** A response the page's player got, through the listener the sniffer registered. */
async function respond(url: string, mime: string, opts: { type?: string; length?: number } = {}) {
  const headers = [{ name: 'Content-Type', value: mime }];
  if (opts.length !== undefined) headers.push({ name: 'Content-Length', value: String(opts.length) });
  hooks.onHeaders!({ tabId: TAB, statusCode: 200, url, type: opts.type ?? 'xmlhttprequest', responseHeaders: headers });
  // The sniffer awaits its restore and tabs.get; one macrotask lets every microtask before it run.
  await new Promise((r) => setTimeout(r, 0));
}

/** A large video XHR, which detect() lists as a plain file. */
const file = (url: string) => respond(url, 'video/mp4', { length: 5 * 1024 * 1024 });

const inspection = (candidateId: string, kind: 'hls' | 'dash', children: string[]): Inspection => ({ candidateId, kind, variants: [], notes: [], children });

describe('matchesFoldRule', () => {
  it('matches an exact URL, or a prefix*suffix rule', () => {
    expect(matchesFoldRule('https://cdn.example/a/init.mp4', 'https://cdn.example/a/init.mp4')).toBe(true);
    expect(matchesFoldRule('https://cdn.example/a/init.mp4', 'https://cdn.example/a/init.mp4?x=1')).toBe(false);
    expect(matchesFoldRule('https://cdn.example/a/720p/*', 'https://cdn.example/a/720p/00012.mp4')).toBe(true);
    expect(matchesFoldRule('https://cdn.example/a/720p/*', 'https://cdn.example/a/360p/00012.mp4')).toBe(false);
    expect(matchesFoldRule('https://cdn.example/a/*.m4s', 'https://cdn.example/a/00012.m4s')).toBe(true);
    expect(matchesFoldRule('https://cdn.example/a/*.m4s', 'https://cdn.example/a/fallback_720p.mp4')).toBe(false);
  });

  it('never lets the prefix and the suffix overlap, and splits at the last *', () => {
    expect(matchesFoldRule('https://cdn.example/a/seg*seg', 'https://cdn.example/a/seg')).toBe(false);
    expect(matchesFoldRule('https://cdn.example/a/seg*seg', 'https://cdn.example/a/segseg')).toBe(true);
    expect(matchesFoldRule('https://cdn.example/a*b/*.m4s', 'https://cdn.example/a*b/1.m4s')).toBe(true);
  });
});

describe('Sniffer folding', () => {
  let sniffer: InstanceType<typeof Sniffer>;
  const shownUrls = async () => (await sniffer.forTab(TAB)).map((c) => c.url).sort();

  beforeEach(() => {
    sniffer = new Sniffer();
    sniffer.listen();
  });

  it('folds a file row that arrived before the MPD was inspected, by exact URL', async () => {
    await respond(MPD, 'application/dash+xml');
    await file('https://cdn.example/show/video_720.mp4');
    expect(await shownUrls()).toEqual([MPD, 'https://cdn.example/show/video_720.mp4']);
    const rows = await sniffer.forTab(TAB);
    const mpd = rows.find((c) => c.url === MPD)!;
    const video = rows.find((c) => c.url !== MPD)!;
    sniffer.learn(mpd.id, inspection(mpd.id, 'dash', ['https://cdn.example/show/video_720.mp4']));
    expect(await shownUrls()).toEqual([MPD]);
    expect((await sniffer.get(video.id))?.parentId).toBe(mpd.id);
  });

  it('folds file rows that arrive after the MPD was inspected, by exact URL and by rule, and leaves other files alone', async () => {
    await respond(MPD, 'application/dash+xml');
    const mpd = (await sniffer.forTab(TAB))[0]!;
    const rules = ['https://cdn.example/show/audio_en.mp4', 'https://cdn.example/show/720p/*', 'https://cdn.example/show/*.m4v'];
    sniffer.learn(mpd.id, inspection(mpd.id, 'dash', rules));
    // Fold rules are kept as given, not normalized like playlist URLs.
    expect(mpd.children).toEqual(rules);
    await respond('https://cdn.example/show/audio_en.mp4', 'audio/mp4', { type: 'media' });
    await file('https://cdn.example/show/720p/00012.mp4');
    await file('https://cdn.example/show/00012.m4v');
    await file('https://cdn.example/other/clip.mp4');
    // A rule with a suffix covers the MPD's folder only for files that end the same way: the fallback MP4 keeps its row.
    await file('https://cdn.example/show/fallback_720p.mp4');
    expect(await shownUrls()).toEqual(['https://cdn.example/other/clip.mp4', 'https://cdn.example/show/fallback_720p.mp4', MPD]);
  });

  it('still folds an HLS variant playlist with a fresh token under its master, through sameStream', async () => {
    const manifests: string[] = [];
    sniffer.onManifest = (c) => void manifests.push(c.id);
    await respond(MASTER, 'application/vnd.apple.mpegurl');
    const master = (await sniffer.forTab(TAB))[0]!;
    sniffer.learn(master.id, inspection(master.id, 'hls', ['https://cdn.example/hls/v720.m3u8?token=abcdef1234567890abcd']));
    // Same path, a different volatile token: the stream the master lists.
    await respond('https://cdn.example/hls/v720.m3u8?token=zyxw9876543210zyxwvu', 'application/vnd.apple.mpegurl');
    // A query that is not volatile names another stream, which keeps its row.
    await respond('https://cdn.example/hls/v720.m3u8?cam=2', 'application/vnd.apple.mpegurl');
    expect(await shownUrls()).toEqual([MASTER, 'https://cdn.example/hls/v720.m3u8?cam=2']);
    const rows = await Promise.all(manifests.map((id) => sniffer.get(id)));
    expect(rows.find((c) => c?.url.includes('token=zyxw'))?.parentId).toBe(master.id);
  });
});
