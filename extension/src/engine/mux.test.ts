import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { box, boxes, joinInits, mergeSink, patchDurations, placeFragment, renumberTrack, renumberTracks, startOf, Timeline, trackHandlers, trackTimescales, tsSink, tsTrackProducer, type Box } from './mux';
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function u32(...vals: number[]): Uint8Array {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
}

describe('patchDurations', () => {
  it('rewrites mvhd, tkhd and mdhd durations using their timescales', () => {
    // mvhd v0: vflags, creation, modification, timescale=1000, duration=unknown
    const mvhd = box('mvhd', u32(0, 0, 0, 1000, 0xffffffff, 0, 0));
    // tkhd v0: vflags, creation, modification, trackId, reserved, duration
    const tkhd = box('tkhd', u32(0, 0, 0, 1, 0, 0xffffffff, 0));
    // mdhd v0: vflags, creation, modification, timescale=90000, duration
    const mdhd = box('mdhd', u32(0, 0, 0, 90000, 0xffffffff, 0));
    const init = concat(box('ftyp', u32(0)), box('moov', concat(mvhd, box('trak', concat(tkhd, box('mdia', mdhd))))));
    const patched = patchDurations(init, 20.5);
    const dv = new DataView(patched.buffer);
    const moov = 12; // after the 12 byte ftyp box
    expect(dv.getUint32(moov + 8 + 24)).toBe(20500); // mvhd duration
    const trak = moov + 8 + mvhd.length;
    expect(dv.getUint32(trak + 8 + 28)).toBe(20500); // tkhd duration (movie timescale)
    const mdia = trak + 8 + tkhd.length;
    expect(dv.getUint32(mdia + 8 + 24)).toBe(1845000); // mdhd duration (90k)
    expect(init[12 + 8 + 24]).toBe(0xff); // original untouched
  });
});

describe('Timeline', () => {
  // Video at 90 kHz (track 1) and audio at 48 kHz (track 2), as a live init declares them.
  const trak = (id: number, timescale: number) =>
    box('trak', concat(box('tkhd', u32(0, 0, 0, id, 0, 0)), box('mdia', box('mdhd', u32(0, 0, 0, timescale, 0, 0)))));
  const init = box('moov', concat(trak(1, 90000), trak(2, 48000)));
  // tfdt v1 carries a 64 bit time; v0 a 32 bit one.
  const tfdt64 = (t: number) => box('tfdt', concat(u32(0x01000000), u32(Math.floor(t / 2 ** 32), t % 2 ** 32)));
  const traf = (id: number, tfdt: Uint8Array) => box('traf', concat(box('tfhd', u32(0, id)), tfdt));
  const fragment = (v: number, a: number) => concat(box('moof', concat(traf(1, tfdt64(v)), traf(2, tfdt64(a)))), box('mdat', u32(0)));
  const times = (data: Uint8Array) => {
    const dv = new DataView(data.buffer);
    // moof(8) traf(8) tfhd(16) tfdt(8 + 4) -> time at 44; each traf is 44 bytes long.
    return [Number(dv.getBigUint64(44)), Number(dv.getBigUint64(44 + 44))];
  };

  it('starts the file at 0 and moves every track by the same seconds', () => {
    const t = new Timeline();
    t.learn(init);
    // Two hours into the stream; audio starts 0.02 s after video.
    const first = t.rebase(fragment(7200 * 90000, 7200 * 48000 + 960));
    expect(times(first)).toEqual([0, 960]);
    const next = t.rebase(fragment(7204 * 90000, 7204 * 48000 + 960));
    expect(times(next)).toEqual([4 * 90000, 4 * 48000 + 960]);
  });

  it('carries on from the given seconds after a restart, whichever way the clock jumped', () => {
    const t = new Timeline();
    t.learn(init);
    t.rebase(fragment(7200 * 90000, 7200 * 48000));
    // Back to a clock near 60 s, as a stitched ad's is, with the audio 0.02 s after the video.
    t.restart(4);
    expect(times(t.rebase(fragment(60 * 90000, 60 * 48000 + 960)))).toEqual([4 * 90000, 4 * 48000 + 960]);
    expect(times(t.rebase(fragment(64 * 90000, 64 * 48000 + 960)))).toEqual([8 * 90000, 8 * 48000 + 960]);
    // Then hours ahead again.
    t.restart(12);
    expect(times(t.rebase(fragment(7300 * 90000, 7300 * 48000)))).toEqual([12 * 90000, 12 * 48000]);
  });

  // trak with a 2 entry elst v0: an empty edit of `delay` (movie timescale 1000), then the media from 0.
  const delayed = (id: number, delay: number) =>
    box('trak', concat(box('tkhd', u32(0, 0, 0, id, 0, 0)), box('edts', box('elst', u32(0, 2, delay, 0xffffffff, 0x00010000, 20000, 0, 0x00010000)))));
  const plain = (id: number) => box('trak', box('tkhd', u32(0, 0, 0, id, 0, 0)));
  const delays = (init: Uint8Array) => {
    const dv = new DataView(init.buffer);
    const out: number[] = [];
    // The first elst entry sits 64 bytes into each delayed trak; traks follow the 8 byte moov header.
    for (let pos = 8; pos < init.length; pos += dv.getUint32(pos)) if (dv.getUint32(pos) > 40) out.push(dv.getUint32(pos + 64));
    return out;
  };

  it('removes the start delay every track shares and keeps their difference', () => {
    const init = box('moov', concat(delayed(1, 7200000), delayed(2, 7199978)));
    expect(delays(new Timeline().fixInit(init))).toEqual([22, 0]);
  });

  it('keeps a delay that only some tracks have', () => {
    const init = box('moov', concat(delayed(1, 21), plain(2)));
    expect(new Timeline().fixInit(init)).toBe(init);
  });

  it('turns sidx boxes into free boxes', () => {
    const t = new Timeline();
    const out = t.rebase(concat(box('sidx', u32(0)), fragment(0, 0)));
    expect(String.fromCharCode(...out.subarray(4, 8))).toBe('free');
  });

  it('leaves a file that already starts at 0 alone', () => {
    const t = new Timeline();
    t.learn(init);
    expect(times(t.rebase(fragment(0, 0)))).toEqual([0, 0]);
    expect(times(t.rebase(fragment(4 * 90000, 4 * 48000)))).toEqual([4 * 90000, 4 * 48000]);
  });
});

