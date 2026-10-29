// @vitest-environment jsdom
// jsdom for DOMParser, which the sliding SegmentTimeline test parses its MPDs with; see dash.test.ts for why not happy-dom.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableRange, parseMpd, type DashLive, type DashManifest, type DashRepresentation } from '../core/dash';
import { parseHls, type HlsMaster, type HlsSegment, type MediaPlaylist } from '../core/hls';
import {
  clockOffset,
  initContainer,
  initState,
  isEncrypted,
  liveReloadMs,
  LiveCursor,
  liveStartSec,
  mainRendition,
  missingLast,
  pairProblem,
  periodChange,
  sinkContainer,
  stitchedAd,
  supportedTiming,
  type UsedInit,
} from './engine';
import { HttpError } from './fetcher';
import { box } from './mux';

function master(text: string): HlsMaster {
  const p = parseHls(`#EXTM3U\n${text}\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n`, 'https://cdn.example/m.m3u8');
  if (p.kind !== 'master') throw new Error('not a master');
  return p;
}

function media(text: string): MediaPlaylist {
  const p = parseHls(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${text}`, 'https://cdn.example/a.m3u8');
  if (p.kind !== 'media') throw new Error('not a media playlist');
  return p;
}

const FMP4 = '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s\n#EXTINF:4,\ns2.m4s\n#EXT-X-ENDLIST\n';

describe('mainRendition', () => {
  it('takes DEFAULT=YES over an earlier rendition', () => {
    const m = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Dub",URI="dub.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="main.m3u8"');
    expect(mainRendition(m.renditions)?.name).toBe('Main');
  });

  it('falls back to the first AUTOSELECT=YES, then the first', () => {
    const auto = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="One",URI="1.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Two",AUTOSELECT=YES,URI="2.m3u8"');
    expect(mainRendition(auto.renditions)?.name).toBe('Two');
    const plain = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="One",URI="1.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Two",URI="2.m3u8"');
    expect(mainRendition(plain.renditions)?.name).toBe('One');
  });

  it('keeps a default without URI, so a dub is never merged over muxed main audio', () => {
    const m = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Dub",URI="dub.m3u8"');
    const r = mainRendition(m.renditions);
    expect(r?.name).toBe('Main');
    expect(r?.uri).toBeUndefined();
  });

  it('is undefined for an empty group', () => {
    expect(mainRendition([])).toBeUndefined();
  });
});

describe('pairProblem', () => {
  it('accepts complete fMP4 playlists with one init each', () => {
    expect(pairProblem(media(FMP4), media(FMP4))).toBeNull();
    expect(pairProblem(media(FMP4))).toBeNull();
  });

  it('refuses live, discontinuities and a second init, saying video only', () => {
    const live = media('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s\n');
    const broken = media('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\ns2.m4s\n#EXT-X-ENDLIST\n');
    const twoMaps = media('#EXT-X-MAP:URI="a.mp4"\n#EXTINF:4,\ns1.m4s\n#EXT-X-MAP:URI="b.mp4"\n#EXTINF:4,\ns2.m4s\n#EXT-X-ENDLIST\n');
    const tsBreak = media('#EXTINF:4,\ns1.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\ns2.ts\n#EXT-X-ENDLIST\n');
    expect(pairProblem(live)).toMatch(/^Live.*video only/);
    expect(pairProblem(media(FMP4), live)).toMatch(/^Live/);
    expect(pairProblem(broken)).toMatch(/discontinuities.*video only/);
    expect(pairProblem(tsBreak, media(FMP4))).toMatch(/discontinuities.*video only/);
    expect(pairProblem(twoMaps, media(FMP4))).toMatch(/another init segment.*video only/);
  });

  it('accepts MPEG-TS on either side, and mixed pairs', () => {
    const ts = media('#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n#EXT-X-ENDLIST\n');
    // Packed audio names say nothing about the container; without an init it goes through mux.js.
    const packed = media('#EXTINF:4,\ns1.aac\n#EXT-X-ENDLIST\n');
    expect(pairProblem(ts)).toBeNull();
    expect(pairProblem(ts, ts)).toBeNull();
    expect(pairProblem(ts, media(FMP4))).toBeNull();
    expect(pairProblem(media(FMP4), ts)).toBeNull();
    expect(pairProblem(packed, ts)).toBeNull();
  });

  it('refuses fMP4 segments without an init, and an empty audio playlist', () => {
    const bare = media('#EXTINF:4,\ns1.m4s\n#EXT-X-ENDLIST\n');
    expect(pairProblem(bare)).toMatch(/no init segment.*video only/);
    expect(pairProblem(media(FMP4), bare)).toMatch(/no init segment.*video only/);
    expect(pairProblem(media('#EXT-X-ENDLIST\n'))).toMatch(/no segments.*video only/);
  });

  it('ignores a discontinuity before the first segment', () => {
    expect(pairProblem(media(`#EXT-X-DISCONTINUITY\n${FMP4}`))).toBeNull();
  });
});

