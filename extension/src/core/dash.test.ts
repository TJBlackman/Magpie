// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom matches XML tag names case insensitively and
// has no working namespaces, so a test could pass on code that fails in a browser.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  availableRange,
  chooseAudio,
  dashRange,
  fillTemplate,
  foldRule,
  listRule,
  isoDate,
  isoDuration,
  parseMpd,
  utcTimingTime,
  videoLabel,
  type DashManifest,
  type DashRepresentation,
} from './dash';
import { matchesFoldRule } from './detect';
import { parseHls } from './hls';
import { segmentsFromSidx } from './sidx';

// A path, not new URL(rel, import.meta.url): under jsdom URL is jsdom's class, which fileURLToPath rejects.
const mediaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'testsite', 'public', 'media');
const media = (rel: string) => join(mediaDir, ...rel.split('/'));
const onDisk = (rel: string) => existsSync(media(rel));

/** testsite/public/media/dash/manifest.mpd as ffmpeg 4.4 writes it, so the test runs without fixtures. */
const FFMPEG_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	xmlns="urn:mpeg:dash:schema:mpd:2011"
	xmlns:xlink="http://www.w3.org/1999/xlink"
	xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
	profiles="urn:mpeg:dash:profile:isoff-live:2011"
	type="static"
	mediaPresentationDuration="PT20.0S"
	maxSegmentDuration="PT4.0S"
	minBufferTime="PT8.0S">
	<ProgramInformation>
	</ProgramInformation>
	<ServiceDescription id="0">
	</ServiceDescription>
	<Period id="0" start="PT0.0S">
		<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="30/1" maxWidth="1280" maxHeight="720" par="16:9" lang="und">
			<Representation id="0" mimeType="video/mp4" codecs="avc1.64001f" bandwidth="2014352" width="1280" height="720" scanType="unknown" sar="1:1">
				<SegmentTemplate timescale="1000000" duration="4000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
				</SegmentTemplate>
			</Representation>
			<Representation id="1" mimeType="video/mp4" codecs="avc1.64001e" bandwidth="505016" width="640" height="360" scanType="unknown" sar="1:1">
				<SegmentTemplate timescale="1000000" duration="4000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
		<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" lang="und">
			<Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="58266" audioSamplingRate="48000">
				<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1" />
				<SegmentTemplate timescale="1000000" duration="4000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>
`;

const FIXTURE_URL = 'http://127.0.0.1:8787/media/dash/manifest.mpd';
const URL_ = 'https://cdn.example/show/manifest.mpd';

/** A one Period static MPD around the given AdaptationSets. */
function mpd(sets: string, attrs = 'type="static" mediaPresentationDuration="PT8S"'): string {
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>
  <Period id="p0">${sets}</Period>
</MPD>`;
}

const TEMPLATE = '<SegmentTemplate timescale="1" duration="4" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>';
const videoSet = (inner = '', setAttrs = '') =>
  `<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f" ${setAttrs}>${TEMPLATE}${inner}<Representation id="v" bandwidth="1000000" width="1280" height="720"/></AdaptationSet>`;
const audioSet = (inner = '', setAttrs = '', id = 'a', codecs = 'mp4a.40.2', bandwidth = 128000) =>
  `<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="${codecs}" ${setAttrs}>${TEMPLATE}${inner}<Representation id="${id}" bandwidth="${bandwidth}"/></AdaptationSet>`;

function uris(rep: DashRepresentation | undefined): string[] {
  return rep?.media?.segments.map((s) => s.uri) ?? [];
}

/** Every URL a representation fetches: its exact fold rules (the init, whole files) and its segments. */
function fetched(rep: DashRepresentation): string[] {
  return [...rep.fold.filter((f) => !f.includes('*')), ...uris(rep)];
}

/** True when `url` falls under one of the representation's fold rules, the way the sniffer matches them. */
function folded(rep: DashRepresentation, url: string): boolean {
  return rep.fold.some((f) => matchesFoldRule(f, url));
}

