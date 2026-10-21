import muxjs from 'mux.js';

/**
 * Sink that turns ordered segments into one playable file:
 *  - fmp4: write the init segment once, then every segment as is
 *  - ts: run through mux.js, which repackages MPEG-TS into fragmented MP4
 */
export interface Sink {
  push(segment: Uint8Array, init: Uint8Array | null): Promise<void>;
  flush(): Promise<void>;
}

export type Write = (chunk: Uint8Array) => Promise<void>;

export function passthroughSink(write: Write): Sink {
  let wroteInit: Uint8Array | null = null;
  return {
    async push(segment, init) {
      if (init && init !== wroteInit) {
        await write(init);
        wroteInit = init;
      }
      await write(segment);
    },
    async flush() {},
  };
}

/**
 * @param durationSec total playlist duration; mux.js writes "unknown"
 * (0xFFFFFFFF) into mvhd/tkhd/mdhd, which players show as a 24 hour file.
 */
export function tsSink(write: Write, durationSec: number): Sink {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  let wroteInit = false;
  let pending: Uint8Array[] = [];
  transmuxer.on('data', (seg) => {
    if (!wroteInit) {
      pending.push(patchDurations(seg.initSegment, durationSec));
      wroteInit = true;
    }
    pending.push(seg.data);
  });
  return {
    async push(segment) {
      transmuxer.push(segment);
      transmuxer.flush();
      const out = pending;
      pending = [];
      for (const chunk of out) await write(chunk);
    },
    async flush() {
      transmuxer.flush();
      const out = pending;
      pending = [];
      for (const chunk of out) await write(chunk);
    },
  };
}

export function sniffContainer(first: Uint8Array): 'ts' | 'fmp4' | 'unknown' {
  if (first.byteLength > 188 && first[0] === 0x47 && first[188] === 0x47) return 'ts';
  if (first.byteLength > 8) {
    const box = String.fromCharCode(first[4]!, first[5]!, first[6]!, first[7]!);
    if (['ftyp', 'moof', 'styp', 'moov', 'sidx', 'free'].includes(box)) return 'fmp4';
  }
  return 'unknown';
}

/**
 * Walk an init segment and set version 0 mvhd / tkhd / mdhd durations from
 * `durationSec` and each box's own timescale. Returns a patched copy.
 */
export function patchDurations(init: Uint8Array, durationSec: number): Uint8Array {
  if (!(durationSec > 0)) return init;
  const out = init.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let movieTimescale = 0;
  const setDur = (offset: number, timescale: number) => {
    if (!timescale) return;
    dv.setUint32(offset, Math.min(0xfffffffe, Math.round(durationSec * timescale)));
  };
  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      const size = dv.getUint32(pos);
      const type = String.fromCharCode(out[pos + 4]!, out[pos + 5]!, out[pos + 6]!, out[pos + 7]!);
      if (size < 8) break;
      const boxEnd = Math.min(end, pos + size);
      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        walk(pos + 8, boxEnd);
      } else if (type === 'mvhd' && out[pos + 8] === 0) {
        movieTimescale = dv.getUint32(pos + 20);
        setDur(pos + 24, movieTimescale);
      } else if (type === 'tkhd' && out[pos + 8] === 0) {
        setDur(pos + 28, movieTimescale);
      } else if (type === 'mdhd' && out[pos + 8] === 0) {
        setDur(pos + 24, dv.getUint32(pos + 20));
      }
      pos = boxEnd;
    }
  };
  walk(0, out.byteLength);
  return out;
}