// Helpers for the merge tests: full boxes with version 0 or 1 fields, and a walker.
function u64(...vals: (number | bigint)[]): Uint8Array {
  const out = new Uint8Array(vals.length * 8);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setBigUint64(i * 8, BigInt.asUintN(64, BigInt(v))));
  return out;
}
const pad = (n: number) => new Uint8Array(n);
const vflags = (version: number, flags = 0) => u32(((version << 24) | flags) >>> 0);

/** mvhd: timescale and next_track_ID, the rest zero. Version 0 body is 100 bytes, version 1 is 112. */
function mvhd(version: 0 | 1, timescale: number, next: number): Uint8Array {
  const times = version ? concat(u64(0, 0), u32(timescale), u64(0)) : u32(0, 0, timescale, 0);
  return box('mvhd', vflags(version), times, pad(76), u32(next));
}
/** tkhd: track id and duration in the movie timescale. Version 0 body is 84 bytes, version 1 is 96. */
function tkhd(version: 0 | 1, id: number, duration: number | bigint): Uint8Array {
  const head = version ? concat(u64(0, 0), u32(id, 0), u64(duration)) : u32(0, 0, id, 0, Number(duration));
  return box('tkhd', vflags(version, 3), head, pad(60));
}
function mdhd(version: 0 | 1, timescale: number): Uint8Array {
  return box('mdhd', vflags(version), version ? concat(u64(0, 0), u32(timescale), u64(0)) : u32(0, 0, timescale, 0), pad(4));
}
/** elst entries as [segment_duration, media_time]. */
function elst(version: 0 | 1, entries: [number | bigint, number][]): Uint8Array {
  const rows = entries.map(([d, t]) => (version ? concat(u64(d, t), u32(0x00010000)) : concat(u32(Number(d)), u32(t >>> 0), u32(0x00010000))));
  return box('elst', vflags(version), u32(entries.length), ...rows);
}
function trak(version: 0 | 1, id: number, timescale: number, duration: number | bigint, edits: [number | bigint, number][]): Uint8Array {
  return box('trak', tkhd(version, id, duration), box('edts', elst(version, edits)), box('mdia', mdhd(version, timescale), box('hdlr', u32(0, 0))));
}
const trex = (id: number) => box('trex', u32(0, id, 1, 0, 0, 0));
const ftyp = box('ftyp', new TextEncoder().encode('iso5\0\0\0\x01iso5'));

/** Boxes at a slash separated path, e.g. 'moov/trak/tkhd'. */
function at(data: Uint8Array, path: string, start = 0, end = data.byteLength): Box[] {
  const [head, ...rest] = path.split('/');
  const found = [...boxes(data, start, end, head)];
  return rest.length ? found.flatMap((b) => at(data, rest.join('/'), b.body, b.end)) : found;
}
const types = (data: Uint8Array, b: Box) => [...boxes(data, b.body, b.end)].map((c) => c.type);
const dvOf = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const tkhdIds = (data: Uint8Array) => at(data, 'moov/trak/tkhd').map((b) => dvOf(data).getUint32(b.body + (data[b.body] === 1 ? 20 : 12)));
const trexIds = (data: Uint8Array) => at(data, 'moov/mvex/trex').map((b) => dvOf(data).getUint32(b.body + 4));
const nextTrackId = (data: Uint8Array) => dvOf(data).getUint32(at(data, 'moov/mvhd')[0]!.end - 4);
/** Each trak's edit list entries as [segment_duration, media_time] strings. */
const edits = (data: Uint8Array) =>
  at(data, 'moov/trak/edts/elst').map((b) => {
    const dv = dvOf(data);
    const v1 = data[b.body] === 1;
    return Array.from({ length: dv.getUint32(b.body + 4) }, (_, i) => {
      const e = b.body + 8 + i * (v1 ? 20 : 12);
      return v1 ? `${dv.getBigUint64(e)}/${dv.getBigInt64(e + 8)}` : `${dv.getUint32(e)}/${dv.getInt32(e + 4)}`;
    });
  });

