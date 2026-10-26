import { describe, expect, it } from 'vitest';
import {
  addEntry,
  indexArchive,
  isArchived,
  makeEntry,
  mergeStores,
  normalizeArchive,
  pageKey,
  skeleton,
  splitForStorage,
  streamKey,
  type ArchiveEntry,
} from './archive';

const entry = (over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id: 'j1',
  title: 'Harbor at Dusk',
  file: 'Harbor at Dusk.mp4',
  page: 'https://site.example/watch/1',
  src: streamKey('https://cdn.example/v/1/master.m3u8'),
  at: 1000,
  ...over,
});

/** Is a candidate at `url` on `pageUrl` hidden once `downloaded` (on `downloadedPage`) is archived? `siblings` are other streams in the tab. */
function hides(downloaded: string, downloadedPage: string, url: string, pageUrl: string, live = false, siblings: string[] = []): boolean {
  const e = makeEntry({ id: 'x', filename: 'f.mp4', finishedAt: 1 }, { url: downloaded, pageUrl: downloadedPage, pageTitle: 'T' });
  return isArchived({ url, pageUrl, live }, indexArchive([e]), siblings.map((u) => ({ url: u, pageUrl })));
}

describe('streamKey', () => {
  it('drops signatures, expiry times, cache busters and LL-HLS directives', () => {
    expect(streamKey('https://cdn.example/v/1/master.m3u8?Expires=1793000000&Signature=abc123def456ghi789&Key-Pair-Id=APKAEXAMPLE')).toBe(
      'https://cdn.example/v/1/master.m3u8',
    );
    expect(streamKey('https://cdn.example/live.m3u8?_HLS_msn=12&_HLS_part=3&_=1729500000000')).toBe('https://cdn.example/live.m3u8');
    expect(streamKey('https://b.example/x.m3u8?X-Amz-Signature=ff00&X-Amz-Date=20261026T000000Z&q=hd')).toBe('https://b.example/x.m3u8?q=hd');
  });
  it('keeps ids and sorts what is left', () => {
    expect(streamKey('https://cdn.example/play.m3u8?vid=1234567&cam=2')).toBe('https://cdn.example/play.m3u8?cam=2&vid=1234567');
  });
  it('keeps a time shaped value under an id name', () => {
    expect(streamKey('https://cdn.example/get.m3u8?id=1712345678&media_id=1712345678901&t=1712345678')).toBe(
      'https://cdn.example/get.m3u8?id=1712345678&media_id=1712345678901',
    );
  });
});

