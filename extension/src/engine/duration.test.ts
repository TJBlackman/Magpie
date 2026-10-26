import { describe, expect, it } from 'vitest';
import { mp4Duration } from './duration';

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function mvhd(version: 0 | 1, timescale: number, duration: number | 'ones'): Uint8Array {
  const body = new Uint8Array(version ? 108 : 96);
  const v = new DataView(body.buffer);
  v.setUint8(0, version);
  if (version) {
    v.setUint32(20, timescale);
    if (duration === 'ones') v.setBigUint64(24, 0xffffffffffffffffn);
    else v.setBigUint64(24, BigInt(duration));
  } else {
    v.setUint32(12, timescale);
    v.setUint32(16, duration === 'ones' ? 0xffffffff : duration);
  }
  return box('mvhd', body);
}

const concat = (...parts: Uint8Array[]) => new Blob(parts as unknown as BlobPart[]);
const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isomiso2'));
const mdat = box('mdat', new Uint8Array(5000));
const moov = (h: Uint8Array) => box('moov', h);

describe('mp4Duration', () => {
  it('reads mvhd v0 with moov after mdat', async () => {
    expect(await mp4Duration(concat(ftyp, mdat, moov(mvhd(0, 1000, 20_000))))).toBe(20);
  });
  it('reads mvhd v1 with moov first', async () => {
    expect(await mp4Duration(concat(ftyp, moov(mvhd(1, 90_000, 90_000 * 3725)), mdat))).toBe(3725);
  });
  it('reads past a 64 bit mdat size', async () => {
    const big = new Uint8Array(16 + 100);
    const v = new DataView(big.buffer);
    v.setUint32(0, 1);
    big.set([0x6d, 0x64, 0x61, 0x74], 4);
    v.setUint32(8, 0);
    v.setUint32(12, big.length);
    expect(await mp4Duration(concat(ftyp, big, moov(mvhd(0, 600, 1200))))).toBe(2);
  });
  it('is unknown for a zero or all ones duration', async () => {
    expect(await mp4Duration(concat(ftyp, moov(mvhd(0, 1000, 0))))).toBeUndefined();
    expect(await mp4Duration(concat(ftyp, moov(mvhd(0, 1000, 'ones'))))).toBeUndefined();
    expect(await mp4Duration(concat(ftyp, moov(mvhd(1, 1000, 'ones'))))).toBeUndefined();
  });
  it('is unknown for WebM, truncated and empty files', async () => {
    expect(await mp4Duration(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0x1f])]))).toBeUndefined();
    expect(await mp4Duration(concat(ftyp, mdat.slice(0, 100)))).toBeUndefined();
    expect(await mp4Duration(new Blob([]))).toBeUndefined();
  });
});