const containers = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl', 'dinf', 'mvex', 'moof', 'traf']);
/** Every container's children fill it exactly, all the way down. */
function sizesAddUp(data: Uint8Array, start = 0, end = data.byteLength): boolean {
  let pos = start;
  for (const b of boxes(data, start, end)) {
    if (b.start !== pos) return false;
    if (containers.has(b.type) && !sizesAddUp(data, b.body, b.end)) return false;
    pos = b.end;
  }
  return pos === end;
}

describe('box', () => {
  it('writes the size of the header and every child', () => {
    const b = box('moov', box('mvhd', u32(1, 2)), box('udta'));
    expect(b.byteLength).toBe(8 + 16 + 8);
    expect(sizesAddUp(b)).toBe(true);
    expect(types(b, at(b, 'moov')[0]!)).toEqual(['mvhd', 'udta']);
  });
});

describe('joinInits', () => {
  // Video: two tracks in a 90 kHz movie timescale (mux.js style), mehd and udta present.
  const video = concat(
    ftyp,
    box(
      'moov',
      mvhd(0, 90000, 3),
      trak(0, 1, 90000, 0, [[1890, -1], [0, 0]]),
      trak(0, 2, 90000, 0, [[0, 0]]),
      box('mvex', box('mehd', u32(0, 1800000)), trex(1), trex(2)),
      box('udta', u32(7)),
    ),
  );

  it('appends the audio trak with the next free id and rebuilds every size', () => {
    // Audio in a 1000 Hz movie timescale (ffmpeg style): a 21 ms lead, 20 s long.
    const audio = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 48000, 20000, [[21, -1], [0, 0]]), box('mvex', trex(1))));
    const joined = joinInits(video, audio);
    const init = joined.init;
    expect(joined.audioTrackId).toBe(3);
    expect(joined.videoTrackIds).toEqual([1, 2]);
    expect(sizesAddUp(init)).toBe(true);
    expect(init.subarray(0, ftyp.byteLength)).toEqual(ftyp);
    expect(types(init, at(init, 'moov')[0]!)).toEqual(['mvhd', 'trak', 'trak', 'trak', 'mvex', 'udta']);
    expect(types(init, at(init, 'moov/mvex')[0]!)).toEqual(['mehd', 'trex', 'trex', 'trex']);
    expect(tkhdIds(init)).toEqual([1, 2, 3]);
    expect(trexIds(init)).toEqual([1, 2, 3]);
    expect(nextTrackId(init)).toBe(4);
    // The audio lead stays 21 ms, now counted at 90 kHz; the video traks are untouched.
    expect(edits(init)).toEqual([['1890/-1', '0/0'], ['0/0'], ['1890/-1', '0/0']]);
    const audioTkhd = at(init, 'moov/trak/tkhd')[2]!;
    expect(dvOf(init).getUint32(audioTkhd.body + 20)).toBe(1800000);
    expect(trackTimescales(init)).toEqual(
      new Map([
        [1, 90000],
        [2, 90000],
        [3, 48000],
      ]),
    );
  });

  it('handles version 1 boxes and an audio track numbered 0', () => {
    // A mux.js AAC init numbers its track 0. Here in a version 1 moov at 1000 Hz.
    const v1video = concat(ftyp, box('moov', mvhd(1, 90000, 2), trak(1, 1, 15360, 0, [[1890, -1]]), box('mvex', trex(1))));
    const audio = concat(ftyp, box('moov', mvhd(1, 1000, 1), trak(1, 0, 48000, 5000, [[21, -1], [0, 1024]]), box('mvex', trex(0))));
    const { init, audioTrackId } = joinInits(v1video, audio);
    expect(audioTrackId).toBe(2);
    expect(sizesAddUp(init)).toBe(true);
    expect(tkhdIds(init)).toEqual([1, 2]);
    expect(trexIds(init)).toEqual([1, 2]);
    expect(nextTrackId(init)).toBe(3);
    expect(edits(init)).toEqual([['1890/-1'], ['1890/-1', '0/1024']]);
    const audioTkhd = at(init, 'moov/trak/tkhd')[1]!;
    expect(dvOf(init).getBigUint64(audioTkhd.body + 28)).toBe(450000n);
  });

  it('widens a version 0 edit list whose durations outgrow 32 bits', () => {
    // A 100000 s lead at 1 Hz is 9e9 at 90 kHz.
    const audio = concat(ftyp, box('moov', mvhd(0, 1, 2), trak(0, 1, 48000, 100000, [[100000, -1], [0, 0]]), box('mvex', trex(1))));
    const { init } = joinInits(video, audio);
    expect(sizesAddUp(init)).toBe(true);
    const audioElst = at(init, 'moov/trak/edts/elst')[2]!;
    expect(init[audioElst.body]).toBe(1);
    expect(edits(init)[2]).toEqual(['9000000000/-1', '0/0']);
    // A version 0 tkhd duration that no longer fits becomes unknown for patchDurations to fill.
    const audioTkhd = at(init, 'moov/trak/tkhd')[2]!;
    expect(dvOf(init).getUint32(audioTkhd.body + 20)).toBe(0xffffffff);
  });

  it('adds a trex when the audio init has none', () => {
    const audio = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 48000, 0, [[0, 0]])));
    const { init } = joinInits(video, audio);
    expect(trexIds(init)).toEqual([1, 2, 3]);
    expect(sizesAddUp(init)).toBe(true);
  });

  it('refuses an init without a moov', () => {
    expect(() => joinInits(ftyp, video)).toThrow(/video init/);
    expect(() => joinInits(video, ftyp)).toThrow(/audio init/);
  });

  // Shaped like a mux.js init: mvhd at 90 kHz with next_track_ID all ones, a
  // trak without edts whose tkhd duration is unknown, and an mvex without mehd.
  const muxjsInit = (id: number, timescale: number, duration = 0xffffffff) =>
    concat(ftyp, box('moov', mvhd(0, 90000, 0xffffffff), box('trak', tkhd(0, id, duration), box('mdia', mdhd(0, timescale), box('hdlr', u32(0, 0)))), box('mvex', trex(id))));

  it('joins two mux.js inits whose tracks are both PID 256', () => {
    const joined = joinInits(muxjsInit(256, 90000), muxjsInit(256, 48000));
    const init = joined.init;
    expect(joined.videoTrackIds).toEqual([256]);
    expect(joined.audioTrackId).toBe(257);
    expect(sizesAddUp(init)).toBe(true);
    expect(types(init, at(init, 'moov')[0]!)).toEqual(['mvhd', 'trak', 'trak', 'mvex']);
    expect(types(init, at(init, 'moov/mvex')[0]!)).toEqual(['trex', 'trex']);
    expect(tkhdIds(init)).toEqual([256, 257]);
    expect(trexIds(init)).toEqual([256, 257]);
    expect(nextTrackId(init)).toBe(258);
    expect(edits(init)).toEqual([]);
    // Unknown stays unknown for patchDurations to fill.
    expect(dvOf(init).getUint32(at(init, 'moov/trak/tkhd')[1]!.body + 20)).toBe(0xffffffff);
    expect(trackTimescales(init)).toEqual(
      new Map([
        [256, 90000],
        [257, 48000],
      ]),
    );
    const patched = patchDurations(init, 20);
    expect(dvOf(patched).getUint32(at(patched, 'moov/trak/tkhd')[1]!.body + 20)).toBe(1800000);
  });

  it('joins a mux.js ADTS init, track 0 at 90 kHz, to an ffmpeg video at 1000 Hz', () => {
    const ffmpegVideo = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 15360, 20000, [[21, -1], [0, 0]]), box('mvex', trex(1))));
    const { init, audioTrackId } = joinInits(ffmpegVideo, muxjsInit(0, 48000, 1800000));
    expect(audioTrackId).toBe(2);
    expect(sizesAddUp(init)).toBe(true);
    expect(tkhdIds(init)).toEqual([1, 2]);
    expect(trexIds(init)).toEqual([1, 2]);
    expect(nextTrackId(init)).toBe(3);
    expect(edits(init)).toEqual([['21/-1', '0/0']]);
    // 20 s at 90 kHz becomes 20 s at 1000 Hz.
    expect(dvOf(init).getUint32(at(init, 'moov/trak/tkhd')[1]!.body + 20)).toBe(20000);
  });

  it('joins an ffmpeg audio at 1000 Hz to a mux.js video at 90 kHz', () => {
    const ffmpegAudio = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 48000, 20000, [[21, -1], [0, 0]]), box('mvex', trex(1))));
    const { init, audioTrackId } = joinInits(muxjsInit(256, 90000), ffmpegAudio);
    expect(audioTrackId).toBe(257);
    expect(sizesAddUp(init)).toBe(true);
    expect(tkhdIds(init)).toEqual([256, 257]);
    expect(trexIds(init)).toEqual([256, 257]);
    expect(edits(init)).toEqual([['1890/-1', '0/0']]);
    expect(dvOf(init).getUint32(at(init, 'moov/trak/tkhd')[1]!.body + 20)).toBe(1800000);
  });
});

