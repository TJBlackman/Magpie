import { describe, expect, it } from 'vitest';
import { patchDurations } from './mux';

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