describe('skeleton', () => {
  it('wildcards token path segments and drops opaque query values', () => {
    expect(skeleton('https://vod.example/exp=1793000000~acl=%2F*~hmac=ab12cd34/123/playlist.m3u8?s=aB3dE5fG7hJ9kL1mN3')).toBe(
      'https://vod.example/*/123/playlist.m3u8',
    );
  });
  it('keeps hex ids and segments that only look like key=value', () => {
    expect(skeleton('https://a.example/v/id=123/stream.m3u8?asset=65f1a2b3c4d5e6f7a8b9c0d1&file=da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe(
      'https://a.example/v/id=123/stream.m3u8?asset=65f1a2b3c4d5e6f7a8b9c0d1&file=da39a3ee5e6b4b0d3255bfef95601890afd80709',
    );
    expect(skeleton('https://a.example/hdntl=exp=1793000000/v/1712345678/index.m3u8')).toBe('https://a.example/*/v/*/index.m3u8');
  });
  it('keeps numeric ids and UUIDs', () => {
    expect(skeleton('https://cdn.example/play.m3u8?id=1850000000000000001&u=3f2b1c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d')).toBe(
      'https://cdn.example/play.m3u8?id=1850000000000000001&u=3f2b1c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d',
    );
  });
});

describe('pageKey', () => {
  it('drops the hash and tracking parameters', () => {
    expect(pageKey('https://site.example/watch?v=42&utm_source=x&fbclid=y#t=30')).toBe('https://site.example/watch?v=42');
  });
  it('is empty for anything but a web page', () => {
    expect(pageKey('')).toBe('');
    expect(pageKey('about:blank')).toBe('');
    expect(pageKey('javascript:alert(1)')).toBe('');
  });
});

describe('isArchived', () => {
  it('matches the same stream on a later visit with fresh tokens, on any page', () => {
    expect(
      hides(
        'https://cdn.example/v/1/master.m3u8?Expires=1793000000&Signature=aaa111bbb222ccc333',
        'https://site.example/watch/1',
        'https://cdn.example/v/1/master.m3u8?Expires=1793099999&Signature=zzz999yyy888xxx777',
        'https://other.example/embed/1',
      ),
    ).toBe(true);
  });
  it('matches a token in the path when the page is the same', () => {
    const a = 'https://vod.example/exp=1793000000~acl=%2F*~hmac=aaaa1111/v/9/playlist.m3u8';
    const b = 'https://vod.example/exp=1793055555~acl=%2F*~hmac=bbbb2222/v/9/playlist.m3u8';
    expect(hides(a, 'https://site.example/video/9', b, 'https://site.example/video/9#comments')).toBe(true);
    expect(hides(a, 'https://site.example/video/9', b, 'https://site.example/video/10')).toBe(false);
  });
  it('matches an opaque token under an unknown name when the page is the same', () => {
    const a = 'https://v.redd.example/abc/HLSPlaylist.m3u8?a=1793000000%2CaGVsbG8xMjM0NTY3OA&v=1&f=sd';
    const b = 'https://v.redd.example/abc/HLSPlaylist.m3u8?a=1793077777%2Cd29ybGQ5ODc2NTQzMg&v=1&f=sd';
    expect(hides(a, 'https://reddit.example/r/x/comments/abc', b, 'https://reddit.example/r/x/comments/abc')).toBe(true);
  });
  it('keeps two videos behind one endpoint apart', () => {
    expect(hides('https://cdn.example/play.m3u8?id=1234567', '', 'https://cdn.example/play.m3u8?id=1234568', '')).toBe(false);
    expect(hides('https://cdn.example/play.m3u8?id=1012345678', '', 'https://cdn.example/play.m3u8?id=1012345679', '')).toBe(false);
    expect(hides('https://cdn.example/get.m3u8?id=1712345678', 'https://a.example/', 'https://cdn.example/get.m3u8?id=1798765432', 'https://b.example/')).toBe(false);
    expect(hides('https://cdn.example/get.m3u8?vid=1712345678901', '', 'https://cdn.example/get.m3u8?vid=1712345678902', '')).toBe(false);
    const u1 = 'https://cdn.example/play.m3u8?vid=3f2b1c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d';
    const u2 = 'https://cdn.example/play.m3u8?vid=9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(hides(u1, 'https://site.example/feed', u2, 'https://site.example/feed')).toBe(false);
  });
  it('keeps lessons on one page apart when their ids are hex or sit in the path', () => {
    const feed = 'https://a.example/course/7';
    expect(hides('https://a.example/stream.m3u8?asset=65f1a2b3c4d5e6f7a8b9c0d1', feed, 'https://a.example/stream.m3u8?asset=65f1a2b3c4d5e6f7a8b9c0d2', feed)).toBe(false);
    expect(hides('https://a.example/dl?file=da39a3ee5e6b4b0d3255bfef95601890afd80709', feed, 'https://a.example/dl?file=aa39a3ee5e6b4b0d3255bfef95601890afd80709', feed)).toBe(false);
    expect(hides('https://a.example/v/id=123/index.m3u8', feed, 'https://a.example/v/id=456/index.m3u8', feed)).toBe(false);
  });
  it('drops the page rule when a sibling stream on the page has the same shape', () => {
    const page = 'https://site.example/course/7';
    const a = 'https://cdn.example/play.m3u8?k=Lesson1AbCdEfGh12';
    const b = 'https://cdn.example/play.m3u8?k=Lesson2ZyXwVuTs34';
    // Alone on the page, b looks like a fresh token for a.
    expect(hides(a, page, b, page)).toBe(true);
    // With a still listed next to it, they are two videos.
    expect(hides(a, page, b, page, false, [a, b])).toBe(false);
    // a itself still matches exactly.
    expect(hides(a, page, a, page, false, [a, b])).toBe(true);
  });
  it('keeps two videos in one feed apart', () => {
    const a = 'https://video.twimg.example/ext_tw_video/1850000000000000001/pu/pl/AbCdEfGh12345678.m3u8?variant_version=1&tag=12';
    const b = 'https://video.twimg.example/ext_tw_video/1850000000000000002/pu/pl/ZyXwVuTs87654321.m3u8?variant_version=1&tag=12';
    expect(hides(a, 'https://x.example/home', b, 'https://x.example/home')).toBe(false);
  });
  it('never hides a live stream', () => {
    const url = 'https://cam.example/live/master.m3u8';
    expect(hides(url, 'https://cam.example/', url, 'https://cam.example/')).toBe(true);
    expect(hides(url, 'https://cam.example/', url, 'https://cam.example/', true)).toBe(false);
  });
  it('skips the page rule when the page is unknown', () => {
    const a = 'https://vod.example/exp=1793000000~hmac=aaaa1111/v/9/playlist.m3u8';
    const b = 'https://vod.example/exp=1793055555~hmac=bbbb2222/v/9/playlist.m3u8';
    expect(hides(a, '', b, '')).toBe(false);
  });
});

describe('makeEntry', () => {
  it('keeps what the archive shows and the stream key', () => {
    const e = makeEntry(
      { id: 'j9', filename: 'Night Train [480p].mp4', finishedAt: 5 },
      { url: 'https://cdn.example/v/1/master.m3u8?Signature=abc123def456ghi789', pageUrl: 'https://site.example/watch/1', pageTitle: 'Night Train' },
      20.04,
    );
    expect(e).toEqual({
      id: 'j9',
      title: 'Night Train',
      file: 'Night Train [480p].mp4',
      page: 'https://site.example/watch/1',
      src: 'https://cdn.example/v/1/master.m3u8',
      at: 5,
      secs: 20,
    });
  });
  it('leaves out an unknown length, marks private windows, and drops a huge page URL', () => {
    const e = makeEntry({ id: 'j', filename: 'f.mp4' }, { url: 'https://a.example/f.mp4', pageUrl: `https://a.example/?q=${'x'.repeat(3000)}`, pageTitle: '', incognito: true });
    expect(e.secs).toBeUndefined();
    expect(e.priv).toBe(true);
    expect(e.page).toBe('');
  });
});

describe('addEntry', () => {
  it('puts the newest first, once per id, and trims to the size', () => {
    let list: ArchiveEntry[] = [];
    list = addEntry(list, entry({ id: 'a', at: 1 }), 2);
    list = addEntry(list, entry({ id: 'b', at: 2 }), 2);
    list = addEntry(list, entry({ id: 'a', at: 3 }), 2);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    list = addEntry(list, entry({ id: 'c', at: 4 }), 2);
    expect(list.map((e) => e.id)).toEqual(['c', 'a']);
  });
});

describe('storage', () => {
  it('normalizeArchive drops junk and sorts newest first', () => {
    const raw = [entry({ id: 'old', at: 1 }), null, { id: 'no-time' }, 'x', { ...entry({ id: 'new', at: 9 }), secs: -1, priv: 'yes' }, entry({ id: 'p', at: 5, priv: true })];
    const list = normalizeArchive(raw);
    expect(list.map((e) => e.id)).toEqual(['new', 'p', 'old']);
    expect(list[0]!.secs).toBeUndefined();
    expect(list[0]!.priv).toBeUndefined();
    expect(list[1]!.priv).toBe(true);
    expect(normalizeArchive({})).toEqual([]);
  });
  it('splitForStorage keeps private entries in session storage unless the user keeps them', () => {
    const list = [entry({ id: 'a' }), entry({ id: 'p', priv: true })];
    expect(splitForStorage(list, false)).toEqual({ local: [list[0]], session: [list[1]] });
    expect(splitForStorage(list, true)).toEqual({ local: list, session: [] });
  });
  it('mergeStores joins both stores, one entry per id, newest first, without trimming', () => {
    const local = [entry({ id: 'a', at: 3 }), entry({ id: 'b', at: 1 })];
    const session = [entry({ id: 'p', at: 2, priv: true }), entry({ id: 'b', at: 1 })];
    expect(mergeStores(local, session).map((e) => e.id)).toEqual(['a', 'p', 'b']);
  });
});