describe('fragment rewrites', () => {
  /** A moof with one traf: tfhd with the given flags (and a base_data_offset when 0x1 is set) and a version 1 tfdt. */
  const moof = (seq: number, id: number, flags: number, time: number) =>
    box(
      'moof',
      box('mfhd', u32(0, seq)),
      box('traf', box('tfhd', u32(flags, id), ...(flags & 1 ? [u64(999)] : [])), box('tfdt', vflags(1), u64(time)), box('trun', u32(0, 0))),
    );
  const segment = (...moofs: Uint8Array[]) => concat(box('styp', u32(0)), box('sidx', u32(0)), ...moofs.flatMap((m) => [m, box('mdat', u32(0))]));
  const seqs = (data: Uint8Array) => at(data, 'moof/mfhd').map((b) => dvOf(data).getUint32(b.body + 4));
  const tfhds = (data: Uint8Array) => at(data, 'moof/traf/tfhd');

  it('renumbers the track of every traf', () => {
    const data = segment(moof(1, 1, 0x20000, 0), moof(2, 0, 0x20000, 0));
    expect(renumberTrack(data, 5)).toBe(data);
    expect(tfhds(data).map((b) => dvOf(data).getUint32(b.body + 4))).toEqual([5, 5]);
  });

  it('renumbers only the tracks a map names', () => {
    const data = segment(moof(1, 481, 0x20000, 0), moof(2, 482, 0x20000, 0), moof(3, 7, 0x20000, 0));
    expect(renumberTracks(data, new Map([[481, 256], [482, 257]]))).toBe(data);
    expect(tfhds(data).map((b) => dvOf(data).getUint32(b.body + 4))).toEqual([256, 257, 7]);
  });

  it('reads each track id and handler type from an init', () => {
    const hdlr = (type: string) => box('hdlr', u32(0, 0), new TextEncoder().encode(type), pad(13));
    const init = box('moov', trak(0, 256, 90000, 0, []), box('trak', tkhd(1, 257, 0), box('mdia', mdhd(0, 48000), hdlr('soun'))), box('trak', tkhd(0, 3, 0), box('mdia', mdhd(0, 1000), hdlr('vide'))));
    // The first trak's hdlr names no type (the merge test builders leave it zero), so it is left out.
    expect(trackHandlers(init)).toEqual(new Map([[257, 'soun'], [3, 'vide']]));
  });

  it('numbers moofs from the running count and points base_data_offset at the moof', () => {
    const data = segment(moof(1, 1, 0x1, 0), moof(1, 1, 0x20000, 0));
    expect(placeFragment(data, 7, 5000)).toBe(9);
    expect(seqs(data)).toEqual([7, 8]);
    const [first, second] = tfhds(data);
    const firstMoof = at(data, 'moof')[0]!;
    expect(dvOf(data).getBigUint64(first!.body + 8)).toBe(BigInt(5000 + firstMoof.start));
    // Without flag 0x1 the tfhd has no base_data_offset and stays 8 bytes of body.
    expect(second!.end - second!.body).toBe(8);
  });

  it('reads the first tfdt in seconds', () => {
    expect(startOf(segment(moof(1, 1, 0, 4 * 48000), moof(2, 1, 0, 5 * 48000)), 48000)).toBe(4);
    const v0 = box('moof', box('traf', box('tfhd', u32(0, 1)), box('tfdt', u32(0, 9000))));
    expect(startOf(v0, 90000)).toBe(0.1);
    expect(startOf(box('styp', u32(0)), 90000)).toBeNull();
  });
});

