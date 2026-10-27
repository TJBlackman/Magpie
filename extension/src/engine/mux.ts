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
  private anchored = false;

  /** Read each track's timescale from an init segment (moov > trak > tkhd, mdia > mdhd). */
  learn(init: Uint8Array): void {
    for (const [track, timescale] of trackTimescales(init)) this.timescales.set(track, timescale);
  }

  /**
   * Pin the stream time, in seconds, that becomes 0 in the file. Without it the
   * first fragment of each track decides, so a track whose first fragment
   * arrives later but starts earlier would shift by a different number of
   * seconds than the others. A merge calls this with the earlier of its two
   * first fragments before the first rebase.
   */
  anchor(startSec: number): void {
    this.startSec = startSec;
    this.anchored = true;
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
      if (ts && !this.anchored) this.startSec = Math.min(this.startSec ?? Infinity, Number(t.time) / ts);
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

/** Each track's id and media timescale in an init segment (moov > trak > tkhd, mdia > mdhd). */
export function trackTimescales(init: Uint8Array): Map<number, number> {
  const dv = view(init);
  const out = new Map<number, number>();
  for (const moov of boxes(init, 0, init.byteLength, 'moov')) {
    for (const trak of boxes(init, moov.body, moov.end, 'trak')) {
      let track = -1;
      let timescale = 0;
      for (const tkhd of boxes(init, trak.body, trak.end, 'tkhd')) track = dv.getUint32(tkhd.body + (init[tkhd.body] === 1 ? 20 : 12));
      for (const mdia of boxes(init, trak.body, trak.end, 'mdia')) {
        for (const mdhd of boxes(init, mdia.body, mdia.end, 'mdhd')) timescale = dv.getUint32(mdhd.body + (init[mdhd.body] === 1 ? 20 : 12));
      }
      if (track >= 0 && timescale > 0) out.set(track, timescale);
    }
  }
  return out;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

/**
 * Child boxes between start and end, only those of `type` when given: the type,
 * where each box and its body begin, and where it ends.
 */
export function* boxes(data: Uint8Array, start: number, end: number, type?: string): Generator<Box> {
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
    const found = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
    if (type === undefined || found === type) yield { type: found, start: pos, body: pos + header, end: pos + size };
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

/** What a TsTrackProducer made of one pushed segment, or of the final flush. */
export interface TrackOutput {
  /**
   * The track's init segment the first time mux.js builds one, and again only
   * when a later one differs in any byte (a new SPS or PPS, another sample
   * rate). Null otherwise. Durations are patched when the producer knows them.
   */
  init: Uint8Array | null;
  /** The track's moof+mdat pairs, in order. Usually one per segment, none when the segment did not carry the track. */
  fragments: Uint8Array[];
}

/** Turns MPEG-TS segments into one track of fragmented MP4, with an init of its own. See tsTrackProducer. */
export interface TsTrackProducer {
  push(segment: Uint8Array): Promise<TrackOutput>;
  /** Anything mux.js still holds. Call once after the last segment. */
  flush(): Promise<TrackOutput>;
}

/**
 * Repackages the `track` of MPEG-TS segments (or packed ADTS audio) into
 * fragmented MP4 that keeps the source timestamps, so the fragments can be one
 * side of a mergeSink or go through passthroughSink alone. Events for the other
 * track are dropped: a TS video segment that also carries audio gives only the
 * video here.
 *
 * What the mux.js 6.3 source shows about this setup:
 *  - `remux: false` makes CoalesceStream emit each track on its own. Every
 *    VideoSegmentStream or AudioSegmentStream flush pushes one track and then
 *    calls flush, which with remuxTracks off emits right away, so each `data`
 *    event has `type` 'video' or 'audio' (never 'combined'), its own
 *    `initSegment` holding only that track, and `data` holding one moof+mdat.
 *  - `keepOriginalTimestamps: true` skips subtracting the first DTS in
 *    calculateTrackBaseMediaDecodeTime, so tfdt is the segment's smallest DTS
 *    after 33 bit rollover handling: 90 kHz for video, and for audio that value
 *    times samplerate / 90000, floored. The same flag stops the video pipeline
 *    from handing its start to the audio one (setEarliestDts), so no AAC frame
 *    before the first video DTS is trimmed. prefixWithSilence only adds silent
 *    frames after setAudioAppendStart, which nothing here calls.
 *  - Track ids: the TS pipeline takes them from the PMT, so each is its
 *    elementary stream PID (ffmpeg writes 256 for the first stream of each
 *    rendition). The ADTS pipeline sets none, so tkhd, trex and tfhd carry 0.
 *    joinInits renumbers the audio side either way.
 *  - The init is ftyp (isom, avc1) and a moov with mvhd (timescale 90000,
 *    duration and next_track_ID 0xffffffff), one trak (tkhd and mdhd duration
 *    0xffffffff, mdhd timescale 90000 for video or the sample rate for audio,
 *    no edts) and an mvex with one trex and no mehd.
 *  - Fragments: mfhd, one traf with tfhd flags 0x3a (no base_data_offset, no
 *    default-base-is-moof, so the base is the moof), a version 1 tfdt and a
 *    trun whose data offset counts from the moof. Video adds sdtp and carries
 *    composition offsets for B frames.
 *  - mux.js builds a fresh init on every flush. For one rendition the bytes
 *    stay the same, so `init` comes back once.
 *
 * @param durationSec total playlist duration written into the init's mvhd,
 * tkhd and mdhd, which mux.js leaves as unknown; 0 leaves them for the caller.
 */
export function tsTrackProducer(track: Side, durationSec = 0): TsTrackProducer {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
  let lastInit: Uint8Array | null = null;
  let init: Uint8Array | null = null;
  let fragments: Uint8Array[] = [];
  let failure: Error | null = null;
  let pushed = false;
  transmuxer.on('data', (seg) => {
    if (seg.type === 'combined') failure ??= new Error('mux.js combined the tracks although remux is off');
    if (seg.type !== track) return;
    if (!lastInit || !sameBytes(lastInit, seg.initSegment)) {
      lastInit = seg.initSegment;
      init = patchDurations(seg.initSegment, durationSec);
    }
    fragments.push(seg.data);
  });
  const take = (): TrackOutput => {
    const out = { init, fragments };
    init = null;
    fragments = [];
    if (failure) throw failure;
    return out;
  };
  return {
    async push(segment) {
      pushed = true;
      transmuxer.push(segment);
      transmuxer.flush();
      return take();
    },
    async flush() {
      // mux.js builds its pipeline on the first push and throws on a flush before it.
      if (pushed) transmuxer.flush();
      return take();
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
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

/** An MP4 box: an 8 byte header followed by the children (or a raw payload) in order. */
export function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(children.reduce((n, c) => n + c.byteLength, 8));
  view(out).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const c of children) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface JoinedInit {
  /** The video's ftyp and a moov holding every video track and then the audio track. */
  init: Uint8Array;
  /** The audio track's id in `init`, one more than the highest video id. Audio fragments must carry it. */
  audioTrackId: number;
  videoTrackIds: number[];
}

/**
 * One init segment for a video stream and an audio stream: the video's ftyp,
 * then a moov with the video's mvhd, every video trak, the audio trak, an mvex
 * with the video's mehd and the trex entries of both, and the video's udta.
 * Both inputs usually call their track 1 (a mux.js audio init calls it 0), so
 * the audio track takes the next free id. Its tkhd duration and edit list are
 * in the movie timescale, which differs between inits (ffmpeg writes 1000,
 * mux.js 90000), so they are converted to the video's.
 */
export function joinInits(video: Uint8Array, audio: Uint8Array): JoinedInit {
  const vMoov = child(video, 0, video.byteLength, 'moov');
  const aMoov = child(audio, 0, audio.byteLength, 'moov');
  if (!vMoov) throw new Error('The video init segment has no moov box');
  if (!aMoov) throw new Error('The audio init segment has no moov box');
  const vMvhd = child(video, vMoov.body, vMoov.end, 'mvhd');
  const aMvhd = child(audio, aMoov.body, aMoov.end, 'mvhd');
  const vTraks = [...boxes(video, vMoov.body, vMoov.end, 'trak')];
  const aTrak = child(audio, aMoov.body, aMoov.end, 'trak');
  if (!vMvhd || !vTraks.length) throw new Error('The video init segment has no track');
  if (!aMvhd || !aTrak) throw new Error('The audio init segment has no track');

  const videoTrackIds = vTraks.map((t) => trackId(video, t));
  const audioTrackId = Math.max(...videoTrackIds) + 1;
  const sourceId = trackId(audio, aTrak);

  // next_track_ID is the last field of mvhd in both versions.
  const mvhd = video.slice(vMvhd.start, vMvhd.end);
  view(mvhd).setUint32(mvhd.byteLength - 4, audioTrackId + 1);

  const trak = audioTrak(audio, aTrak, audioTrackId, movieTimescale(audio, aMvhd), movieTimescale(video, vMvhd));

  const vMvex = child(video, vMoov.body, vMoov.end, 'mvex');
  const mvex: Uint8Array[] = vMvex
    ? [...boxes(video, vMvex.body, vMvex.end)].filter((b) => b.type === 'mehd' || b.type === 'trex').map((b) => video.slice(b.start, b.end))
    : [];
  mvex.push(audioTrex(audio, aMoov, sourceId, audioTrackId));

  const udta = child(video, vMoov.body, vMoov.end, 'udta');
  const moov = box('moov', mvhd, ...vTraks.map((t) => video.slice(t.start, t.end)), trak, box('mvex', ...mvex), ...(udta ? [video.slice(udta.start, udta.end)] : []));
  const ftyp = child(video, 0, video.byteLength, 'ftyp');
  return { init: ftyp ? concat(video.subarray(ftyp.start, ftyp.end), moov) : moov, audioTrackId, videoTrackIds };
}

function child(data: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const b of boxes(data, start, end, type)) return b;
  return null;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The track id in a trak's tkhd, 0 when it has none. */
function trackId(data: Uint8Array, trak: Box): number {
  const tkhd = child(data, trak.body, trak.end, 'tkhd');
  return tkhd ? view(data).getUint32(tkhd.body + (data[tkhd.body] === 1 ? 20 : 12)) : 0;
}

function movieTimescale(data: Uint8Array, mvhd: Box): number {
  return view(data).getUint32(mvhd.body + (data[mvhd.body] === 1 ? 20 : 12));
}

/** `value` in timescale `from` converted to timescale `to`, rounded. */
function rescale(value: bigint, from: number, to: number): bigint {
  if (!(from > 0) || !(to > 0) || from === to) return value;
  return (value * BigInt(to) + BigInt(from) / 2n) / BigInt(from);
}

/** A copy of the audio trak with track id `id` and its movie timescale fields converted from `from` to `to`. */
function audioTrak(data: Uint8Array, trak: Box, id: number, from: number, to: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const b of boxes(data, trak.body, trak.end)) {
    if (b.type === 'tkhd') parts.push(audioTkhd(data, b, id, from, to));
    else if (b.type === 'edts') parts.push(box('edts', ...[...boxes(data, b.body, b.end)].map((e) => (e.type === 'elst' ? rescaleElst(data, e, from, to) : data.slice(e.start, e.end)))));
    else parts.push(data.slice(b.start, b.end));
  }
  return box('trak', ...parts);
}

function audioTkhd(data: Uint8Array, tkhd: Box, id: number, from: number, to: number): Uint8Array {
  const out = data.slice(tkhd.start, tkhd.end);
  const dv = view(out);
  const body = tkhd.body - tkhd.start;
  const v1 = out[body] === 1;
  dv.setUint32(body + (v1 ? 20 : 12), id);
  // All ones means unknown. A version 0 duration that no longer fits becomes
  // unknown too; patchDurations writes the real one afterwards.
  const at = body + (v1 ? 28 : 20);
  if (v1) {
    const duration = dv.getBigUint64(at);
    if (duration !== 0xffffffffffffffffn) dv.setBigUint64(at, rescale(duration, from, to));
  } else {
    const duration = dv.getUint32(at);
    if (duration !== 0xffffffff) dv.setUint32(at, Number(bigMin(rescale(BigInt(duration), from, to), 0xffffffffn)));
  }
  return out;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The elst with every segment_duration converted from `from` to `to`.
 * media_time is in the track's own timescale and stays. A version 0 box whose
 * durations no longer fit in 32 bits is written as version 1.
 */
function rescaleElst(data: Uint8Array, elst: Box, from: number, to: number): Uint8Array {
  const dv = view(data);
  const v1 = data[elst.body] === 1;
  const flags = dv.getUint32(elst.body) & 0xffffff;
  const size = v1 ? 20 : 12;
  const count = dv.getUint32(elst.body + 4);
  const entries: { duration: bigint; mediaTime: bigint; rate: number }[] = [];
  for (let i = 0, at = elst.body + 8; i < count && at + size <= elst.end; i++, at += size) {
    entries.push({
      duration: rescale(v1 ? dv.getBigUint64(at) : BigInt(dv.getUint32(at)), from, to),
      mediaTime: v1 ? dv.getBigInt64(at + 8) : BigInt(dv.getInt32(at + 4)),
      rate: dv.getUint32(at + size - 4),
    });
  }
  const wide = v1 || entries.some((e) => e.duration > 0xffffffffn);
  const entrySize = wide ? 20 : 12;
  const body = new Uint8Array(8 + entries.length * entrySize);
  const out = view(body);
  out.setUint32(0, (wide ? 0x01000000 : 0) | flags);
  out.setUint32(4, entries.length);
  entries.forEach((e, i) => {
    const at = 8 + i * entrySize;
    if (wide) {
      out.setBigUint64(at, e.duration);
      out.setBigInt64(at + 8, e.mediaTime);
    } else {
      out.setUint32(at, Number(e.duration));
      out.setInt32(at + 4, Number(e.mediaTime));
    }
    out.setUint32(at + entrySize - 4, e.rate);
  });
  return box('elst', body);
}

/** The audio init's trex for its track (or a default one if it has none), renumbered to `id`. */
function audioTrex(data: Uint8Array, moov: Box, sourceId: number, id: number): Uint8Array {
  const mvex = child(data, moov.body, moov.end, 'mvex');
  const all = mvex ? [...boxes(data, mvex.body, mvex.end, 'trex')] : [];
  const found = all.find((t) => view(data).getUint32(t.body + 4) === sourceId) ?? all[0];
  // trex body: version and flags, track_ID, then the sample defaults (description index 1).
  const fallback = new Uint8Array(24);
  fallback[11] = 1;
  const out = found ? data.slice(found.start, found.end) : box('trex', fallback);
  view(out).setUint32((found ? found.body - found.start : 8) + 4, id);
  return out;
}

/** Set the track id of every traf in `fragment` in place and return it. */
export function renumberTrack(fragment: Uint8Array, trackId: number): Uint8Array {
  const dv = view(fragment);
  for (const moof of boxes(fragment, 0, fragment.byteLength, 'moof')) {
    for (const traf of boxes(fragment, moof.body, moof.end, 'traf')) {
      for (const tfhd of boxes(fragment, traf.body, traf.end, 'tfhd')) dv.setUint32(tfhd.body + 4, trackId);
    }
  }
  return fragment;
}

/**
 * Prepare `fragment` for its place in a merged file, where it starts at byte
 * `offset`: number its moofs from `sequence` up, and point an explicit
 * base_data_offset (tfhd flag 0x1) at its moof's position in the output. Both
 * streams number their fragments from 1, and an explicit base_data_offset is a
 * position in the source file. An encoder that writes one (ffmpeg without
 * default_base_moof) points it at the moof. Rewrites in place and returns the
 * next sequence number.
 */
export function placeFragment(fragment: Uint8Array, sequence: number, offset: number): number {
  const dv = view(fragment);
  for (const moof of boxes(fragment, 0, fragment.byteLength, 'moof')) {
    for (const mfhd of boxes(fragment, moof.body, moof.end, 'mfhd')) dv.setUint32(mfhd.body + 4, sequence >>> 0);
    sequence++;
    for (const traf of boxes(fragment, moof.body, moof.end, 'traf')) {
      for (const tfhd of boxes(fragment, traf.body, traf.end, 'tfhd')) {
        if (dv.getUint32(tfhd.body) & 0x1 && tfhd.body + 16 <= tfhd.end) dv.setBigUint64(tfhd.body + 8, BigInt(offset + moof.start));
      }
    }
  }
  return sequence;
}

/** The first tfdt in `fragment` in seconds of `timescale`, or null when it has none. */
export function startOf(fragment: Uint8Array, timescale: number): number | null {
  const dv = view(fragment);
  for (const moof of boxes(fragment, 0, fragment.byteLength, 'moof')) {
    for (const traf of boxes(fragment, moof.body, moof.end, 'traf')) {
      for (const tfdt of boxes(fragment, traf.body, traf.end, 'tfdt')) {
        const time = fragment[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
        return time / timescale;
      }
    }
  }
  return null;
}

export type Side = 'video' | 'audio';

/**
 * Sink that joins a video stream and an audio stream, each fragmented MP4 with
 * an init of its own, into one file: the joined init (see joinInits), then the
 * fragments of both as they are pushed. The caller orders fragments by
 * playlist time; the sink neither buffers nor reorders.
 */
export interface MergeSink {
  /** Both inits, before any fragment. Builds and writes the joined init once. */
  setInits(video: Uint8Array, audio: Uint8Array): Promise<void>;
  /** A fragment's first decode time in seconds, read with its side's timescale. Null before setInits or without a tfdt. */
  startOf(side: Side, fragment: Uint8Array): number | null;
  /**
   * Pin the stream time, in seconds, that becomes 0 for both tracks. Call once
   * after setInits and before the first push, with the earlier of the two
   * first fragments' startOf.
   */
  anchor(startSec: number): void;
  push(side: Side, fragment: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  /** The joined init written at offset 0, or null before setInits. */
  readonly firstInit: Uint8Array | null;
}

/**
 * @param durationSec total duration for the joined init's headers; 0 when not
 * known yet, and the caller patches the init at the end.
 */
export function mergeSink(write: Write, durationSec: number): MergeSink {
  const timeline = new Timeline();
  let joined: JoinedInit | null = null;
  let firstInit: Uint8Array | null = null;
  const timescales: Record<Side, number> = { video: 0, audio: 0 };
  let written = 0;
  let sequence = 1;
  return {
    async setInits(video, audio) {
      if (joined) throw new Error('The merge already has its init segments');
      joined = joinInits(video, audio);
      timeline.learn(joined.init);
      const learned = trackTimescales(joined.init);
      timescales.video = learned.get(joined.videoTrackIds[0]!) ?? 0;
      timescales.audio = learned.get(joined.audioTrackId) ?? 0;
      firstInit = patchDurations(timeline.fixInit(joined.init), durationSec);
      await write(firstInit);
      written += firstInit.byteLength;
    },
    startOf(side, fragment) {
      return timescales[side] ? startOf(fragment, timescales[side]) : null;
    },
    anchor(startSec) {
      timeline.anchor(startSec);
    },
    async push(side, fragment) {
      if (!joined) throw new Error('The merge needs both init segments before the first fragment');
      if (side === 'audio') renumberTrack(fragment, joined.audioTrackId);
      sequence = placeFragment(fragment, sequence, written);
      const data = timeline.rebase(fragment);
      await write(data);
      written += data.byteLength;
    },
    async flush() {},
    get firstInit() {
      return firstInit;
    },
  };
}