function checkFfmpegFixture(m: DashManifest) {
  expect(m.type).toBe('static');
  expect(m.duration).toBe(20);
  expect(m.periodCount).toBe(1);
  expect(m.periodIndex).toBe(0);
  expect(m.notes).toEqual([]);
  expect(m.live).toBeUndefined();
  expect(m.video.map((r) => r.id)).toEqual(['0', '1']);
  expect(m.audio.map((r) => r.id)).toEqual(['2']);

  const [v720, v360] = m.video;
  expect(v720!.media!.segments).toHaveLength(5);
  expect(v360!.media!.segments).toHaveLength(5);
  expect(m.audio[0]!.media!.segments).toHaveLength(5);
  expect(uris(v720)).toEqual([1, 2, 3, 4, 5].map((n) => `http://127.0.0.1:8787/media/dash/chunk-0-0000${n}.m4s`));
  expect(uris(m.audio[0])[0]).toBe('http://127.0.0.1:8787/media/dash/chunk-2-00001.m4s');

  const segs = v720!.media!.segments;
  expect(segs[0]!.map).toEqual({ uri: 'http://127.0.0.1:8787/media/dash/init-0.m4s', byteRange: undefined });
  expect(segs.map((s) => s.start)).toEqual([0, 4, 8, 12, 16]);
  expect(segs.map((s) => s.duration)).toEqual([4, 4, 4, 4, 4]);
  expect(segs.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(segs.every((s) => s.key.method === 'NONE' && !s.discontinuity && !s.byteRange)).toBe(true);
  expect(v720!.media).toMatchObject({ kind: 'media', endList: true, container: 'fmp4', totalDuration: 20, targetDuration: 4, mediaSequence: 1 });
  // One prefix*suffix rule per template, not a URL per segment, and it covers every segment.
  expect(v720!.fold).toEqual(['http://127.0.0.1:8787/media/dash/init-0.m4s', 'http://127.0.0.1:8787/media/dash/chunk-0-*.m4s']);
  for (const r of [...m.video, ...m.audio]) for (const u of uris(r)) expect(folded(r, u), u).toBe(true);
  expect(folded(v720!, uris(m.audio[0])[0]!)).toBe(false);

  expect(v720).toMatchObject({ type: 'video', mimeType: 'video/mp4', codecs: 'avc1.64001f', bandwidth: 2014352, width: 1280, height: 720, frameRate: '30/1', lang: 'und', encrypted: false });
  expect(v720!.muxed).toBeUndefined();
  expect(m.audio[0]).toMatchObject({ type: 'audio', codecs: 'mp4a.40.2', audioSamplingRate: 48000 });
  expect(videoLabel(v720!)).toBe('1280x720 · 2014 kbps · avc1.64001f');
  expect(videoLabel(v360!)).toBe('640x360 · 505 kbps · avc1.64001e');
  expect(chooseAudio(m)?.id).toBe('2');
}

describe('parseMpd: ffmpeg fixture', () => {
  it('lists 5 segments per representation, ceil(20 / 4), with resolved URLs (embedded copy)', () => {
    checkFfmpegFixture(parseMpd(FFMPEG_MPD, FIXTURE_URL));
  });

  it.skipIf(!onDisk('dash/manifest.mpd'))('matches the MPD on disk, and every listed URL exists', () => {
    const m = parseMpd(readFileSync(media('dash/manifest.mpd'), 'utf8'), FIXTURE_URL);
    checkFfmpegFixture(m);
    for (const r of [...m.video, ...m.audio]) {
      for (const u of fetched(r)) expect(onDisk(`dash/${u.split('/').pop()}`), u).toBe(true);
    }
  });

  it.skipIf(!onDisk('dash-timeline/manifest.mpd'))('dash-timeline on disk: $Time$ names match the files', () => {
    const m = parseMpd(readFileSync(media('dash-timeline/manifest.mpd'), 'utf8'), 'http://127.0.0.1:8787/media/dash-timeline/manifest.mpd');
    expect(uris(m.video[0]).map((u) => u.split('/').pop())).toEqual(['chunk-0-0.m4s', 'chunk-0-61440.m4s', 'chunk-0-122880.m4s', 'chunk-0-184320.m4s', 'chunk-0-245760.m4s']);
    const a = m.audio[0]!.media!;
    expect(a.segments.map((s) => s.start)).toEqual([0, 191488 / 48000, 384000 / 48000, 576512 / 48000, 768000 / 48000]);
    expect(a.totalDuration).toBeCloseTo(20, 9);
    for (const r of [...m.video, ...m.audio]) {
      for (const u of fetched(r)) expect(onDisk(`dash-timeline/${u.split('/').pop()}`), u).toBe(true);
    }
  });

  it.skipIf(!onDisk('dash-single/manifest.mpd'))('dash-single on disk: SegmentBase plus the real sidx covers the file to its last byte', () => {
    const m = parseMpd(readFileSync(media('dash-single/manifest.mpd'), 'utf8'), 'http://127.0.0.1:8787/media/dash-single/manifest.mpd');
    for (const rep of [...m.video, ...m.audio]) {
      expect(rep.media).toBeUndefined();
      const sb = rep.segmentBase!;
      expect(rep.fold).toEqual([sb.url]);
      const file = new Uint8Array(readFileSync(media(`dash-single/${sb.url.split('/').pop()}`)));
      const pl = segmentsFromSidx(rep, file.subarray(sb.indexRange.offset, sb.indexRange.offset + sb.indexRange.length), sb.indexRange.offset);
      expect(pl.segments[0]!.map).toEqual({ uri: sb.url, byteRange: sb.initRange });
      expect(pl.totalDuration).toBeCloseTo(20, 1);
      const last = pl.segments[pl.segments.length - 1]!.byteRange!;
      expect(last.offset + last.length).toBe(file.length);
      for (const s of pl.segments) {
        const type = String.fromCharCode(...file.subarray(s.byteRange!.offset + 4, s.byteRange!.offset + 8));
        expect(['moof', 'styp']).toContain(type);
      }
    }
  });
});

describe('parseMpd: SegmentTemplate', () => {
  it('expands a SegmentTimeline with r = -1 to the period end, $Time$ including presentationTimeOffset', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4d401f">
          <SegmentTemplate timescale="90000" presentationTimeOffset="900000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/t$Time$.m4s">
            <SegmentTimeline><S t="900000" d="180000" r="-1"/></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="v1" bandwidth="1000000"/>
        </AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT10S"',
      ),
      URL_,
    );
    const segs = m.video[0]!.media!.segments;
    expect(segs.map((s) => s.uri.split('/').pop())).toEqual(['t900000.m4s', 't1080000.m4s', 't1260000.m4s', 't1440000.m4s', 't1620000.m4s']);
    expect(segs.map((s) => s.start)).toEqual([0, 2, 4, 6, 8]);
    expect(segs[0]!.uri).toBe('https://cdn.example/show/v1/t900000.m4s');
    expect(segs[0]!.map?.uri).toBe('https://cdn.example/show/v1/init.mp4');
    expect(m.video[0]!.fold).toEqual(['https://cdn.example/show/v1/init.mp4', 'https://cdn.example/show/v1/t*.m4s']);
  });

  it('cuts the fold rule at the first placeholder left after $RepresentationID$ and $Bandwidth$, and keeps what follows the last', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4d401f">
          <SegmentTemplate timescale="1" duration="4" media="q/$Bandwidth$/$RepresentationID$_$Number%05d$.mp4?x=$$1"/>
          <Representation id="hd" bandwidth="3000000"/>
        </AdaptationSet>`,
      ),
      URL_,
    );
    const rep = m.video[0]!;
    // No init: the template names none, so the rule is all there is.
    expect(rep.fold).toEqual(['https://cdn.example/show/q/3000000/hd_*.mp4?x=$1']);
    expect(uris(rep)).toEqual(['https://cdn.example/show/q/3000000/hd_00001.mp4?x=$1', 'https://cdn.example/show/q/3000000/hd_00002.mp4?x=$1']);
    for (const u of uris(rep)) expect(folded(rep, u)).toBe(true);
  });

  it('stops r = -1 at the next S@t, and repeats S without t from the previous end', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="1" media="$Time$.m4s" startNumber="7">
            <SegmentTimeline><S t="0" d="2" r="-1"/><S t="10" d="3" r="1"/><S d="1"/></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="v" bandwidth="1"/>
        </AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT17S"',
      ),
      URL_,
    );
    const segs = m.video[0]!.media!.segments;
    expect(segs.map((s) => s.start)).toEqual([0, 2, 4, 6, 8, 10, 13, 16]);
    expect(segs.map((s) => s.sequence)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    expect(m.video[0]!.media!.totalDuration).toBe(17);
    expect(m.video[0]!.media!.targetDuration).toBe(3);
  });

  it('derives the length from a SegmentTimeline when the MPD gives none', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="1000" media="$Number$.m4s"><SegmentTimeline><S t="0" d="2000" r="4"/></SegmentTimeline></SegmentTemplate>
          <Representation id="v" bandwidth="1"/>
        </AdaptationSet>`,
        'type="static"',
      ),
      URL_,
    );
    expect(m.duration).toBe(10);
    expect(m.periodDuration).toBe(10);
    expect(m.video[0]!.media!.segments).toHaveLength(5);
  });

  it('throws a clear error when nothing gives the length of a $Number$ template', () => {
    expect(() => parseMpd(mpd(videoSet(), 'type="static"'), URL_)).toThrow(/mediaPresentationDuration/);
  });

  it('clips the last $Number$ segment to the period and honours endNumber', () => {
    const m = parseMpd(mpd(videoSet(), 'type="static" mediaPresentationDuration="PT10S"'), URL_);
    expect(m.video[0]!.media!.segments.map((s) => s.duration)).toEqual([4, 4, 2]);
    const capped = parseMpd(
      mpd(`<AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="4" endNumber="2" media="$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet>`),
      URL_,
    );
    expect(capped.video[0]!.media!.segments).toHaveLength(2);
  });

  it('inherits SegmentTemplate per attribute from Period and set (Unified Streaming shape)', () => {
    const text = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="1">
    <BaseURL>dash/</BaseURL>
    <SegmentTemplate timescale="1000" media="$RepresentationID$-$Time$.dash" initialization="$RepresentationID$.dash"/>
    <AdaptationSet id="1" group="1" contentType="audio" lang="en" segmentAlignment="true" audioSamplingRate="48000" mimeType="audio/mp4" codecs="mp4a.40.2" startWithSAP="1">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate timescale="48000" media="audio_eng=$Bandwidth$-$Time$.dash" initialization="audio_eng=$Bandwidth$.dash">
        <SegmentTimeline><S t="0" d="192000" r="2"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="audio_eng=128000" bandwidth="128000"/>
    </AdaptationSet>
    <AdaptationSet id="2" group="2" contentType="video" mimeType="video/mp4" codecs="avc1.4D401F" width="1280" height="720" frameRate="25" segmentAlignment="true" startWithSAP="1">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate><SegmentTimeline><S t="0" d="4000" r="2"/></SegmentTimeline></SegmentTemplate>
      <Representation id="video=400000" bandwidth="400000" width="640" height="360"/>
      <Representation id="video=1500000" bandwidth="1500000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(text, 'https://usp.example/vod/clip.ism/.mpd');
    expect(m.video.map((r) => r.id)).toEqual(['video=1500000', 'video=400000']);
    const hi = m.video[0]!;
    expect(hi).toMatchObject({ mimeType: 'video/mp4', codecs: 'avc1.4D401F', width: 1280, height: 720, frameRate: '25', role: 'main' });
    expect(m.video[1]).toMatchObject({ width: 640, height: 360 });
    expect(uris(hi)).toEqual(['0', '4000', '8000'].map((t) => `https://usp.example/vod/clip.ism/dash/video=1500000-${t}.dash`));
    expect(hi.media!.segments[0]!.map?.uri).toBe('https://usp.example/vod/clip.ism/dash/video=1500000.dash');
    expect(hi.media!.segments.map((s) => s.duration)).toEqual([4, 4, 4]);
    const a = m.audio[0]!;
    expect(a).toMatchObject({ lang: 'en', audioSamplingRate: 48000, role: 'main' });
    expect(uris(a)).toEqual(['0', '192000', '384000'].map((t) => `https://usp.example/vod/clip.ism/dash/audio_eng=128000-${t}.dash`));
    expect(a.media!.segments.map((s) => s.start)).toEqual([0, 4, 8]);
  });

  it('formats $Number%05d$, $Time$, $Bandwidth$ and $$', () => {
    expect(fillTemplate('$RepresentationID$/$Number%05d$.m4s', { id: 'v1', number: 42 })).toBe('v1/00042.m4s');
    expect(fillTemplate('seg-$Time$.m4s', { id: 'x', time: 123456789n })).toBe('seg-123456789.m4s');
    expect(fillTemplate('seg-$Time%012d$.m4s', { id: 'x', time: 90000 })).toBe('seg-000000090000.m4s');
    expect(fillTemplate('$Bandwidth%08d$-$Number$', { id: 'x', bandwidth: 128000, number: 3 })).toBe('00128000-3');
    expect(fillTemplate('cost$$5-$Number$', { id: 'x', number: 1 })).toBe('cost$5-1');
    expect(fillTemplate('$Number%03x$', { id: 'x', number: 255 })).toBe('0ff');
    expect(fillTemplate('$Unknown$-$Number$', { id: 'x', number: 9 })).toBe('$Unknown$-9');
    // A digit count longer than the value only pads; a shorter one never truncates.
    expect(fillTemplate('$Number%02d$', { id: 'x', number: 12345 })).toBe('12345');
  });

  it('substitutes $Time$ in the $Number$ form from presentationTimeOffset plus k times duration', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="2000" presentationTimeOffset="500" media="$Number%03d$_$Time$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT6S"',
      ),
      URL_,
    );
    expect(uris(m.video[0]).map((u) => u.split('/').pop())).toEqual(['001_500.m4s', '002_2500.m4s', '003_4500.m4s']);
  });

  it('takes Initialization@sourceURL and @range when the template has no initialization attribute', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="4" media="$Number$.m4s"><Initialization sourceURL="$RepresentationID$-init.mp4" range="0-999"/></SegmentTemplate><Representation id="hd" bandwidth="1"/></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video[0]!.media!.segments[0]!.map).toEqual({ uri: 'https://cdn.example/show/hd-init.mp4', byteRange: { offset: 0, length: 1000 } });
  });
});