describe('Timeline.anchor', () => {
  const init = box('moov', trak(0, 1, 90000, 0, []), trak(0, 2, 48000, 0, []));
  const one = (id: number, time: number) => box('moof', box('traf', box('tfhd', u32(0, id)), box('tfdt', vflags(1), u64(time))));
  const raw = (data: Uint8Array) => startOf(data, 1);

  it('shifts both tracks by the anchored seconds when the later track starts earlier', () => {
    // Video starts at 10 s and arrives first, audio starts half a second earlier.
    const t = new Timeline();
    t.learn(init);
    t.anchor(9.5);
    expect(raw(t.rebase(one(1, 10 * 90000)))).toBe(45000);
    expect(raw(t.rebase(one(2, 9.5 * 48000)))).toBe(0);
  });

  it('loses that half second without an anchor', () => {
    const t = new Timeline();
    t.learn(init);
    expect(raw(t.rebase(one(1, 10 * 90000)))).toBe(0);
    expect(raw(t.rebase(one(2, 9.5 * 48000)))).toBe(0);
  });
});

describe('mergeSink', () => {
  const vInit = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 90000, 0, [[21, -1], [0, 0]]), box('mvex', trex(1))));
  const aInit = concat(ftyp, box('moov', mvhd(0, 1000, 2), trak(0, 1, 48000, 0, [[0, 0]]), box('mvex', trex(1))));
  /** styp, sidx, then a moof with an explicit base_data_offset, a v1 tfdt at `time` and an mdat. */
  const fragment = (time: number) =>
    concat(
      box('styp', u32(0)),
      box('sidx', u32(0)),
      box('moof', box('mfhd', u32(0, 1)), box('traf', box('tfhd', u32(0x1, 1), u64(0)), box('tfdt', vflags(1), u64(time)))),
      box('mdat', u32(0)),
    );

  it('writes the joined init once, then each fragment renumbered, placed and rebased', async () => {
    const out: Uint8Array[] = [];
    const sink = mergeSink(async (c) => {
      out.push(c.slice());
    }, 20);
    await sink.setInits(vInit, aInit);
    expect(out).toHaveLength(1);
    expect(sink.firstInit).toEqual(out[0]);
    expect(tkhdIds(out[0]!)).toEqual([1, 2]);
    expect(dvOf(out[0]!).getUint32(at(out[0]!, 'moov/mvhd')[0]!.body + 16)).toBe(20000);

    const v1 = fragment(3600 * 90000);
    const a1 = fragment(3599.5 * 48000);
    const v2 = fragment(3604 * 90000);
    expect(sink.startOf('video', v1)).toBe(3600);
    expect(sink.startOf('audio', a1)).toBe(3599.5);
    sink.anchor(Math.min(sink.startOf('video', v1)!, sink.startOf('audio', a1)!));
    await sink.push('video', v1);
    await sink.push('audio', a1);
    await sink.push('video', v2);
    await sink.flush();

    let offset = out[0]!.byteLength;
    const expected = [
      { seq: 1, id: 1, time: 45000 },
      { seq: 2, id: 2, time: 0 },
      { seq: 3, id: 1, time: 4 * 90000 + 45000 },
    ];
    expected.forEach((want, i) => {
      const data = out[i + 1]!;
      const tfhd = at(data, 'moof/traf/tfhd')[0]!;
      expect(dvOf(data).getUint32(at(data, 'moof/mfhd')[0]!.body + 4)).toBe(want.seq);
      expect(dvOf(data).getUint32(tfhd.body + 4)).toBe(want.id);
      expect(dvOf(data).getBigUint64(tfhd.body + 8)).toBe(BigInt(offset + at(data, 'moof')[0]!.start));
      expect(startOf(data, 1)).toBe(want.time);
      expect(at(data, 'sidx')).toHaveLength(0);
      offset += data.byteLength;
    });
  });

  it('refuses fragments before the inits and a second pair of inits', async () => {
    const sink = mergeSink(async () => {}, 0);
    await expect(sink.push('video', fragment(0))).rejects.toThrow(/init/);
    await sink.setInits(vInit, aInit);
    await expect(sink.setInits(vInit, aInit)).rejects.toThrow(/init/);
  });
});