describe('stitchedAd', () => {
  const segments = '#EXTINF:2,Amazon|2474283100494\nad.ts\n#EXTINF:2,Amazon\nold.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,live\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,Other|1\nc.ts\n';

  it('is a segment of a Twitch playlist titled after the ad source, with or without a creative id', () => {
    const m = media(`#EXT-X-TWITCH-ELAPSED-SECS:13065.052\n${segments}`);
    expect(m.segments.map((s) => stitchedAd(m, s))).toEqual([true, true, false, false, false]);
  });

  it('is nothing on another site, whatever the titles say', () => {
    const m = media(segments);
    expect(m.segments.map((s) => stitchedAd(m, s))).toEqual([false, false, false, false, false]);
  });
});

describe('missingLast', () => {
  const list = media(FMP4);
  const err = (status: number) => new HttpError(status, 'https://cdn.example/s2.m4s');

  it('skips a missing last segment of a $Number$ template on 403, 404 and 410', () => {
    // 403: S3 behind CloudFront answers it for an object that does not exist.
    for (const status of [403, 404, 410]) expect(missingLast({ media: list, lastOptional: true }, 1, err(status)), String(status)).toBe(true);
  });

  it('fails the job on any other error, any other segment, or a list that names only what exists', () => {
    expect(missingLast({ media: list, lastOptional: true }, 1, err(500))).toBe(false);
    expect(missingLast({ media: list, lastOptional: true }, 1, err(401))).toBe(false);
    expect(missingLast({ media: list, lastOptional: true }, 1, new TypeError('Failed to fetch'))).toBe(false);
    expect(missingLast({ media: list, lastOptional: true }, 0, err(404))).toBe(false);
    expect(missingLast({ media: list }, 1, err(404))).toBe(false);
  });
});

describe('isEncrypted', () => {
  const full = (type: string, ...children: Uint8Array[]) => box(type, new Uint8Array(4), ...children);
  const init = (entry: string, extra: Uint8Array[] = []) =>
    box('moov', box('mvhd'), box('trak', box('mdia', box('minf', box('stbl', full('stsd', new Uint8Array([0, 0, 0, 1]), box(entry, new Uint8Array(8))))))), ...extra);

  it('finds encv, enca and pssh', () => {
    expect(isEncrypted(init('avc1'))).toBe(false);
    expect(isEncrypted(init('mp4a'))).toBe(false);
    expect(isEncrypted(init('encv'))).toBe(true);
    expect(isEncrypted(init('enca'))).toBe(true);
    expect(isEncrypted(init('avc1', [box('pssh', new Uint8Array(24))]))).toBe(true);
  });
});

/** 4 s segments numbered from 1, timescale 1 MHz: the shape of the live DASH simulator in testsite/server. */
function liveRep(periodDuration?: number): DashRepresentation {
  return {
    id: '0',
    type: 'video',
    mimeType: 'video/mp4',
    encrypted: false,
    setIndex: 0,
    fold: [],
    template: {
      base: 'https://cdn.example/live/',
      media: 'chunk-$RepresentationID$-$Number%05d$.m4s',
      init: { uri: 'https://cdn.example/live/init-0.m4s' },
      timescale: 1_000_000,
      duration: 4_000_000,
      startNumber: 1,
      presentationTimeOffset: '0',
      availabilityTimeOffset: 0,
      periodStart: 0,
      periodDuration,
    },
  };
}