describe('parseMpd: SegmentBase and SegmentList', () => {
  it('returns SegmentBase ranges and leaves media for the sidx', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><Representation id="720" bandwidth="2000000" width="1280" height="720">
          <BaseURL>video_720.mp4</BaseURL>
          <SegmentBase indexRange="836-935" timescale="15360" presentationTimeOffset="1536"><Initialization range="0-835"/></SegmentBase>
        </Representation></AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT20S"',
      ),
      URL_,
    );
    const r = m.video[0]!;
    expect(r.media).toBeUndefined();
    expect(r.segmentBase).toEqual({
      url: 'https://cdn.example/show/video_720.mp4',
      initRange: { offset: 0, length: 836 },
      indexRange: { offset: 836, length: 100 },
      presentationTimeOffset: 0.1,
    });
    expect(r.fold).toEqual(['https://cdn.example/show/video_720.mp4']);
  });

  it('notes a SegmentBase without indexRange', () => {
    const m = parseMpd(mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1"><BaseURL>a.mp4</BaseURL><SegmentBase/></Representation></AdaptationSet>`), URL_);
    expect(m.video).toEqual([]);
    expect(m.notes.join(' ')).toMatch(/indexRange/);
  });

  it('reads SegmentList with Initialization, SegmentURL@media and @mediaRange', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1" codecs="avc1.4d401f">
          <BaseURL>file.mp4</BaseURL>
          <SegmentList timescale="1000" duration="4000">
            <Initialization sourceURL="init.mp4" range="0-99"/>
            <SegmentURL mediaRange="100-199" index="x.sidx"/>
            <SegmentURL mediaRange="200-299"/>
            <SegmentURL media="tail.m4s"/>
          </SegmentList>
        </Representation></AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT10S"',
      ),
      URL_,
    );
    const segs = m.video[0]!.media!.segments;
    expect(segs.map((s) => [s.uri, s.byteRange, s.start, s.duration])).toEqual([
      ['https://cdn.example/show/file.mp4', { offset: 100, length: 100 }, 0, 4],
      ['https://cdn.example/show/file.mp4', { offset: 200, length: 100 }, 4, 4],
      ['https://cdn.example/show/tail.m4s', undefined, 8, 2],
    ]);
    expect(segs[0]!.map).toEqual({ uri: 'https://cdn.example/show/init.mp4', byteRange: { offset: 0, length: 100 } });
    // file.mp4 and tail.m4s share only the MPD's folder, so no media rule: it would fold every file beside the MPD.
    expect(m.video[0]!.fold).toEqual(['https://cdn.example/show/init.mp4']);
  });

  it('folds a long SegmentList by one rule, and a list of ranges of one file by its URL', () => {
    const urls = Array.from({ length: 100 }, (_, i) => `<SegmentURL media="seg_${String(i + 1).padStart(5, '0')}.m4s"/>`).join('');
    const long = parseMpd(
      mpd(
        `<AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1"><BaseURL>720p/</BaseURL>
          <SegmentList timescale="1" duration="4"><Initialization sourceURL="init.mp4"/>${urls}</SegmentList>
        </Representation></AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT400S"',
      ),
      URL_,
    ).video[0]!;
    expect(long.media!.segments).toHaveLength(100);
    // Two strings, not 101, however long the list.
    expect(long.fold).toEqual(['https://cdn.example/show/720p/init.mp4', 'https://cdn.example/show/720p/seg_00*.m4s']);
    for (const u of uris(long)) expect(folded(long, u), u).toBe(true);
    expect(folded(long, 'https://cdn.example/show/fallback_720p.mp4')).toBe(false);

    const single = parseMpd(
      mpd(
        `<AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1"><BaseURL>rep-0.mp4</BaseURL>
          <SegmentList timescale="1" duration="4"><Initialization range="0-99"/><SegmentURL mediaRange="100-199"/><SegmentURL mediaRange="200-299"/></SegmentList>
        </Representation></AdaptationSet>`,
      ),
      URL_,
    ).video[0]!;
    expect(single.fold).toEqual(['https://cdn.example/show/rep-0.mp4']);
  });

  it('converts inclusive DASH ranges to length and offset', () => {
    expect(dashRange('0-835')).toEqual({ offset: 0, length: 836 });
    expect(dashRange('10-10')).toEqual({ offset: 10, length: 1 });
    expect(dashRange('9-3')).toBeUndefined();
    expect(dashRange('abc')).toBeUndefined();
  });
});

describe('fold rules', () => {
  const DIR = 'https://cdn.example/videos/123/';
  const template = (media: string) =>
    parseMpd(
      `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S"><Period>
        <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="4" media="${media}" initialization="init-$RepresentationID$.mp4"/>
        <Representation id="v" bandwidth="1"/></AdaptationSet>
      </Period></MPD>`,
      `${DIR}manifest.mpd`,
    ).video[0]!;

  it('keeps what follows the last placeholder, so a template in the MPD folder does not fold its other files', () => {
    const rep = template('seg_$Number$.m4s');
    expect(rep.fold).toEqual([`${DIR}init-v.mp4`, `${DIR}seg_*.m4s`]);
    expect(folded(rep, `${DIR}seg_1.m4s`)).toBe(true);
    expect(folded(rep, `${DIR}fallback_720p.mp4`)).toBe(false);
  });

  it('keeps the rule for seg_$Number$.m4s under a representation folder', () => {
    const rep = template('$RepresentationID$/seg_$Number$.m4s');
    expect(rep.fold).toEqual([`${DIR}init-v.mp4`, `${DIR}v/seg_*.m4s`]);
    expect(folded(rep, `${DIR}v/seg_7.m4s`)).toBe(true);
  });

  it('drops a rule that would cover the whole MPD folder', () => {
    // No suffix and no prefix past the folder: every file beside the MPD would match. The init still folds.
    expect(template('$Number$').fold).toEqual([`${DIR}init-v.mp4`]);
    expect(foldRule(DIR, '', DIR)).toBeNull();
    expect(foldRule('https://cdn.example/videos/', '', DIR)).toBeNull();
    expect(foldRule(`${DIR}seg-`, '', DIR)).toBe(`${DIR}seg-*`);
    expect(foldRule('https://media.example/v/', '', DIR)).toBe('https://media.example/v/*');
  });

  it('drops a rule whose suffix is only an extension and whose prefix stops at the MPD folder, a parent, or an origin root', () => {
    // *.mp4 beside the MPD would fold a progressive fallback too, so the init URL alone is listed.
    expect(template('$Number$.mp4').fold).toEqual([`${DIR}init-v.mp4`]);
    expect(template('$Number$.m4s').fold).toEqual([`${DIR}init-v.mp4`]);
    expect(foldRule(DIR, '.m4s', DIR)).toBeNull();
    expect(foldRule('https://cdn.example/videos/', '.mp4', DIR)).toBeNull();
    expect(foldRule('https://media.example/', '.mp4', DIR)).toBeNull();
    expect(foldRule('https://media.ex', '.mp4', DIR)).toBeNull();
    // Past the folder, or with more than an extension, the rule names this representation's files only.
    expect(foldRule(`${DIR}v/`, '.m4s', DIR)).toBe(`${DIR}v/*.m4s`);
    expect(foldRule('https://media.example/v/', '.mp4', DIR)).toBe('https://media.example/v/*.mp4');
    expect(foldRule(DIR, '_720p.m4s', DIR)).toBe(`${DIR}*_720p.m4s`);
  });

  it('drops the rule of a SegmentList whose URLs sit in two directories', () => {
    const list = (a: string, b: string) =>
      parseMpd(
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S"><Period>
          <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1">
            <SegmentList timescale="1" duration="4"><Initialization sourceURL="https://media.example/v/init.mp4"/><SegmentURL media="${a}"/><SegmentURL media="${b}"/></SegmentList>
          </Representation></AdaptationSet>
        </Period></MPD>`,
        `${DIR}manifest.mpd`,
      ).video[0]!;
    // The common prefix is the origin root: https://cdn.example/*.mp4.
    expect(list('https://cdn.example/a/1.mp4', 'https://cdn.example/b/2.mp4').fold).toEqual(['https://media.example/v/init.mp4']);
    // Below the root but across folders: https://media.example/v/*.mp4 would take every MP4 under /v/.
    expect(list('https://media.example/v/a/seg1.mp4', 'https://media.example/v/b/seg2.mp4').fold).toEqual(['https://media.example/v/init.mp4']);
    expect(listRule(['https://media.example/v/a/seg1.mp4', 'https://media.example/v/b/seg2.mp4'], DIR)).toBeNull();
    // One folder keeps its rule.
    expect(list('https://media.example/v/seg1.mp4', 'https://media.example/v/seg2.mp4').fold).toEqual(['https://media.example/v/init.mp4', 'https://media.example/v/seg*.mp4']);
  });

  it('never lets a list rule match a URL twice over, and keeps one URL as is', () => {
    expect(listRule(['https://a.example/x/ab', 'https://a.example/x/aab'], DIR)).toBe('https://a.example/x/a*b');
    expect(listRule(['https://a.example/x/one.mp4', 'https://a.example/x/one.mp4'], DIR)).toBe('https://a.example/x/one.mp4');
    expect(listRule([], DIR)).toBeNull();
  });
});

describe('parseMpd: structure', () => {
  it('resolves BaseURL at every level, first of several, relative to the parent level', () => {
    const text = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
      <BaseURL>https://cdn1.example/content/</BaseURL>
      <BaseURL>https://cdn2.example/content/</BaseURL>
      <Period>
        <BaseURL>period1/</BaseURL>
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <BaseURL>video/</BaseURL>
          <SegmentTemplate timescale="1" duration="2" media="seg-$Number$.m4s" initialization="init.mp4"/>
          <Representation id="a" bandwidth="3"><BaseURL>720/</BaseURL></Representation>
          <Representation id="b" bandwidth="2"><BaseURL>../alt/360/</BaseURL></Representation>
          <Representation id="c" bandwidth="1"><BaseURL>https://other.example/abs/</BaseURL></Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const m = parseMpd(text, URL_);
    expect(m.video.map((r) => uris(r)[0])).toEqual([
      'https://cdn1.example/content/period1/video/720/seg-1.m4s',
      'https://cdn1.example/content/period1/alt/360/seg-1.m4s',
      'https://other.example/abs/seg-1.m4s',
    ]);
    expect(m.video[0]!.media!.segments[0]!.map?.uri).toBe('https://cdn1.example/content/period1/video/720/init.mp4');
    // Without any BaseURL, everything resolves against the manifest.
    expect(uris(parseMpd(mpd(videoSet()), URL_).video[0])[0]).toBe('https://cdn.example/show/v/1.m4s');
  });

  it('picks the longest Period: a 15 s preroll and a 20 minute main', () => {
    const period = (attrs: string, seg: number, path: string) =>
      `<Period ${attrs}><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="${seg}" media="${path}/$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet>
       <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2"><SegmentTemplate timescale="1" duration="${seg}" media="${path}/a$Number$.m4s"/><Representation id="a" bandwidth="1"/></AdaptationSet></Period>`;
    const text = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20M15S">
      ${period('id="ad" duration="PT15S"', 5, 'ad')}
      ${period('id="main" start="PT15S"', 4, 'main')}
    </MPD>`;
    const m = parseMpd(text, URL_);
    expect(m).toMatchObject({ periodCount: 2, periodIndex: 1, periodId: 'main', periodStart: 15, periodDuration: 1200, duration: 1215 });
    expect(m.video[0]!.media!.segments).toHaveLength(300);
    expect(m.video[0]!.media!.segments[0]!.start).toBe(0);
    expect(uris(m.video[0])[0]).toBe('https://cdn.example/show/main/1.m4s');
    expect(m.notes.join(' ')).toMatch(/Period 2 of 2/);
  });

  it('skips a Period and a set that load through xlink', () => {
    const text = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink" type="static" mediaPresentationDuration="PT30S">
      <Period xlink:href="https://ads.example/period.xml" xlink:actuate="onLoad" duration="PT10S"/>
      <Period start="PT10S">${videoSet()}<AdaptationSet xlink:href="https://ads.example/set.xml"/></Period>
    </MPD>`;
    const m = parseMpd(text, URL_);
    expect(m.periodIndex).toBe(1);
    expect(m.periodCount).toBe(2);
    expect(m.video).toHaveLength(1);
    expect(m.notes.filter((n) => /xlink/.test(n))).toHaveLength(2);
  });

  it('marks encryption from ContentProtection on the set or the representation', () => {
    const m = parseMpd(
      mpd(
        videoSet('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>') +
          `<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">${TEMPLATE}<Representation id="a1" bandwidth="1"/><Representation id="a2" bandwidth="2"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/></Representation></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video[0]!.encrypted).toBe(true);
    expect(m.audio.map((r) => r.encrypted)).toEqual([false, true]);
  });

  it('treats a CA_descriptor EssentialProperty as DRM on the set or the representation, not as an unknown scheme', () => {
    const ca = '<EssentialProperty schemeIdUri="urn:mpeg:dash:13818:1:CA_descriptor:2011" value="0x4AE0"/>';
    const m = parseMpd(
      mpd(
        videoSet(ca) +
          `<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">${TEMPLATE}<Representation id="a1" bandwidth="1"/><Representation id="a2" bandwidth="2">${ca}</Representation></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video.map((r) => r.encrypted)).toEqual([true]);
    expect(m.audio.map((r) => r.encrypted)).toEqual([false, true]);
    expect(m.notes).toEqual([]);
  });

  it('drops trick mode and unknown EssentialProperty sets, keeps known schemes and SupplementalProperty', () => {
    const m = parseMpd(
      mpd(
        videoSet() +
          `<AdaptationSet contentType="video" mimeType="video/mp4"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/>${TEMPLATE}<Representation id="trick" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet contentType="video" mimeType="video/mp4"><EssentialProperty schemeIdUri="urn:example:mystery" value="1"/>${TEMPLATE}<Representation id="mystery" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet contentType="video" mimeType="video/mp4"><EssentialProperty schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="16"/><SupplementalProperty schemeIdUri="urn:example:whatever"/>${TEMPLATE}<Representation id="hdr" bandwidth="2"/></AdaptationSet>` +
          `<AdaptationSet contentType="text" mimeType="application/ttml+xml" lang="en"><EssentialProperty schemeIdUri="urn:example:text"/><Representation id="sub" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet contentType="image" mimeType="image/jpeg"><EssentialProperty schemeIdUri="http://dashif.org/thumbnail_tile" value="10x1"/><Representation id="thumbs" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet mimeType="application/mp4" codecs="stpp"><Representation id="stpp" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet><Representation id="wvtt" mimeType="application/mp4" codecs="wvtt" bandwidth="1"/></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video.map((r) => r.id).sort()).toEqual(['hdr', 'v']);
    expect(m.audio).toEqual([]);
    expect(m.notes).toHaveLength(2);
    expect(m.notes.join(' ')).toMatch(/trick mode/);
    expect(m.notes.join(' ')).toMatch(/urn:example:mystery/);
  });

  it('filters WebM representations with a note', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet contentType="video">${TEMPLATE}<Representation id="vp9" mimeType="video/webm" codecs="vp9" bandwidth="2"/><Representation id="h264" mimeType="video/mp4" codecs="avc1.4d401f" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet mimeType="audio/webm" codecs="opus">${TEMPLATE}<Representation id="opus" bandwidth="1"/></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video.map((r) => r.id)).toEqual(['h264']);
    expect(m.audio).toEqual([]);
    expect(m.notes).toEqual(['Skipped 2 WebM representations; WebM DASH is not supported.']);
  });

  it('marks a muxed representation only when the MPD has no audio set', () => {
    const muxed = `<AdaptationSet mimeType="video/mp4">${TEMPLATE}<Representation id="mux" codecs="avc1.4d401f,mp4a.40.2" bandwidth="1"/></AdaptationSet>`;
    const alone = parseMpd(mpd(muxed), URL_);
    expect(alone.video[0]).toMatchObject({ id: 'mux', type: 'video', muxed: true });
    expect(alone.audio).toEqual([]);
    const withAudio = parseMpd(mpd(muxed + audioSet()), URL_);
    expect(withAudio.video[0]!.muxed).toBeUndefined();
  });

  it('parses an audio only MPD', () => {
    const m = parseMpd(mpd(audioSet('', 'lang="en"')), URL_);
    expect(m.video).toEqual([]);
    expect(m.audio).toHaveLength(1);
    expect(chooseAudio(m)?.id).toBe('a');
    expect(videoLabel(m.audio[0]!)).toBe('English · 128 kbps · mp4a.40.2');
  });

  it('classifies sets by Representation mimeType or codecs when the set says nothing', () => {
    const m = parseMpd(
      mpd(
        `<AdaptationSet>${TEMPLATE}<Representation id="v" mimeType="video/mp4" codecs="avc1.4d401f" bandwidth="1"/></AdaptationSet>` +
          `<AdaptationSet>${TEMPLATE}<Representation id="a" codecs="mp4a.40.2" bandwidth="1"/></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.video.map((r) => r.id)).toEqual(['v']);
    expect(m.audio.map((r) => [r.id, r.mimeType])).toEqual([['a', 'audio/mp4']]);
  });

  it('trusts audio only codecs over a video/mp4 mimeType, and takes main from several Roles', () => {
    const m = parseMpd(
      mpd(
        videoSet() +
          `<AdaptationSet mimeType="video/mp4" codecs="mp4a.40.2"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="alternate"/><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>${TEMPLATE}<Representation id="aac" bandwidth="1"/></AdaptationSet>`,
      ),
      URL_,
    );
    expect(m.audio.map((r) => [r.id, r.type, r.role])).toEqual([['aac', 'audio', 'main']]);
  });

  it('walks prefixed elements by localName', () => {
    const text = `<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">
      <mpd:Period><mpd:AdaptationSet contentType="video" mimeType="video/mp4">
        <mpd:SegmentTemplate timescale="1" duration="4" media="$Number$.m4s"/>
        <mpd:Representation id="v" bandwidth="1"/>
      </mpd:AdaptationSet></mpd:Period>
    </mpd:MPD>`;
    expect(parseMpd(text, URL_).video[0]!.media!.segments).toHaveLength(2);
  });

  it('throws on XML that does not parse, or a root that is not MPD', () => {
    expect(() => parseMpd('<MPD><Period></MPD>', URL_)).toThrow(/not well formed/);
    expect(() => parseMpd('#EXTM3U\n', URL_)).toThrow(/not well formed/);
    expect(() => parseMpd('<html><body/></html>', URL_)).toThrow(/root element is not MPD/);
    expect(() => parseMpd('<MPD type="static"/>', URL_)).toThrow(/no Period/);
  });
});

describe('chooseAudio', () => {
  const rep = (id: string, setIndex: number, codecs: string, bandwidth: number, extra: Partial<DashRepresentation> = {}): DashRepresentation => ({
    id,
    type: 'audio',
    mimeType: 'audio/mp4',
    codecs,
    bandwidth,
    encrypted: false,
    setIndex,
    fold: [],
    ...extra,
  });
  const manifest = (audio: DashRepresentation[]) => ({ audio }) as DashManifest;

  it('prefers the set with Role main over the first set', () => {
    expect(chooseAudio(manifest([rep('dub', 0, 'mp4a.40.2', 128000, { role: 'dub', lang: 'de' }), rep('orig', 1, 'mp4a.40.2', 96000, { role: 'main', lang: 'en' })]))?.id).toBe('orig');
  });

  it('takes the first set when none is main', () => {
    expect(chooseAudio(manifest([rep('first', 0, 'mp4a.40.2', 64000, { lang: 'en' }), rep('second', 1, 'mp4a.40.2', 192000, { lang: 'fr' })]))?.id).toBe('first');
  });

  it('within a set prefers mp4a, then the highest bandwidth', () => {
    const set = [rep('ec3', 0, 'ec-3', 640000), rep('aac-lo', 0, 'mp4a.40.5', 64000), rep('aac-hi', 0, 'mp4a.40.2', 192000), rep('opus', 0, 'opus', 256000)];
    expect(chooseAudio(manifest(set))?.id).toBe('aac-hi');
  });

  it('moves to an mp4a set of the same language and role when the chosen set has none', () => {
    const audio = [rep('ec3', 0, 'ec-3', 640000, { role: 'main', lang: 'en' }), rep('aac-fr', 1, 'mp4a.40.2', 128000, { role: 'main', lang: 'fr' }), rep('aac-en', 2, 'mp4a.40.2', 128000, { role: 'main', lang: 'en' })];
    expect(chooseAudio(manifest(audio))?.id).toBe('aac-en');
    expect(chooseAudio(manifest([rep('ec3', 0, 'ec-3', 640000, { lang: 'en' }), rep('aac-fr', 1, 'mp4a.40.2', 128000, { lang: 'fr' })]))?.id).toBe('ec3');
  });

  it('returns undefined without audio', () => {
    expect(chooseAudio(manifest([]))).toBeUndefined();
  });
});

describe('parseMpd: dynamic', () => {
  const AST = '2026-10-27T10:00:00Z';
  const astSec = Date.parse(AST) / 1000;
  const live = (tsbd: string) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${AST}" publishTime="2026-10-27T10:01:40Z"
     minimumUpdatePeriod="PT2S" ${tsbd} suggestedPresentationDelay="PT6S" minBufferTime="PT4S">
  <Period id="p0" start="PT10S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" duration="180000" startNumber="100" media="v/$Number$-$Time$.m4s" initialization="v/init.mp4"/>
      <Representation id="v" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://time.example/now"/>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="2026-10-27T10:01:50Z"/>
</MPD>`;

  it('parses the timing and lists the $Number$ segments available now', () => {
    // 110.5 s after availabilityStartTime is 100.5 s into the Period: segments 0 to 49 are complete,
    // and the 30 s time shift buffer keeps those that ended after 70.5 s, from index 35.
    const m = parseMpd(live('timeShiftBufferDepth="PT30S"'), URL_, (astSec + 110.5) * 1000);
    expect(m.type).toBe('dynamic');
    expect(m.duration).toBeUndefined();
    expect(m.live).toEqual({
      availabilityStartTime: astSec,
      publishTime: astSec + 100,
      minimumUpdatePeriod: 2,
      timeShiftBufferDepth: 30,
      suggestedPresentationDelay: 6,
      minBufferTime: 4,
      periodStart: 10,
      utcTiming: [
        { schemeIdUri: 'urn:mpeg:dash:utc:http-xsdate:2014', value: 'https://time.example/now' },
        { schemeIdUri: 'urn:mpeg:dash:utc:direct:2014', value: '2026-10-27T10:01:50Z' },
      ],
    });
    const pl = m.video[0]!.media!;
    expect(pl.endList).toBe(false);
    expect(pl.segments).toHaveLength(15);
    expect(pl.mediaSequence).toBe(135);
    expect(pl.segments[0]).toMatchObject({ sequence: 135, start: 70, duration: 2, uri: 'https://cdn.example/show/v/135-6300000.m4s' });
    expect(pl.segments[14]).toMatchObject({ sequence: 149, start: 98 });

    const later = availableRange(m.video[0]!, m.live, astSec + 120.5);
    expect([later.first, later.last]).toEqual([140, 154]);
    expect(later.media.endList).toBe(false);
    const early = availableRange(m.video[0]!, m.live, astSec + 5);
    expect(early.media.segments).toEqual([]);
    expect(early.last).toBeLessThan(early.first);
  });

  it('caps the window at an hour when the MPD has no timeShiftBufferDepth', () => {
    const m = parseMpd(live(''), URL_, (astSec + 86400) * 1000);
    const segs = m.video[0]!.media!.segments;
    expect(segs).toHaveLength(1800);
    expect(segs[segs.length - 1]!.start + 2).toBeLessThanOrEqual(86400 - 10);
  });

  it('records the Period that has started, not one announced for later', () => {
    const text = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${AST}">
      <Period id="a" start="PT0S">${videoSet()}</Period>
      <Period id="b" start="PT100S">${videoSet()}</Period>
      <Period id="c" start="PT1000S">${videoSet()}</Period>
    </MPD>`;
    const m = parseMpd(text, URL_, (astSec + 200) * 1000);
    expect(m.periodId).toBe('b');
    expect(m.live?.periodStart).toBe(100);
    expect(m.notes.join(' ')).toMatch(/Period 2 of 3/);
  });

  it('emits a live SegmentTimeline as listed, with exact $Time$ past 2^53, and r = -1 up to now', () => {
    const t0 = '17616000000000003';
    const text = (timeline: string) => `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT4S" timeShiftBufferDepth="PT1M">
      <Period id="1" start="PT0S">
        <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
          <SegmentTemplate timescale="10000000" media="a-$Time$.m4s" initialization="a-init.mp4"><SegmentTimeline>${timeline}</SegmentTimeline></SegmentTemplate>
          <Representation id="a" bandwidth="128000"/>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const now = (1761600000 + 10.5) * 1000;
    const listed = parseMpd(text(`<S t="${t0}" d="20000000" r="2"/>`), URL_, now);
    expect(uris(listed.audio[0]).map((u) => u.split('/').pop())).toEqual(['a-17616000000000003.m4s', 'a-17616000020000003.m4s', 'a-17616000040000003.m4s']);
    expect(listed.audio[0]!.media!.endList).toBe(false);
    expect(listed.audio[0]!.media!.segments[1]!.duration).toBe(2);

    const open = parseMpd(text(`<S t="${t0}" d="20000000" r="-1"/>`), URL_, now);
    expect(open.audio[0]!.media!.segments).toHaveLength(5);
    expect(availableRange(open.audio[0]!, open.live, 1761600000 + 20.5).media.segments).toHaveLength(10);
  });
});

describe('ISO 8601', () => {
  it('parses durations', () => {
    expect(isoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(isoDuration('PT20S')).toBe(20);
    expect(isoDuration('PT20.0S')).toBe(20);
    expect(isoDuration('PT0S')).toBe(0);
    expect(isoDuration('P1DT2H')).toBe(93600);
    expect(isoDuration('P1D')).toBe(86400);
    expect(isoDuration('PT0.5S')).toBe(0.5);
    expect(isoDuration('P0Y0M0DT0H0M10.000S')).toBe(10);
    expect(isoDuration('PT1M30S')).toBe(90);
    expect(isoDuration(' PT4S ')).toBe(4);
    expect(isoDuration('P')).toBeUndefined();
    expect(isoDuration('PT')).toBeUndefined();
    expect(isoDuration('P1DT')).toBeUndefined();
    expect(isoDuration('20')).toBeUndefined();
    expect(isoDuration(undefined)).toBeUndefined();
  });

  it('parses dates as epoch seconds, a time without a zone as UTC', () => {
    expect(isoDate('1970-01-01T00:01:00Z')).toBe(60);
    expect(isoDate('1970-01-01T00:01:00')).toBe(60);
    expect(isoDate('1970-01-01T01:00:00+01:00')).toBe(0);
    expect(isoDate('1970-01-01T00:00:01.2345678Z')).toBeCloseTo(1.234, 6);
    expect(isoDate('not a date')).toBeUndefined();
  });

  it('reads UTCTiming answers', () => {
    expect(utcTimingTime({ schemeIdUri: 'urn:mpeg:dash:utc:http-xsdate:2014', value: 'https://t' }, '1970-01-01T00:00:10Z')).toBe(10);
    expect(utcTimingTime({ schemeIdUri: 'urn:mpeg:dash:utc:http-iso:2014', value: 'https://t' }, '1970-01-01T00:00:10.500Z\n')).toBe(10.5);
    expect(utcTimingTime({ schemeIdUri: 'urn:mpeg:dash:utc:direct:2014', value: '1970-01-01T00:00:20Z' })).toBe(20);
    expect(utcTimingTime({ schemeIdUri: 'urn:mpeg:dash:utc:http-head:2014', value: 'https://t' }, 'Thu, 01 Jan 1970 00:00:30 GMT')).toBe(30);
    expect(utcTimingTime({ schemeIdUri: 'urn:mpeg:dash:utc:ntp:2014', value: 'pool.ntp.org' })).toBeUndefined();
  });
});

describe('HLS segment start', () => {
  it('is the running EXTINF sum, the same field DASH fills', () => {
    const p = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\na.ts\n#EXTINF:3.5,\nb.ts\n#EXTINF:2,\nc.ts\n#EXT-X-ENDLIST', 'https://a/x.m3u8');
    if (p.kind !== 'media') throw new Error('expected a media playlist');
    expect(p.segments.map((s) => s.start)).toEqual([0, 4, 7.5]);
  });
});