// The real fixtures from testsite/fixtures/gen.sh, when they exist (pnpm fixtures; gitignored).
const media = fileURLToPath(new URL('../../../testsite/public/media/', import.meta.url));
const read = (path: string) => new Uint8Array(readFileSync(join(media, path)));

describe.skipIf(!existsSync(join(media, 'hls-altaudio')) || !existsSync(join(media, 'dash')))('merge of the fixture renditions', () => {
  const cases = [
    { name: 'hls altaudio', video: 'hls-altaudio/video/init_1.mp4', audio: 'hls-altaudio/audio/init_0.mp4', edits: [['21/-1', '0/0'], ['0/0']] },
    { name: 'dash 720p', video: 'dash/init-0.m4s', audio: 'dash/init-2.m4s', edits: [['0/0'], ['0/1024']] },
    { name: 'dash 360p', video: 'dash/init-1.m4s', audio: 'dash/init-2.m4s', edits: [['0/0'], ['0/1024']] },
  ];

  it.each(cases)('$name: joins the inits into two tracks', ({ video, audio, edits: want }) => {
    const v = read(video);
    const joined = joinInits(v, read(audio));
    const init = joined.init;
    expect(joined.audioTrackId).toBe(2);
    expect(joined.videoTrackIds).toEqual([1]);
    expect(sizesAddUp(init)).toBe(true);
    expect(tkhdIds(init)).toEqual([1, 2]);
    expect(trexIds(init)).toEqual([1, 2]);
    expect(nextTrackId(init)).toBe(3);
    expect(types(init, at(init, 'moov')[0]!)).toEqual(['mvhd', 'trak', 'trak', 'mvex', 'udta']);
    expect(edits(init)).toEqual(want);
    expect(trackTimescales(init)).toEqual(
      new Map([
        [1, 15360],
        [2, 48000],
      ]),
    );
    const ftypBox = at(v, 'ftyp')[0]!;
    expect(init.subarray(0, ftypBox.end)).toEqual(v.subarray(0, ftypBox.end));
  });

  it('hls altaudio: merges every segment with one sequence and the audio on track 2', async () => {
    const dir = (side: string) => readdirSync(join(media, 'hls-altaudio', side)).filter((f) => /^seg\d+\.m4s$/.test(f)).sort();
    const video = dir('video').map((f) => read(`hls-altaudio/video/${f}`));
    const audio = dir('audio').map((f) => read(`hls-altaudio/audio/${f}`));
    const inBytes = [...video, ...audio].reduce((n, s) => n + s.byteLength, 0);
    const out: Uint8Array[] = [];
    const sink = mergeSink(async (c) => {
      out.push(c);
    }, 20);
    await sink.setInits(read('hls-altaudio/video/init_1.mp4'), read('hls-altaudio/audio/init_0.mp4'));
    sink.anchor(Math.min(sink.startOf('video', video[0]!)!, sink.startOf('audio', audio[0]!)!));
    for (let i = 0; i < audio.length; i++) {
      if (video[i]) await sink.push('video', video[i]!);
      await sink.push('audio', audio[i]!);
    }
    const file = concat(...out);
    expect(file.byteLength).toBe(out[0]!.byteLength + inBytes);
    expect(at(file, 'sidx')).toHaveLength(0);
    const tracks = at(file, 'moof/traf/tfhd').map((b) => dvOf(file).getUint32(b.body + 4));
    expect(tracks).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2]);
    expect(at(file, 'moof/mfhd').map((b) => dvOf(file).getUint32(b.body + 4))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(startOf(out[1]!, 1)).toBe(0);
    expect(startOf(out[2]!, 1)).toBe(0);
  });
});

