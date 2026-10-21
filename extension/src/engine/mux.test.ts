import { describe, expect, it } from 'vitest';
import { patchDurations, Timeline } from './mux';

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
}
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