const AST = 1_800_000_000;
const LIVE: DashLive = { availabilityStartTime: AST, timeShiftBufferDepth: 20, minimumUpdatePeriod: 2, periodStart: 0, utcTiming: [] };
/** The live window `sec` seconds after availabilityStartTime, on a clock already corrected by UTCTiming. */
const windowAt = (sec: number, live: DashLive = LIVE) => availableRange(liveRep(), live, AST + sec).media.segments;
/** The same stream once its MPD turned static with mediaPresentationDuration PT20S. */
const staticList = () => availableRange(liveRep(20), undefined, AST + 30).media.segments;
const numbers = (segments: HlsSegment[]) => segments.map((s) => s.sequence);
const seg = (sequence: number, start: number, duration: number): HlsSegment => ({
  index: 0,
  title: '',
  sequence,
  uri: `s${sequence}.m4s`,
  duration,
  start,
  key: { method: 'NONE' },
  map: null,
  discontinuity: false,
});

describe('live DASH segment selection', () => {
  /** Write every segment of a pass, the way recordLiveDash reports them to the cursor. */
  const loadAll = (c: LiveCursor, segments: HlsSegment[]) => segments.forEach((s) => expect(c.loaded(s)).toBe(false));
  const at = (segments: HlsSegment[], sequence: number) => segments.find((s) => s.sequence === sequence)!;

  it('follows the clock: segment n is out 4n s in, and leaves after the time shift buffer', () => {
    expect(numbers(windowAt(3.9))).toEqual([]);
    expect(numbers(windowAt(4))).toEqual([1]);
    expect(numbers(windowAt(13))).toEqual([1, 2, 3]);
    // 20 s of time shift at 30 s: segments 1 and 2 (0 to 8 s) are gone.
    expect(numbers(windowAt(30))).toEqual([3, 4, 5, 6, 7]);
    expect(numbers(staticList())).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts LIVE_LEAD_IN seconds back from the live edge, always with the newest segment', () => {
    const hour = windowAt(60, { ...LIVE, timeShiftBufferDepth: 3600 });
    expect(numbers(hour)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // Up to 30 s back from the end at 60 s: seven 4 s segments, from 32 s.
    const startSec = liveStartSec(hour, 30)!;
    expect(startSec).toBe(32);
    expect(numbers(new LiveCursor().fresh(hour, startSec).segments)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    // The simulator: a recording started 7 s in has segment 1 only, and takes it.
    expect(liveStartSec(windowAt(7), 30)).toBe(0);
    // A newest segment longer than the lead in is still taken; nothing out yet gives no start.
    expect(liveStartSec([seg(1, 0, 4), seg(2, 4, 40)], 30)).toBe(4);
    expect(liveStartSec(windowAt(2), 30)).toBeUndefined();
  });

  it('starts the audio with the segment that plays at the video start', () => {
    const audio = [0, 2, 4, 6, 8, 10].map((start, i) => seg(i + 1, start, 2));
    expect(numbers(new LiveCursor().fresh(audio, 8).segments)).toEqual([5, 6]);
    expect(numbers(new LiveCursor().fresh(audio, 7).segments)).toEqual([4, 5, 6]);
  });

  it('appends only segments after the last one written', () => {
    const c = new LiveCursor();
    const first = c.fresh(windowAt(9), 0);
    expect(numbers(first.segments)).toEqual([1, 2]);
    loadAll(c, first.segments);
    const next = c.fresh(windowAt(13), 0);
    expect(numbers(next.segments)).toEqual([3]);
    expect(next.gap).toBe(false);
  });

  it('asks again for a newest segment that is not out yet, without a gap', () => {
    // A held dynamic MPD at 24.5 s names segment 6, which the stream, ending after 5, never publishes.
    const c = new LiveCursor();
    loadAll(c, c.fresh(windowAt(13), 0).segments);
    const edge = c.fresh(windowAt(24.5), 0);
    expect(numbers(edge.segments)).toEqual([4, 5, 6]);
    expect(c.loaded(at(edge.segments, 4))).toBe(false);
    expect(c.loaded(at(edge.segments, 5))).toBe(false);
    c.failed();
    expect(c.last).toEqual({ start: 16, end: 20 });
    // The next reload is static with five segments: nothing left, nothing lost.
    const done = c.fresh(staticList(), 0);
    expect(done.segments).toEqual([]);
    expect(done.gap).toBe(false);
  });

  it('writes a newest segment that failed once on the next pass, still without a gap', () => {
    const c = new LiveCursor();
    const first = c.fresh(windowAt(8.5), 0);
    expect(numbers(first.segments)).toEqual([1, 2]);
    c.loaded(at(first.segments, 1));
    c.failed();
    const again = c.fresh(windowAt(10.5), 0);
    expect(numbers(again.segments)).toEqual([2]);
    expect(again.gap).toBe(false);
    expect(c.loaded(at(again.segments, 2))).toBe(false);
  });

  it('counts a failed segment as a gap once a later one loads', () => {
    const c = new LiveCursor();
    const pass = c.fresh(windowAt(13), 0);
    c.loaded(at(pass.segments, 1));
    c.failed();
    expect(c.loaded(at(pass.segments, 3))).toBe(true);
    expect(c.last).toEqual({ start: 8, end: 12 });
  });

  it('counts a window that moved past unwritten segments as a gap', () => {
    const c = new LiveCursor();
    loadAll(c, c.fresh(windowAt(9), 0).segments);
    const later = c.fresh(windowAt(40), 0);
    expect(numbers(later.segments)).toEqual([6, 7, 8, 9, 10]);
    expect(later.gap).toBe(true);
  });

  describe('a side that loads nothing', () => {
    /** One pass in which every segment fails, as with 401 or 403 on each; true when the side is dead after it. */
    const deadPass = (c: LiveCursor, window: HlsSegment[]) => {
      const fresh = c.fresh(window, 0);
      expect(fresh.segments.length).toBeGreaterThan(0);
      fresh.segments.forEach(() => c.failed());
      return c.endPass();
    };

    it('ends only after 6 passes and 30 s, at a pass a second', () => {
      let now = 0;
      const c = new LiveCursor(() => now);
      loadAll(c, c.fresh(windowAt(9), 0).segments);
      expect(c.endPass()).toBe(false);
      // Six passes in six seconds: a 7 s segment published 6 s late would end the recording under a pass count alone.
      for (let pass = 1; pass <= 6; pass++) {
        now = (pass - 1) * 1000;
        expect(deadPass(c, windowAt(13))).toBe(false);
      }
      expect(c.deadPasses).toBe(6);
      now = 29_999;
      expect(deadPass(c, windowAt(13))).toBe(false);
      now = 30_000;
      expect(deadPass(c, windowAt(13))).toBe(true);
      // A pass with nothing new keeps the verdict; a load clears it.
      expect(c.fresh([], 0).segments).toEqual([]);
      expect(c.endPass()).toBe(true);
      c.loaded(c.fresh(windowAt(40), 0).segments[0]!);
      expect(c.endPass()).toBe(false);
      expect(c.deadPasses).toBe(0);
    });

    it('waits 3 segment durations when that is longer than 30 s', () => {
      let now = 0;
      const c = new LiveCursor(() => now);
      const window = [seg(1, 0, 20), seg(2, 20, 20)];
      c.fresh(window, 0);
      c.loaded(window[0]!);
      c.failed();
      expect(c.endPass()).toBe(false);
      for (let pass = 1; pass <= 6; pass++) {
        now = pass * 10_000;
        expect(deadPass(c, window)).toBe(false);
      }
      now = 69_999;
      expect(deadPass(c, window)).toBe(false);
      now = 70_000;
      expect(deadPass(c, window)).toBe(true);
    });

    it('waits 6 passes when they take longer than the time', () => {
      let now = 0;
      const c = new LiveCursor(() => now);
      loadAll(c, c.fresh(windowAt(9), 0).segments);
      // A pass every 10 s, as at the reload cap: 50 s of failures but only five passes.
      for (let pass = 1; pass <= 5; pass++) {
        now = (pass - 1) * 10_000;
        expect(deadPass(c, windowAt(13))).toBe(false);
      }
      now = 50_000;
      expect(deadPass(c, windowAt(13))).toBe(true);
    });
  });
});

describe('live DASH with a sliding $Time$ SegmentTimeline', () => {
  // A packager that slides the S entries with the window and never moves startNumber, so every reload
  // numbers its segments 1 to 5 again. 4 s segments, timescale 1, the first at t = T.
  const T = 1_761_600_000;
  const mpd = (first: number, r: number) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT20S">
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1" startNumber="1" media="v-$Time$.m4s" initialization="v-init.mp4">
        <SegmentTimeline><S t="${first}" d="4" r="${r}"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  /** The window of one reload, `slid` segments after the first. */
  const reload = (slid: number, r = 4) => parseMpd(mpd(T + slid * 4, r), 'https://cdn.example/live/manifest.mpd', (T + slid * 4 + 4 * (r + 1)) * 1000).video[0]!.media!.segments;
  const names = (segments: HlsSegment[]) => segments.map((s) => s.uri.split('/').pop());

  it('takes exactly the one new segment when the window slides by one, with no gap', () => {
    const c = new LiveCursor();
    const first = reload(0);
    const pass1 = c.fresh(first, liveStartSec(first, 30)!);
    expect(names(pass1.segments)).toEqual(['v-1761600000.m4s', 'v-1761600004.m4s', 'v-1761600008.m4s', 'v-1761600012.m4s', 'v-1761600016.m4s']);
    pass1.segments.forEach((s) => c.loaded(s));
    const slid = reload(1);
    // The same numbers name newer segments: numbering restarts from startNumber on every reload.
    expect(numbers(slid)).toEqual(numbers(first));
    const pass2 = c.fresh(slid, 0);
    expect(names(pass2.segments)).toEqual(['v-1761600020.m4s']);
    expect(pass2.gap).toBe(false);
  });

  it('starts over at the window start when segment times go back inside the Period, an encoder restart', () => {
    const c = new LiveCursor();
    const first = reload(0);
    c.fresh(first, liveStartSec(first, 30)!).segments.forEach((s) => c.loaded(s));
    expect(c.last?.start).toBe(T + 16);
    // Same Period, same availabilityStartTime, and t restarts at 1000: nothing in the window starts after the last one written.
    const after = parseMpd(mpd(1000, 1), 'https://cdn.example/live/manifest.mpd', (1000 + 8) * 1000).video[0]!.media!.segments;
    const pass = c.fresh(after, 0);
    expect(pass.restarted).toBe(true);
    expect(names(pass.segments)).toEqual(['v-1000.m4s', 'v-1004.m4s']);
    expect(pass.gap).toBe(false);
    expect(c.last).toBeUndefined();
  });

  it('does not take a window that lags by a segment, as a cached MPD can, for a restart', () => {
    const c = new LiveCursor();
    reload(1).forEach((s) => c.loaded(s));
    const lagging = c.fresh(reload(0), 0);
    expect(lagging.restarted).toBe(false);
    expect(lagging.segments).toEqual([]);
  });

  it('flags a gap when the window slides past segments never written', () => {
    // A two segment window slid by three: the segment between the two windows was never listed.
    const c = new LiveCursor();
    const first = reload(0, 1);
    c.fresh(first, 0).segments.forEach((s) => c.loaded(s));
    const later = c.fresh(reload(3, 1), 0);
    expect(names(later.segments)).toEqual(['v-1761600012.m4s', 'v-1761600016.m4s']);
    expect(later.gap).toBe(true);
  });
});

describe('periodChange', () => {
  const mpd = (o: Partial<DashManifest>): DashManifest => ({
    type: 'dynamic',
    periodCount: 1,
    periodIndex: 0,
    periodStart: 0,
    video: [],
    audio: [],
    notes: [],
    live: { ...LIVE },
    ...o,
  });

  it('keeps recording while the Period and the clock stay', () => {
    expect(periodChange(mpd({ periodId: '0' }), mpd({ periodId: '0' }))).toBeNull();
    expect(periodChange(mpd({}), mpd({}))).toBeNull();
  });

  it('ends on another Period, by id, or by start when the MPD gives no ids', () => {
    expect(periodChange(mpd({ periodId: 'p1' }), mpd({ periodId: 'p2' }))).toMatch(/another Period/);
    expect(periodChange(mpd({ periodId: 'p1' }), mpd({}))).toMatch(/another Period/);
    expect(periodChange(mpd({ periodStart: 0 }), mpd({ periodStart: 600 }))).toMatch(/another Period/);
  });

  it('ends when availabilityStartTime moves', () => {
    expect(periodChange(mpd({}), mpd({ live: { ...LIVE, availabilityStartTime: AST + 5 } }))).toMatch(/restarted/);
  });

  it('does not count turning static at the end as a change', () => {
    expect(periodChange(mpd({ periodId: '0' }), mpd({ periodId: '0', type: 'static', live: undefined, duration: 20 }))).toBeNull();
  });
});

describe('liveReloadMs', () => {
  it('reloads every minimumUpdatePeriod, 2 s without one, within 1 to 10 s', () => {
    expect(liveReloadMs(LIVE)).toBe(2000);
    expect(liveReloadMs(undefined)).toBe(2000);
    expect(liveReloadMs({ ...LIVE, minimumUpdatePeriod: undefined })).toBe(2000);
    expect(liveReloadMs({ ...LIVE, minimumUpdatePeriod: 6 })).toBe(6000);
    expect(liveReloadMs({ ...LIVE, minimumUpdatePeriod: 0 })).toBe(1000);
    expect(liveReloadMs({ ...LIVE, minimumUpdatePeriod: 60 })).toBe(10000);
  });
});

describe('supportedTiming', () => {
  it('takes the first http-xsdate, http-iso, http-head or direct element', () => {
    const ntp = { schemeIdUri: 'urn:mpeg:dash:utc:ntp:2014', value: 'time.example' };
    const head = { schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014', value: 'https://time.example/' };
    const xsdate = { schemeIdUri: 'urn:mpeg:dash:utc:http-xsdate:2014', value: 'https://time.example/now' };
    const direct = { schemeIdUri: 'urn:mpeg:dash:utc:direct:2014', value: '2026-10-27T12:00:00Z' };
    expect(supportedTiming([ntp, xsdate, head, direct])).toBe(xsdate);
    expect(supportedTiming([ntp, head, xsdate])).toBe(head);
    expect(supportedTiming([direct, xsdate])).toBe(direct);
    expect(supportedTiming([ntp])).toBeUndefined();
    expect(supportedTiming([])).toBeUndefined();
  });
});

describe('clockOffset', () => {
  afterEach(() => vi.unstubAllGlobals());
  const allow = async () => {};

  it('reads http-head from the Date header of a HEAD request', async () => {
    // The server is a minute ahead. Its Date header drops the fraction of the second.
    const ahead = Date.now() + 60_000;
    const fetch = vi.fn(async () => new Response(null, { status: 200, headers: { date: new Date(ahead).toUTCString() } }));
    vi.stubGlobal('fetch', fetch);
    const offset = await clockOffset([{ schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014', value: 'https://time.example/' }], 'https://cdn.example/live.mpd', allow, new AbortController().signal);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('HEAD');
    expect(offset).toBeGreaterThan(59);
    expect(offset).toBeLessThan(61);
  });

  it('trusts the local clock when the time server sends no Date or fails', async () => {
    const timing = [{ schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014', value: 'https://time.example/' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    expect(await clockOffset(timing, 'https://cdn.example/live.mpd', allow, new AbortController().signal)).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    expect(await clockOffset(timing, 'https://cdn.example/live.mpd', allow, new AbortController().signal)).toBe(0);
  });
});

describe('initContainer', () => {
  it('reads MPEG-TS from an init that holds the PAT and PMT, though an HLS playlist with EXT-X-MAP says fMP4', () => {
    const two = new Uint8Array(376).fill(0xff);
    two[0] = 0x47;
    two[188] = 0x47;
    expect(initContainer(two, 'fmp4')).toBe('ts');
    // One packet can carry both tables.
    const one = new Uint8Array(188).fill(0xff);
    one[0] = 0x47;
    expect(initContainer(one, 'fmp4')).toBe('ts');
  });

  it('reads fMP4 from an ftyp, moov or styp box, and keeps the playlist container otherwise', () => {
    expect(initContainer(box('ftyp', new Uint8Array(8)), 'ts')).toBe('fmp4');
    expect(initContainer(box('moov'), 'ts')).toBe('fmp4');
    expect(initContainer(box('styp'), 'ts')).toBe('fmp4');
    expect(initContainer(new Uint8Array(16), 'ts')).toBe('ts');
    expect(initContainer(new Uint8Array(16), 'fmp4')).toBe('fmp4');
    expect(initContainer(null, 'ts')).toBe('ts');
  });
});

describe('initState', () => {
  const init = (n: number) => box('moov', new Uint8Array([n]));
  const at = (token: string) => ({ uri: `https://cdn.example/${token}/init-0.m4s` });

  it('loads an init a rotating token renamed, goes on when the bytes match, and compares the next reload with the new URL', async () => {
    const load = vi.fn(async (map: { uri: string }) => (map.uri.includes('/t3/') ? init(2) : init(1)));
    const used: UsedInit = { key: '', bytes: init(1) };
    expect(await initState(used, at('t1'), load)).toBe('same');
    expect(await initState(used, at('t1'), load)).toBe('same');
    // The same URL twice is not loaded again.
    expect(load).toHaveBeenCalledTimes(1);
    expect(await initState(used, at('t2'), load)).toBe('same');
    expect(load).toHaveBeenCalledTimes(2);
    expect(await initState(used, at('t3'), load)).toBe('changed');
  });

  it('says unreadable for an HTTP or network error, and lets a cancel through', async () => {
    const used: UsedInit = { key: '', bytes: init(1) };
    expect(await initState(used, at('t1'), async () => Promise.reject(new HttpError(403, at('t1').uri)))).toBe('unreadable');
    expect(await initState(used, at('t1'), async () => Promise.reject(new TypeError('Failed to fetch')))).toBe('unreadable');
    await expect(initState(used, at('t1'), async () => Promise.reject(new DOMException('aborted', 'AbortError')))).rejects.toThrow('aborted');
  });
});

describe('sinkContainer', () => {
  const ts = new Uint8Array(376).fill(0xff);
  ts[0] = 0x47;
  ts[188] = 0x47;
  const fmp4 = box('moof', box('mfhd', new Uint8Array(8)));

  it('writes MPEG-TS through mux.js even when the stream has an init segment', () => {
    // A DASH Initialization for MPEG-TS holds the PAT and PMT; passing it through would save raw TS as .mp4.
    expect(sinkContainer('ts', ts)).toBe('ts');
    // An HLS EXT-X-MAP before TS segments makes the playlist say fmp4; the bytes say otherwise.
    expect(sinkContainer('fmp4', ts)).toBe('ts');
    expect(sinkContainer('unknown', ts)).toBe('ts');
  });

  it('passes fMP4 through, and anything it cannot tell', () => {
    expect(sinkContainer('fmp4', fmp4)).toBe('fmp4');
    expect(sinkContainer('unknown', fmp4)).toBe('fmp4');
    expect(sinkContainer('unknown', new Uint8Array(4))).toBe('fmp4');
  });
});
