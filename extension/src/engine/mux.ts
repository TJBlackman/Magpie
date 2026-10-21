import muxjs from 'mux.js';

/**
 * Sink that turns ordered segments into one playable file:
 *  - fmp4: write the init segment once, then every segment as is
 *  - ts: run through mux.js, which repackages MPEG-TS into fragmented MP4
 */
export interface Sink {
  push(segment: Uint8Array, init: Uint8Array | null): Promise<void>;
  flush(): Promise<void>;
  /** The init segment written at offset 0, or null when the file does not start with one. */
  readonly firstInit: Uint8Array | null;
}

export type Write = (chunk: Uint8Array) => Promise<void>;

export function passthroughSink(write: Write): Sink {
  let wroteInit: Uint8Array | null = null;
  let wroteAny = false;
  let firstInit: Uint8Array | null = null;
  const timeline = new Timeline();
  return {
    async push(segment, init) {
      const fresh = init && init !== wroteInit ? init : null;
      if (fresh) timeline.learn(fresh);
      const data = timeline.rebase(segment);
      if (fresh) {
        const fixed = timeline.fixInit(fresh);
        if (!wroteAny) firstInit = fixed;
        await write(fixed);
        wroteInit = fresh;
      }
      wroteAny = true;
      await write(data);
    },
    async flush() {},
    get firstInit() {
      return firstInit;
    },
  };
}

/**
 * Moves fMP4 fragments so the file starts at 0. A live stream's fragments carry
 * the time since the stream started, often hours, and players would show that
 * as the start of the file and disagree with its duration. All tracks shift by
 * the same number of seconds, so audio stays in sync with video.
 */
export class Timeline {
  private timescales = new Map<number, number>();
  private shift = new Map<number, bigint>();
  private startSec: number | null = null;

  /** Read each track's timescale from an init segment (moov > trak > tkhd, mdia > mdhd). */
  learn(init: Uint8Array): void {
    const dv = view(init);
    for (const moov of boxes(init, 0, init.byteLength, 'moov')) {
      for (const trak of boxes(init, moov.body, moov.end, 'trak')) {
        let track = -1;
        let timescale = 0;
        for (const tkhd of boxes(init, trak.body, trak.end, 'tkhd')) track = dv.getUint32(tkhd.body + (init[tkhd.body] === 1 ? 20 : 12));
        for (const mdia of boxes(init, trak.body, trak.end, 'mdia')) {
          for (const mdhd of boxes(init, mdia.body, mdia.end, 'mdhd')) timescale = dv.getUint32(mdhd.body + (init[mdhd.body] === 1 ? 20 : 12));
        }
        if (track >= 0 && timescale > 0) this.timescales.set(track, timescale);
      }
    }
  }

  /**
   * A copy of `init` without the start delay that every track shares. An
   * encoder that offsets a stream puts that offset in a leading empty edit
   * (elst entry with media_time -1) on each track, so the file would play from
   * hours in. Removing the part common to all tracks keeps any difference
   * between them, which is what aligns audio with video.
   */
  fixInit(init: Uint8Array): Uint8Array {
    const out = init.slice();
    const dv = view(out);
    let tracks = 0;
    const leads: { at: number; v1: boolean; duration: bigint }[] = [];
    for (const moov of boxes(out, 0, out.byteLength, 'moov')) {
      for (const trak of boxes(out, moov.body, moov.end, 'trak')) {
        tracks++;
        for (const edts of boxes(out, trak.body, trak.end, 'edts')) {
          for (const elst of boxes(out, edts.body, edts.end, 'elst')) {
            const v1 = out[elst.body] === 1;
            const at = elst.body + 8;
            if (dv.getUint32(elst.body + 4) === 0 || at + (v1 ? 20 : 12) > elst.end) continue;
            const mediaTime = v1 ? dv.getBigInt64(at + 8) : BigInt(dv.getInt32(at + 4));
            if (mediaTime === -1n) leads.push({ at, v1, duration: v1 ? dv.getBigUint64(at) : BigInt(dv.getUint32(at)) });
          }
        }
      }
    }
    if (!tracks || leads.length < tracks) return init;
    const common = leads.reduce((m, l) => (l.duration < m ? l.duration : m), leads[0]!.duration);
    if (common === 0n) return init;
    for (const l of leads) {
      if (l.v1) dv.setBigUint64(l.at, l.duration - common);
      else dv.setUint32(l.at, Number(l.duration - common));
    }
    return out;
  }

  /**
   * Rewrite every tfdt in `data` in place and return it. Also turns sidx boxes
   * into free boxes: their times are the stream's, and an index per segment in
   * the middle of a joined file only misleads players.
   */
  rebase(data: Uint8Array): Uint8Array {
    const dv = view(data);
    for (const sidx of boxes(data, 0, data.byteLength, 'sidx')) data.set([0x66, 0x72, 0x65, 0x65], sidx.start + 4);
    const tfdts: { track: number; at: number; v1: boolean; time: bigint }[] = [];
    for (const moof of boxes(data, 0, data.byteLength, 'moof')) {
      for (const traf of boxes(data, moof.body, moof.end, 'traf')) {
        let track = -1;
        for (const tfhd of boxes(data, traf.body, traf.end, 'tfhd')) track = dv.getUint32(tfhd.body + 4);
        for (const tfdt of boxes(data, traf.body, traf.end, 'tfdt')) {
          const v1 = data[tfdt.body] === 1;
          const time = v1 ? dv.getBigUint64(tfdt.body + 4) : BigInt(dv.getUint32(tfdt.body + 4));
          if (track >= 0) tfdts.push({ track, at: tfdt.body + 4, v1, time });
        }
      }
    }
    // The earliest start among the tracks first seen here, in seconds, becomes 0.
    const fresh = tfdts.filter((t) => !this.shift.has(t.track));
    for (const t of fresh) {
      const ts = this.timescales.get(t.track);
      if (ts) this.startSec = Math.min(this.startSec ?? Infinity, Number(t.time) / ts);
    }
    for (const t of fresh) {
      const ts = this.timescales.get(t.track);
      if (!this.shift.has(t.track)) this.shift.set(t.track, ts && this.startSec !== null ? BigInt(Math.floor(this.startSec * ts)) : t.time);
    }
    for (const t of tfdts) {
      let time = t.time - this.shift.get(t.track)!;
      if (time < 0n) time = 0n;
      if (t.v1) dv.setBigUint64(t.at, time);
      else dv.setUint32(t.at, Number(time));
    }
    return data;
  }
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Child boxes of `type` between start and end: where each box and its body begin, and where it ends. */
function* boxes(data: Uint8Array, start: number, end: number, type: string): Generator<{ start: number; body: number; end: number }> {
  const dv = view(data);
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(dv.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    if (String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!) === type) yield { start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

/**
 * @param durationSec total playlist duration; mux.js writes "unknown"
 * (0xFFFFFFFF) into mvhd/tkhd/mdhd, which players show as a 24 hour file.
 * 0 when not known yet (live); the caller patches the init at the end.
 */
export function tsSink(write: Write, durationSec: number): Sink {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  let firstInit: Uint8Array | null = null;
  let pending: Uint8Array[] = [];
  transmuxer.on('data', (seg) => {
    if (!firstInit) {
      firstInit = patchDurations(seg.initSegment, durationSec);
      pending.push(firstInit);
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
    get firstInit() {
      return firstInit;
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