describe.skipIf(!existsSync(join(media, 'hls-altaudio-ts')) || !existsSync(join(media, 'hls-ts')))('tsTrackProducer on the fixture TS', () => {
  const segments = (dir: string) =>
    readdirSync(join(media, dir))
      .filter((f) => /^seg\d+\.ts$/.test(f))
      .sort()
      .map((f) => read(`${dir}/${f}`));
  const samples = (data: Uint8Array) => at(data, 'moof/traf/trun').reduce((n, b) => n + dvOf(data).getUint32(b.body + 4), 0);
  const tfhdIds = (data: Uint8Array) => at(data, 'moof/traf/tfhd').map((b) => dvOf(data).getUint32(b.body + 4));
  const handlers = (init: Uint8Array) => at(init, 'moov/trak/mdia/hdlr').map((b) => String.fromCharCode(...init.subarray(b.body + 8, b.body + 12)));
  const mvhdBox = (init: Uint8Array) => at(init, 'moov/mvhd')[0]!;

  /** Every segment through one producer: the inits it handed out and all fragments, flush included. */
  async function run(side: 'video' | 'audio', dir: string, durationSec = 0) {
    const producer = tsTrackProducer(side, durationSec);
    const inits: (Uint8Array | null)[] = [];
    const fragments: Uint8Array[][] = [];
    for (const segment of segments(dir)) {
      const out = await producer.push(segment);
      inits.push(out.init);
      fragments.push(out.fragments);
    }
    const last = await producer.flush();
    return { inits, fragments, last };
  }

  it('video: one init, one fragment per segment on the source 90 kHz clock, every frame', async () => {
    const { inits, fragments, last } = await run('video', 'hls-altaudio-ts/video');
    expect(inits.map((i) => i !== null)).toEqual([true, false, false, false, false]);
    expect(last).toEqual({ init: null, fragments: [] });
    const init = inits[0]!;
    expect(sizesAddUp(init)).toBe(true);
    expect(types(init, at(init, 'moov')[0]!)).toEqual(['mvhd', 'trak', 'mvex']);
    expect(types(init, at(init, 'moov/mvex')[0]!)).toEqual(['trex']);
    expect(at(init, 'moov/trak/edts')).toHaveLength(0);
    expect(handlers(init)).toEqual(['vide']);
    expect(dvOf(init).getUint32(mvhdBox(init).body + 12)).toBe(90000);
    expect(nextTrackId(init)).toBe(0xffffffff);
    expect(trackTimescales(init)).toEqual(new Map([[256, 90000]]));
    expect(fragments.map((f) => f.length)).toEqual([1, 1, 1, 1, 1]);
    const all = fragments.flat();
    expect(all.reduce((n, f) => n + samples(f), 0)).toBe(600);
    expect(all.flatMap(tfhdIds)).toEqual([256, 256, 256, 256, 256]);
    // ffmpeg's TS starts video at DTS 127920 (1.4213 s) and each segment is 4 s later.
    expect(all.map((f) => startOf(f, 1))).toEqual([127920, 487920, 847920, 1207920, 1567920]);
  });

  it('audio: every AAC frame, no trim and no silence, with tfdt in samples', async () => {
    const { inits, fragments } = await run('audio', 'hls-altaudio-ts/audio');
    expect(inits.map((i) => i !== null)).toEqual([true, false, false, false, false, false]);
    const init = inits[0]!;
    expect(handlers(init)).toEqual(['soun']);
    expect(at(init, 'moov/trak/edts')).toHaveLength(0);
    expect(dvOf(init).getUint32(mvhdBox(init).body + 12)).toBe(90000);
    expect(trackTimescales(init)).toEqual(new Map([[256, 48000]]));
    const all = fragments.flat();
    const counts = all.map(samples);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(939);
    // The source's first audio DTS is 126000 at 90 kHz, 1.4 s, so 67200 samples.
    // Each fragment starts where the previous one's 1024 sample frames end.
    const starts = all.map((f) => startOf(f, 1)!);
    expect(starts[0]).toBe(67200);
    starts.slice(1).forEach((s, i) => expect(s).toBe(starts[i]! + counts[i]! * 1024));
  });

  it('keeps only the asked track of a TS segment that carries both', async () => {
    const segment = () => read('hls-ts/seg000.ts');
    const video = await tsTrackProducer('video').push(segment());
    const audio = await tsTrackProducer('audio').push(segment());
    expect(handlers(video.init!)).toEqual(['vide']);
    expect(handlers(audio.init!)).toEqual(['soun']);
    expect(video.fragments).toHaveLength(1);
    expect(audio.fragments).toHaveLength(1);
    // The PIDs from the PMT: ffmpeg muxes video at 256 and audio at 257.
    expect(tfhdIds(video.fragments[0]!)).toEqual([256]);
    expect(tfhdIds(audio.fragments[0]!)).toEqual([257]);
    // A segment without the asked track gives nothing at all.
    expect(await tsTrackProducer('audio').push(read('hls-altaudio-ts/video/seg000.ts'))).toEqual({ init: null, fragments: [] });
  });

  it('writes the playlist duration into the init when given', async () => {
    const { init } = await tsTrackProducer('video', 20).push(read('hls-altaudio-ts/video/seg000.ts'));
    expect(dvOf(init!).getUint32(mvhdBox(init!).body + 16)).toBe(1800000);
    expect(dvOf(init!).getUint32(at(init!, 'moov/trak/tkhd')[0]!.body + 20)).toBe(1800000);
    expect(dvOf(init!).getUint32(at(init!, 'moov/trak/mdia/mdhd')[0]!.body + 16)).toBe(1800000);
  });

  it('flushes nothing before the first push', async () => {
    expect(await tsTrackProducer('video').flush()).toEqual({ init: null, fragments: [] });
  });

  it('tsSink carries on at the recorded seconds after a discontinuity, with one init', async () => {
    const out: Uint8Array[] = [];
    const sink = tsSink(async (c) => {
      out.push(c);
    }, 0);
    const first = read('hls-ts/seg000.ts');
    await sink.push(first, null);
    // The video's end, 120 frames at 30 fps, whatever the audio did around it.
    expect(sink.end).toBeCloseTo(4, 5);
    // The same bytes again: on the stream's clock they start where the first push did, 4 s back in the file.
    await sink.discontinuity(4);
    await sink.push(first, null);
    await sink.flush();
    expect(sink.end).toBeCloseTo(8, 5);
    const typeOf = (c: Uint8Array) => String.fromCharCode(...c.subarray(4, 8));
    const inits = out.filter((c) => typeOf(c) === 'ftyp');
    expect(inits).toHaveLength(1);
    expect(trackHandlers(inits[0]!)).toEqual(new Map([[256, 'vide'], [257, 'soun']]));
    const fragments = out.filter((c) => typeOf(c) === 'moof');
    expect(fragments).toHaveLength(2);
    // Each transmuxer numbers its fragments on from the last: one moof per track per segment.
    const sequences = (frag: Uint8Array) => at(frag, 'moof/mfhd').map((b) => dvOf(frag).getUint32(b.body + 4));
    expect(sequences(fragments[0]!)).toEqual([0, 0]);
    expect(sequences(fragments[1]!)).toEqual([1, 1]);
    // Each fragment's tfdt by track: the PIDs ffmpeg gave the streams, 256 video (90 kHz) and 257 audio (48 kHz).
    const starts = (frag: Uint8Array) =>
      Object.fromEntries(
        at(frag, 'moof/traf').map((traf) => [
          dvOf(frag).getUint32(at(frag, 'tfhd', traf.body, traf.end)[0]!.body + 4),
          Number(dvOf(frag).getBigUint64(at(frag, 'tfdt', traf.body, traf.end)[0]!.body + 4)),
        ]),
      );
    const one = starts(fragments[0]!);
    const two = starts(fragments[1]!);
    expect(one[256]).toBe(0);
    expect(one[257]).toBeLessThan(1024);
    expect(two[256]).toBe(4 * 90000);
    // The audio sits where the stream has it against the video: one frame (1024 samples) before, in this fixture.
    expect(Math.abs(two[257]! - 4 * 48000)).toBeLessThanOrEqual(1024);
  });

  it('merges the two producers into tracks 256 and 257 starting 21 ms apart', async () => {
    const video = await run('video', 'hls-altaudio-ts/video', 20);
    const audio = await run('audio', 'hls-altaudio-ts/audio', 20);
    const out: Uint8Array[] = [];
    const sink = mergeSink(async (c) => {
      out.push(c);
    }, 20);
    await sink.setInits(video.inits[0]!, audio.inits[0]!);
    const v = video.fragments.flat();
    const a = audio.fragments.flat();
    sink.anchor(Math.min(sink.startOf('video', v[0]!)!, sink.startOf('audio', a[0]!)!));
    for (let i = 0; i < a.length; i++) {
      if (v[i]) await sink.push('video', v[i]!);
      await sink.push('audio', a[i]!);
    }
    const init = out[0]!;
    expect(tkhdIds(init)).toEqual([256, 257]);
    expect(trexIds(init)).toEqual([256, 257]);
    expect(nextTrackId(init)).toBe(258);
    expect(edits(init)).toEqual([]);
    const file = concat(...out);
    expect(at(file, 'moof/traf/tfhd').map((b) => dvOf(file).getUint32(b.body + 4))).toEqual([256, 257, 256, 257, 256, 257, 256, 257, 256, 257, 257]);
    // Both shift by 1.4 s. Video lands one 90 kHz tick past 1920 because
    // Timeline floors 1.4 * 90000, which is 125999.99999999999 in floating point.
    expect(startOf(out[1]!, 1)).toBe(1921);
    expect(startOf(out[2]!, 1)).toBe(0);
  });
});
