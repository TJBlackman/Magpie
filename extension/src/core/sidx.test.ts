import { describe, expect, it } from 'vitest';
import type { DashRepresentation } from './dash';
import { parseSidx, segmentsFromSidx } from './sidx';

/** Builds a sidx box. Each reference is [reference_type, referenced_size, subsegment_duration]. */
function sidx(version: 0 | 1, timescale: number, ept: number, firstOffset: number, refs: [number, number, number][]): Uint8Array {
  const size = 8 + 4 + 4 + 4 + (version === 0 ? 8 : 16) + 4 + refs.length * 12;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size);
  out.set([0x73, 0x69, 0x64, 0x78], 4); // "sidx"
  v.setUint8(8, version);
  v.setUint32(12, 1); // reference_ID
  v.setUint32(16, timescale);
  let p = 20;
  if (version === 0) {
    v.setUint32(p, ept);
    v.setUint32(p + 4, firstOffset);
    p += 8;
  } else {
    v.setBigUint64(p, BigInt(ept));
    v.setBigUint64(p + 8, BigInt(firstOffset));
    p += 16;
  }
  v.setUint16(p + 2, refs.length);
  p += 4;
  for (const [type, refSize, duration] of refs) {
    v.setUint32(p, ((type << 31) | refSize) >>> 0);
    v.setUint32(p + 4, duration);
    v.setUint32(p + 8, 0x90000000); // starts_with_SAP, SAP type 1
    p += 12;
  }
  return out;
}

function box(type: string, payload = 0): Uint8Array {
  const out = new Uint8Array(8 + payload);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
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

const rep = (segmentBase: DashRepresentation['segmentBase']): DashRepresentation => ({
  id: 'v',
  type: 'video',
  mimeType: 'video/mp4',
  encrypted: false,
  setIndex: 0,
  fold: [],
  segmentBase,
});

describe('parseSidx', () => {
  it('reads a version 0 box: offsets start at the box end plus first_offset', () => {
    const bytes = sidx(0, 15360, 0, 0, [
      [0, 1000, 61440],
      [0, 2000, 61440],
      [0, 500, 30720],
    ]);
    expect(bytes.length).toBe(68);
    const s = parseSidx(bytes, 836);
    expect(s.timescale).toBe(15360);
    expect(s.earliestPresentationTime).toBe(0);
    expect(s.entries).toEqual([
      { offset: 904, size: 1000, duration: 61440 },
      { offset: 1904, size: 2000, duration: 61440 },
      { offset: 3904, size: 500, duration: 30720 },
    ]);
  });

  it('reads a version 1 box with 64 bit times and a first_offset', () => {
    const s = parseSidx(sidx(1, 48000, 2 ** 40, 16, [[0, 700, 192000]]), 100);
    expect(s.earliestPresentationTime).toBe(2 ** 40);
    // 100 + 52 byte box + 16.
    expect(s.entries).toEqual([{ offset: 168, size: 700, duration: 192000 }]);
  });

  it('skips boxes before the sidx and counts them in the offsets', () => {
    const s = parseSidx(concat(box('free', 8), sidx(0, 1000, 0, 0, [[0, 10, 1000]])), 50);
    expect(s.entries[0]!.offset).toBe(50 + 16 + 44);
  });

  it('refuses a hierarchical sidx, a cut off box and bytes without a sidx', () => {
    expect(() => parseSidx(sidx(0, 1000, 0, 0, [[1, 100, 1000]]), 0)).toThrow(/hierarchical/);
    expect(() => parseSidx(sidx(0, 1000, 0, 0, [[0, 100, 1000]]).subarray(0, 40), 0)).toThrow(/cut off/);
    expect(() => parseSidx(box('moov', 4), 0)).toThrow(/no sidx/);
  });
});

describe('segmentsFromSidx', () => {
  const index = sidx(0, 15360, 1536, 0, [
    [0, 1000, 61440],
    [0, 2000, 61440],
  ]);

  it('makes byte range segments against the one file, with the init range as map', () => {
    const r = rep({ url: 'https://cdn/v.mp4', initRange: { offset: 0, length: 836 }, indexRange: { offset: 836, length: index.length }, presentationTimeOffset: 0.1 });
    const pl = segmentsFromSidx(r, index, 836);
    expect(pl).toMatchObject({ kind: 'media', endList: true, container: 'fmp4', targetDuration: 4, totalDuration: 8, mediaSequence: 1 });
    expect(pl.segments.map((s) => [s.uri, s.byteRange, s.start, s.duration, s.sequence])).toEqual([
      ['https://cdn/v.mp4', { offset: 892, length: 1000 }, 0, 4, 1],
      ['https://cdn/v.mp4', { offset: 1892, length: 2000 }, 4, 4, 2],
    ]);
    expect(pl.segments[0]!.map).toEqual({ uri: 'https://cdn/v.mp4', byteRange: { offset: 0, length: 836 } });
    expect(pl.segments.every((s) => s.key.method === 'NONE' && !s.discontinuity)).toBe(true);
  });

  it('takes everything before the sidx as the init when the MPD gives no Initialization range', () => {
    const r = rep({ url: 'https://cdn/v.mp4', indexRange: { offset: 836, length: index.length }, presentationTimeOffset: 0 });
    expect(segmentsFromSidx(r, index, 836).segments[0]!.map?.byteRange).toEqual({ offset: 0, length: 836 });
    expect(() => segmentsFromSidx(r, index, 0)).toThrow(/init/);
  });

  it('refuses a Representation without SegmentBase', () => {
    expect(() => segmentsFromSidx(rep(undefined), index, 0)).toThrow(/SegmentBase/);
  });
});
